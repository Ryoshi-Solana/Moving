"""
bot.py
Bot Telegram untuk alert token trending Solana.

Command untuk semua orang:
  /start         - perkenalan
  /subscribe     - daftar terima alert lewat DM (opsional, selain channel)
  /unsubscribe   - berhenti terima alert DM
  /trending      - cek manual token trending sekarang
  /promote <addr>- ajukan token untuk dipromosikan (bayar SOL, terverifikasi otomatis)

Command khusus admin:
  /pending          - lihat daftar promosi yang masih menunggu pembayaran
  /reject <id>      - batalkan promosi yang belum dibayar
  /health           - lihat status tiap job otomatis (kapan terakhir jalan, ada error atau tidak)
  /setcriteria      - lihat semua kriteria yang bisa diubah live
  /setcriteria <key> <value> - ubah 1 kriteria tanpa perlu edit kode / restart bot

Alur otomatis (tanpa perlu kamu pegang HP):
  - Trending organik, fresh-graduate, & pre-graduation: dicek berkala, posting
    otomatis ke CHANNEL_ID kalau lolos kriteria (termasuk cek rug-safety dasar)
  - Pembayaran promosi: dicek berkala, auto-posting kalau ada yang cocok
  - Milestone kenaikan & rekap "Hall of Fame": dicek & di-update berkala

Cara pakai:
  1. isi BOT_TOKEN, ADMIN_CHAT_ID, CHANNEL_ID, ADMIN_WALLET_ADDRESS di bawah
     (atau lewat environment variable)
  2. tambahkan bot sebagai admin di channel Telegram kamu (izin "Post Messages")
  3. pip install -r requirements.txt
  4. python bot.py
"""

import logging
import traceback
import html
import os
import asyncio
import json
import sqlite3
from datetime import datetime, timezone, timedelta
from apscheduler.triggers.cron import CronTrigger

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.constants import ParseMode
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    ConversationHandler,
    CallbackQueryHandler,
    MessageHandler,
    filters,
)
from apscheduler.schedulers.asyncio import AsyncIOScheduler
import time
import random

import database as db
import trending
import pnl_card
import payments
import safety
import autopsy_engine as ae
import intelligence_v2 as iv2

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# --- KONFIGURASI: isi di sini atau lewat environment variable ---
BOT_TOKEN = os.environ.get("BOT_TOKEN", "GANTI_DENGAN_TOKEN_DARI_BOTFATHER")
ADMIN_CHAT_ID = int(os.environ.get("ADMIN_CHAT_ID", "0"))  # chat_id kamu sendiri

# ID atau @username channel Telegram tempat bot posting otomatis.
# Bot HARUS sudah jadi admin channel ini dengan izin "Post Messages".
CHANNEL_ID = os.environ.get("CHANNEL_ID", "@ganti_dengan_username_channel")

# Wallet Solana kamu sendiri, tempat menerima pembayaran promosi
ADMIN_WALLET_ADDRESS = os.environ.get("ADMIN_WALLET_ADDRESS", "GANTI_DENGAN_ALAMAT_WALLET_SOLANA")

BASE_PROMOTION_PRICE_SOL = 0.1  # harga dasar slot promosi, silakan diubah

# --- Interval job otomatis ---
# NOTE: angka di bawah ini sengaja dipercepat untuk TESTING (biar cepat lihat
# hasilnya). Kalau channel sudah live ke publik, naikkan lagi supaya tidak
# kena rate limit API gratis dan tidak flood channel — saran production:
# CHECK_INTERVAL_SECONDS=300, CHECK_FRESH=180, CHECK_MILESTONE=300, CHECK_RISKY=180
CHECK_INTERVAL_SECONDS = 60         # cek token trending organik
CHECK_PAYMENT_INTERVAL_SECONDS = 60   # cek pembayaran masuk
CHECK_FRESH_INTERVAL_SECONDS = 60     # cek pool baru graduate
CHECK_DEX_ACTIVITY_INTERVAL_SECONDS = 60  # cek boost/profile update terbaru di DexScreener
CHECK_MILESTONE_INTERVAL_SECONDS = 60  # cek kenaikan token yang sudah dialert
# Intelligent Alert V1 (shadow) -- kondisi ke-6 POST-ALERT, tidak perlu
# secepat milestone check (populasi per siklus kecil, cuma token yang
# baru lewat window 60-menit). 5 menit cukup sering buat menangkap token
# sebelum keluar dari jendela pending (60-180 menit).
INTELLIGENCE_V1_POST_ALERT_JOB_INTERVAL_SECONDS = 300
CHECK_RISKY_INTERVAL_SECONDS = 90     # cek kandidat pre-graduation (endpoint tidak resmi, agak lebih pelan)
HALL_OF_FAME_MIN_INTERVAL_HOURS = 6     # Hall of Fame di-post ulang tiap 6 jam sekali (bukan 3 jam lagi)
RECAP_MIN_MULTIPLIER = 1.5              # ambang masuk "Hall of Fame"

# --- Tracking status tiap job, buat command /health ---
JOB_STATUS = {}


def _mark_job_run(name: str, error: str = None, duration_seconds: float = None):
    """
    DIAGNOSTIK (laporan user: token EBC yang pump-lalu-mati CEPAT tidak
    pernah dapat update milestone sama sekali, walau sudah dibenerin
    urutan antrian-nya). Dugaan: siklus check_risky_job ASLINYA jauh
    lebih lambat dari 90 detik nominal (banyak RPC berurutan per kandidat
    baru -- holder distribution, deployer history, dst), sehingga token
    yang pump-lalu-mati dalam hitungan menit bisa SELESAI CERITANYA
    sebelum siklus berikutnya BENERAN mulai. `duration_seconds` (opsional,
    diisi caller yang mengukur waktu eksekusinya sendiri) menyimpan bukti
    LANGSUNG durasi asli tiap siklus, ditampilkan di /health -- daripada
    terus menduga-duga.
    """
    JOB_STATUS[name] = {
        "last_run": datetime.now(timezone.utc),
        "last_error": error,
        "duration_seconds": duration_seconds,
    }


# --- Kriteria yang bisa diubah live lewat /setcriteria, tanpa restart bot ---
# key pendek -> (nama_attribute_di_trending.py, tipe_data)
CRITERIA_MAP = {
    "min_liquidity": ("MIN_LIQUIDITY_USD", float),
    "momentum_min_volume": ("MOMENTUM_MIN_M5_VOLUME_USD", float),
    "momentum_spike_multiplier": ("MOMENTUM_SPIKE_MULTIPLIER", float),
    "fresh_max_age": ("FRESH_MAX_AGE_MINUTES", float),
    "fresh_min_liquidity": ("FRESH_MIN_LIQUIDITY_USD", float),
    "fresh_min_buyers": ("FRESH_MIN_BUYERS_H1", int),
    "fresh_min_activity": ("FRESH_MIN_M5_ACTIVITY_USD", float),
    "lp_lock_min_pct": ("LP_LOCK_MIN_PCT", float),
    "max_ath_multiplier": ("MAX_ATH_MULTIPLIER", float),
    "min_liquidity_mcap_ratio": ("MIN_LIQUIDITY_TO_MCAP_RATIO", float),
    "milestone_liquidity_mcap_ratio": ("MILESTONE_MIN_LIQUIDITY_TO_MCAP_RATIO", float),
    "deployer_history_page_size": ("DEPLOYER_HISTORY_PAGE_SIZE", int),
    "deployer_history_max_pages": ("DEPLOYER_HISTORY_MAX_PAGES", int),
    "max_deployer_token_count": ("MAX_DEPLOYER_TOKEN_COUNT", int),
    "max_recent_dump_pct": ("MAX_RECENT_DUMP_PCT", float),
    "max_ath_per_cycle_multiplier": ("MAX_ATH_PER_CYCLE_MULTIPLIER", float),
    "milestone_min_liquidity": ("MILESTONE_MIN_LIQUIDITY_USD", float),
    "pumpswap_min_age": ("PUMPSWAP_MIN_AGE_MINUTES", float),
    "new_pair_min_age": ("NEW_PAIR_MIN_AGE_MINUTES", float),
    "milestone_concurrency": ("MILESTONE_CONCURRENCY", int),
    "min_holder_count": ("MIN_HOLDER_COUNT", int),
    "max_non_pool_concentration": ("MAX_NON_POOL_HOLDER_CONCENTRATION_PCT", float),
    "risky_min_mcap": ("RISKY_MIN_MARKET_CAP_USD", float),
    "risky_max_mcap": ("RISKY_MAX_MARKET_CAP_USD", float),
    "risky_min_replies": ("RISKY_MIN_REPLY_COUNT", int),
    "risky_spike_rate": ("RISKY_SPIKE_MIN_PCT_PER_MINUTE", float),
}


def _load_persisted_criteria():
    """Dipanggil sekali saat startup, supaya perubahan lewat /setcriteria
    sebelumnya tetap kepakai walau bot di-restart."""
    for key, (attr, cast) in CRITERIA_MAP.items():
        stored = db.get_state(f"criteria:{key}")
        if stored is not None:
            try:
                setattr(trending, attr, cast(stored))
                logger.info(f"Loaded persisted criteria: {key} = {stored}")
            except ValueError:
                pass

    # Phase 10H -- restore juga versi SOL-equivalent (kalau admin pernah
    # migrasi risky_min_mcap/risky_max_mcap ke mekanisme baru).
    for key, lamports_attr in (
        ("risky_min_mcap", "RISKY_MIN_MARKET_CAP_SOL_LAMPORTS"),
        ("risky_max_mcap", "RISKY_MAX_MARKET_CAP_SOL_LAMPORTS"),
    ):
        stored_lamports = db.get_state(f"criteria:{key}_sol_lamports")
        if stored_lamports is not None:
            try:
                setattr(trending, lamports_attr, int(stored_lamports))
                logger.info(f"Loaded persisted SOL-equivalent criteria: {key} = {stored_lamports} lamports")
            except ValueError:
                pass


# ---------- Command handlers ----------

# --- States buat ConversationHandler alur /ads ---
ADS_CONFIRM_QUEUE, ADS_ASKING_TEXT, ADS_ASKING_LINK, ADS_ASKING_DURATION, PROMOTE_ASKING_ADDRESS = range(5)

MAX_AD_TEXT_LEN = 20
AD_DURATION_OPTIONS = {
    "12h": {"label": "12 hours", "hours": 12, "price_sol": 0.1},
    "24h": {"label": "24 hours", "hours": 24, "price_sol": 0.15},
}


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    /start biasa -> pesan selamat datang.
    /start ads (dari deep-link tombol "Put your ads here" di alert) ->
    langsung masuk alur pesan iklan, sama kayak ketik /ads manual.
    """
    if context.args and context.args[0] == "ads":
        return await ads_entry(update, context)

    channel_username = CHANNEL_ID.lstrip("@")
    await update.message.reply_text(
        "Hey! I'm SolRadar 🛰️\n\n"
        "📡 *Alerts*\n"
        f"Posted exclusively in the channel: https://t.me/{channel_username}\n"
        "Every call, the Hall of Fame, and the daily recap live there.\n\n"
        "📖 *Docs*\n"
        "How the filtering & tracking actually works: https://solradar.gitbook.io/docs/\n\n"
        "🐦 *Follow us*\n"
        "https://x.com/SolRadar\\_",
        parse_mode=ParseMode.MARKDOWN,
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton("💰 Promote your token", callback_data="menu_promote")],
            [InlineKeyboardButton("📢 Advertising", callback_data="menu_ads")],
        ]),
    )
    return ConversationHandler.END


async def _ads_ask_text(update: Update):
    await update.effective_message.reply_text(
        f"📢 *Place an ad on SolRadar alerts*\n\n"
        f"Step 1/3 — send the AD TEXT (max {MAX_AD_TEXT_LEN} characters — this is what people "
        f"will see and can click on every new alert).\n\n"
        f"Example: `Trade on Trojan bot`",
        parse_mode=ParseMode.MARKDOWN,
    )


async def ads_entry(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Entry point /ads -- baik dipanggil langsung, atau lewat deep-link /start ads."""
    active_ad = db.get_active_ad()
    if active_ad:
        await update.effective_message.reply_text(
            f"📢 There's another ad currently running, until *{active_ad['expires_at']} UTC*.\n\n"
            "If you order now, your ad will AUTOMATICALLY start showing once the current one "
            "ends — no need to order again later.\n\n"
            "Still want to continue?",
            parse_mode=ParseMode.MARKDOWN,
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton("✅ Yes, queue it up", callback_data="ads_confirm_yes"),
                InlineKeyboardButton("❌ Cancel", callback_data="ads_confirm_no"),
            ]]),
        )
        return ADS_CONFIRM_QUEUE

    await _ads_ask_text(update)
    return ADS_ASKING_TEXT


async def ads_confirm_queue_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    if query.data == "ads_confirm_no":
        await query.edit_message_text("Okay, cancelled.")
        return ConversationHandler.END
    await query.edit_message_text("Got it, let's continue 👍")
    await _ads_ask_text(update)
    return ADS_ASKING_TEXT


async def ads_receive_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text.strip()
    if not text:
        await update.message.reply_text("That was empty, please send it again.")
        return ADS_ASKING_TEXT
    if len(text) > MAX_AD_TEXT_LEN:
        await update.message.reply_text(
            f"Too long ({len(text)} characters). Max {MAX_AD_TEXT_LEN} characters, please try again."
        )
        return ADS_ASKING_TEXT

    context.user_data["ad_text"] = text
    await update.message.reply_text(
        "Step 2/3 — send the DESTINATION LINK (this opens when someone clicks your ad).\n\n"
        "Example: `https://t.me/yourchannel`",
        parse_mode=ParseMode.MARKDOWN,
    )
    return ADS_ASKING_LINK


async def ads_receive_link(update: Update, context: ContextTypes.DEFAULT_TYPE):
    link = update.message.text.strip()
    if not (link.startswith("http://") or link.startswith("https://")):
        await update.message.reply_text(
            "The link must start with http:// or https:// — please send it again."
        )
        return ADS_ASKING_LINK

    context.user_data["ad_link"] = link
    await update.message.reply_text(
        "Step 3/3 — choose how long it runs:",
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton(f"{opt['label']} ({opt['price_sol']} SOL)", callback_data=f"ads_duration_{key}")]
            for key, opt in AD_DURATION_OPTIONS.items()
        ]),
    )
    return ADS_ASKING_DURATION


async def ads_receive_duration(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    key = query.data.replace("ads_duration_", "")
    opt = AD_DURATION_OPTIONS.get(key)
    if not opt:
        await query.edit_message_text("Unrecognized option, please start over with /ads.")
        return ConversationHandler.END

    ad_text = context.user_data.get("ad_text")
    ad_link = context.user_data.get("ad_link")
    chat_id = update.effective_chat.id

    expected_amount = _generate_unique_payment_amount(opt["price_sol"])

    ad_id = db.add_ad_request(chat_id, ad_text, ad_link, opt["hours"], opt["price_sol"], expected_amount)

    safe_ad_text = trending.escape_markdown_legacy(ad_text)
    safe_ad_link = trending.escape_markdown_legacy(ad_link)
    await query.edit_message_text(
        f"Ad order #{ad_id} received ✅\n\n"
        f"Text: {safe_ad_text}\n"
        f"Link: {safe_ad_link}\n"
        f"Duration: {opt['label']}\n\n"
        f"💸 Send EXACTLY *{expected_amount} SOL* to:\n"
        f"`{ADMIN_WALLET_ADDRESS}`\n\n"
        f"⚠️ The amount must be EXACT so it can be detected automatically. "
        f"Once detected, your ad will go live — immediately, or automatically once the current "
        f"ad's slot frees up if one happens to be running.",
        parse_mode=ParseMode.MARKDOWN,
    )

    if ADMIN_CHAT_ID:
        await context.bot.send_message(
            ADMIN_CHAT_ID,
            f"📥 New ad request!\nID: {ad_id}\nText: {ad_text}\nLink: {ad_link}\n"
            f"Duration: {opt['label']}\nWaiting for payment of {expected_amount} SOL.",
        )

    return ConversationHandler.END


async def ads_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("Cancelled.")
    return ConversationHandler.END


async def conversation_interrupted_by_other_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Fallback penangkap-semua: kalau user lagi di tengah alur ads/promote,
    terus ngetik COMMAND LAIN apa pun (bukan cuma /start atau /cancel) --
    langsung hentikan alur lama ini di sini (return END), biar command
    barunya bisa diproses NORMAL sama handler-nya sendiri (nggak nyangkut).
    """
    return ConversationHandler.END


def _generate_unique_payment_amount(base_price: float) -> float:
    """
    Nominal unik buat matching pembayaran otomatis -- SEKARANG cuma
    nambah 2-3 digit angka acak (bukan 6 desimal kayak sebelumnya),
    biar nggak kepanjangan buat diketik user. Tetap dicek dulu supaya
    nggak bentrok sama nominal lain yang masih pending (promosi ATAU ads).
    """
    existing = {p["expected_amount_sol"] for p in db.get_unpaid_promotions()}
    existing |= {a["expected_amount_sol"] for a in db.get_unpaid_ads()}

    for _ in range(30):
        unique_num = random.randint(100, 999)  # selalu 3 digit: 100-999
        candidate = round(base_price + unique_num / 100_000, 5)
        if candidate not in existing:
            return candidate
    return round(base_price + random.randint(100, 999) / 100_000, 5)


async def _create_promotion_request(reply_target, chat_id: int, token_address: str, context: ContextTypes.DEFAULT_TYPE):
    """Dipakai bareng oleh /promote <address> DAN alur tombol 'Promote your token'."""
    expected_amount = _generate_unique_payment_amount(BASE_PROMOTION_PRICE_SOL)
    promo_id = db.add_promotion_request(token_address, chat_id, expected_amount)

    await reply_target.reply_text(
        f"Promotion request for `{token_address}` received (ID: {promo_id}).\n\n"
        f"💸 Send EXACTLY *{expected_amount} SOL* to:\n"
        f"`{ADMIN_WALLET_ADDRESS}`\n\n"
        f"⚠️ The amount must be EXACT so the bot can automatically detect your payment. "
        f"Once detected, your token will be posted to the channel within "
        f"{CHECK_PAYMENT_INTERVAL_SECONDS // 60} minutes.",
        parse_mode=ParseMode.MARKDOWN,
    )

    if ADMIN_CHAT_ID:
        await context.bot.send_message(
            ADMIN_CHAT_ID,
            f"📥 New promotion request!\n"
            f"ID: {promo_id}\n"
            f"Token: {token_address}\n"
            f"Waiting for payment of {expected_amount} SOL (will be auto-verified).",
        )


async def promote(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        await update.message.reply_text(
            "Usage: /promote <solana_token_address>\n"
            "Example: /promote 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
        )
        return ConversationHandler.END
    await _create_promotion_request(update.message, update.effective_chat.id, context.args[0], context)
    return ConversationHandler.END


async def menu_promote_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Dipicu tombol 'Promote your token' dari /start."""
    await update.callback_query.answer()
    await update.effective_message.reply_text(
        "💰 *Promote your token*\n\n"
        "Send me the Solana token address (mint) you'd like to promote.\n\n"
        "Example: `7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU`",
        parse_mode=ParseMode.MARKDOWN,
    )
    return PROMOTE_ASKING_ADDRESS


async def promote_receive_address(update: Update, context: ContextTypes.DEFAULT_TYPE):
    token_address = update.message.text.strip()
    await _create_promotion_request(update.message, update.effective_chat.id, token_address, context)
    return ConversationHandler.END


async def menu_ads_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Dipicu tombol 'Advertising' dari /start -- alur sama persis kayak /ads manual."""
    await update.callback_query.answer()
    return await ads_entry(update, context)


# ---------- Command khusus admin ----------

def _is_admin(update: Update) -> bool:
    return update.effective_chat.id == ADMIN_CHAT_ID


async def pending(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _is_admin(update):
        return
    promo_rows = db.get_pending_promotions()
    ad_rows = db.get_unpaid_ads()
    if not promo_rows and not ad_rows:
        await update.message.reply_text("No pending promotions or ads.")
        return
    lines = []
    if promo_rows:
        lines.append("📢 Promotions:")
        lines.extend(f"  ID {r['id']}: {r['token_address']} (expects {r['expected_amount_sol']} SOL)" for r in promo_rows)
    if ad_rows:
        lines.append("📰 Ads:")
        lines.extend(f"  ID {r['id']}: \"{r['ad_text']}\" (expects {r['expected_amount_sol']} SOL)" for r in ad_rows)
    await update.message.reply_text("\n".join(lines))


async def reject(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Admin can still manually reject a promotion before it's been paid."""
    if not _is_admin(update):
        return
    if not context.args:
        await update.message.reply_text("Usage: /reject <id>")
        return

    promo_id = int(context.args[0])
    row = db.set_promotion_status(promo_id, "rejected")
    if row:
        await update.message.reply_text(f"Promotion #{promo_id} rejected.")
    else:
        await update.message.reply_text("ID not found.")


async def approvepromo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Fallback MANUAL -- audit monetisasi menemukan: sebelum ini, kalau
    deteksi pembayaran otomatis gagal APA PUN sebabnya (RPC Solana
    bermasalah, nominal tidak persis cocok, dll), TIDAK ADA jalan keluar
    selain ubah database langsung. Command ini kasih jalan keluar resmi:
    admin yang SUDAH VERIFIKASI SENDIRI pembayarannya (mis. lewat
    Solscan manual) bisa langsung approve dari sini.

    Signature yang dicatat berupa placeholder "MANUAL-..." -- TIDAK
    PERNAH bisa collide dengan signature transaksi Solana asli (yang
    selalu base58, jauh lebih panjang & formatnya beda total) -- tetap
    tercatat di used_payment_signatures buat jejak audit yang jelas
    (approval manual TIDAK mungkin dianggap sama dgn deteksi otomatis).
    """
    if not _is_admin(update):
        return
    if not context.args:
        await update.message.reply_text("Usage: /approvepromo <id>")
        return
    try:
        promo_id = int(context.args[0])
    except ValueError:
        await update.message.reply_text("ID harus berupa angka.")
        return

    promo = next((p for p in db.get_unpaid_promotions() if p["id"] == promo_id), None)
    if not promo:
        await update.message.reply_text(f"Promotion #{promo_id} tidak ditemukan atau sudah diproses.")
        return

    signature = f"MANUAL-promo-{promo_id}-{int(time.time())}"
    await update.message.reply_text(f"⏳ Menyetujui promotion #{promo_id} secara manual...")
    success = await _finalize_paid_promotion(context.application, promo, signature, verified_by="manual")
    if success:
        await update.message.reply_text(f"✅ Promotion #{promo_id} approved manual & sudah diposting.")
    else:
        await update.message.reply_text(f"⚠️ Promotion #{promo_id} sudah ditandai dibayar, tapi gagal diposting -- cek log.")


async def approvead(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Fallback MANUAL buat ads -- sama persis rasionalnya dgn /approvepromo."""
    if not _is_admin(update):
        return
    if not context.args:
        await update.message.reply_text("Usage: /approvead <id>")
        return
    try:
        ad_id = int(context.args[0])
    except ValueError:
        await update.message.reply_text("ID harus berupa angka.")
        return

    ad = next((a for a in db.get_unpaid_ads() if a["id"] == ad_id), None)
    if not ad:
        await update.message.reply_text(f"Ad #{ad_id} tidak ditemukan atau sudah diproses.")
        return

    signature = f"MANUAL-ad-{ad_id}-{int(time.time())}"
    success = await _finalize_paid_ad(context.application, ad, signature, verified_by="manual")
    if success:
        await update.message.reply_text(f"✅ Ad #{ad_id} approved manual.")
    else:
        await update.message.reply_text(f"⚠️ Ad #{ad_id} tidak ditemukan saat finalisasi -- cek log.")


async def cmctest(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Command DEBUG khusus buat tahap eksplorasi CMC DEX API -- BUKAN
    fitur alert, cuma buat verifikasi manual apakah integrasinya jalan
    dan gimana bentuk data aslinya, sebelum diputuskan cara pakainya.
    """
    if not _is_admin(update):
        return

    await update.message.reply_text("Nyoba ambil DEX pairs Solana lewat /v4/dex/spot-pairs/latest...")
    result = await asyncio.to_thread(trending.cmc_get_solana_dex_pairs, "volume_24h", 10)
    await update.message.reply_text(f"Hasil (raw, buat dibaca manual):\n\n`{str(result)[:3500]}`", parse_mode=ParseMode.MARKDOWN)


async def checktoken(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Debug 1 token spesifik: bandingkan data live vs yang tersimpan di DB,
    dan kasih tau PERSIS kenapa token itu (belum) dapat update milestone.
    Pakai: /checktoken <contract_address>
    """
    if not _is_admin(update):
        return
    if not context.args:
        await update.message.reply_text("Pakai: /checktoken <contract_address>")
        return

    address = context.args[0].strip()
    lines = [f"🔍 *Debug token*\n`{address}`\n"]

    tracked = db.get_trackable_tokens()
    row = next((r for r in tracked if r["token_address"] == address), None)

    if not row:
        lines.append("⚠️ Token ini TIDAK ada di daftar yang ditrack (baseline_market_cap kosong/0, atau memang belum pernah dialert bot ini).")
    else:
        lines.append(
            f"📁 *Tersimpan di database:*\n"
            f"Baseline: ${row['baseline_market_cap']:,.0f}\n"
            f"ATH tersimpan: ${row['ath_market_cap']:,.0f}\n"
            f"Last milestone: {row['last_milestone']}x"
        )

    try:
        pair = await asyncio.to_thread(trending.get_pair_data, address)
    except Exception as e:
        pair = None
        lines.append(f"\n❌ Error pas fetch DexScreener: {e}")

    if not pair:
        lines.append(
            "\n❌ *DexScreener tidak punya data pair buat token ini sekarang* — "
            "kemungkinan besar masih di bonding curve pump.fun (belum ada pool DEX asli), "
            "atau alamatnya salah."
        )
        # BUGFIX DIAGNOSTIK (laporan user: milestone EBC kadang kelewat
        # meski masih di bonding curve) -- command ini SEBELUMNYA berhenti
        # di sini, bilang "wajar, tunggu graduate", TANPA PERNAH ngecek
        # jalur EBC-specific (Phase 10F, pump.fun per-token) yang
        # SEHARUSNYA jalan justru untuk kasus PERSIS ini. Sekarang lanjut
        # cek jalur itu, biar ketauan PERSIS di titik mana (kalau ada)
        # token ini kelewat.
        lines.append("\n🎲 *Cek jalur EBC-specific (Phase 10F, pump.fun per-token):*")

        active_ebc = db.get_active_ebc_tracked_tokens()
        active_addrs = [r["token_address"] for r in active_ebc]
        if address not in active_addrs:
            lines.append(
                "❌ Token ini TIDAK ADA di daftar aktif EBC (get_active_ebc_tracked_tokens) -- "
                "kemungkinan: belum pernah dialert sebagai EARLY_BONDING_CURVE, sudah lewat "
                "3 jam sejak alert, atau baseline_market_cap masih 0."
            )
        else:
            position = active_addrs.index(address)
            in_batch = position < trending.PUMPFUN_PER_TOKEN_POLL_MAX_BATCH
            lines.append(
                f"✅ Ada di daftar aktif EBC, posisi ke-{position + 1} dari {len(active_addrs)} "
                f"(batas {trending.PUMPFUN_PER_TOKEN_POLL_MAX_BATCH} per siklus) -- "
                f"{'MASUK batch siklus ini' if in_batch else '⚠️ DI LUAR batch, KELEWAT siklus ini'}."
            )

            try:
                pumpfun_data = await asyncio.to_thread(trending._fetch_pumpfun_coin_by_mint, address)
            except Exception as e:
                pumpfun_data = None
                lines.append(f"❌ Error fetch pump.fun langsung: {e}")

            if pumpfun_data is None:
                lines.append("❌ Fetch pump.fun langsung (endpoint per-token) GAGAL/kosong barusan -- kemungkinan endpoint sedang bermasalah/rate-limit.")
            elif pumpfun_data.get("complete"):
                lines.append("ℹ️ Pump.fun bilang token ini SUDAH graduate (complete=True) -- mulai sekarang tanggung jawab check_milestones_job (DexScreener), BUKAN jalur ini lagi.")
            else:
                try:
                    live_pair = trending._pumpfun_to_pair(pumpfun_data)
                    live_mc = live_pair.get("marketCap") or 0
                    row_for_ebc = next((r for r in active_ebc if r["token_address"] == address), None)
                    baseline_ebc = row_for_ebc["baseline_market_cap"] if row_for_ebc else 0
                    lines.append(f"✅ Fetch pump.fun BERHASIL barusan -- market cap live: ${live_mc:,.0f}")
                    if baseline_ebc > 0:
                        implied_ebc = live_mc / baseline_ebc
                        lines.append(f"Baseline EBC tersimpan: ${baseline_ebc:,.0f} -> implied multiple SAAT INI: {implied_ebc:.2f}x")
                        lines.append(
                            "(Ini nilai LANGSUNG dari fetch barusan, TIDAK melalui sanity-check "
                            "liquidity apa pun -- jalur EBC memang sengaja tidak punya itu.)"
                        )
                except Exception as e:
                    lines.append(f"❌ Data pump.fun berhasil diambil tapi gagal dikonversi: {e}")
    else:
        current_mc = pair.get("marketCap") or pair.get("fdv") or 0
        current_liquidity = (pair.get("liquidity") or {}).get("usd", 0) or 0
        lines.append(f"\n📊 *Data live sekarang (DexScreener):*\nMarket cap: ${current_mc:,.0f}\nLiquidity: ${current_liquidity:,.0f}")

        if current_mc <= 0:
            lines.append("\n❌ Market cap live 0/kosong — update ATH DI-SKIP cycle ini.")
        else:
            ratio_pct = (current_liquidity / current_mc) * 100
            lines.append(f"Rasio liquidity/mcap: {ratio_pct:.2f}% (minimal {trending.MILESTONE_MIN_LIQUIDITY_TO_MCAP_RATIO * 100:.1f}% buat pemantauan lanjutan)")

            if current_liquidity < trending.MILESTONE_MIN_LIQUIDITY_USD:
                lines.append(f"\n⚠️ *Liquidity di bawah floor* (${trending.MILESTONE_MIN_LIQUIDITY_USD}) → update ATH DI-SKIP cycle ini (dianggap kemungkinan rug/data tidak reliable).")
            elif ratio_pct < trending.MILESTONE_MIN_LIQUIDITY_TO_MCAP_RATIO * 100:
                lines.append("\n⚠️ *Rasio liquidity/mcap di bawah minimal* → update ATH DI-SKIP cycle ini.")
            else:
                lines.append("\n✅ Lolos sanity check liquidity — ATH akan ter-update normal di cycle berikutnya.")

            if row and row["baseline_market_cap"] > 0:
                implied = current_mc / row["baseline_market_cap"]
                lines.append(f"\nImplied multiple dari baseline: {implied:.2f}x")

    # Debug khusus buat fitur bundle/insider yang masih perlu diverifikasi
    # live -- nama field persis di response RugCheck belum 100% dipastikan
    # tanpa akses live, jadi ini bantu ngecek apakah tebakan field-nya benar.
    rugcheck_report = await asyncio.to_thread(trending._fetch_rugcheck_report, address)
    if rugcheck_report is None:
        lines.append("\n🔍 *Debug RugCheck:* gagal fetch report sama sekali.")
    else:
        bundle_info = trending.get_bundle_info(address, report=rugcheck_report)
        lines.append(
            f"\n🔍 *Debug RugCheck bundle/insider:*\n"
            f"insider_count: {bundle_info['insider_count']}\n"
            f"insider_pct: {bundle_info['insider_pct']}\n"
            f"(None berarti field yang dicoba nggak ketemu di response -- "
            f"berarti nama field tebakan saya salah, perlu saya sesuaikan)"
        )

    await update.message.reply_text("\n".join(lines), parse_mode=ParseMode.MARKDOWN)


async def holderdiag(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    TEMPORARY (Phase 4C) -- nunjukkin counter diagnostic jalur RPC
    holder-distribution: berapa yang sukses, gagal, timeout, rate-limited,
    hasil kosong, dan korelasi sama umur token yang masih sangat baru.
    In-memory doang (reset kalau bot restart) -- rencana dicabut lagi
    setelah root cause NULL holder-data kekonfirmasi.
    """
    if not _is_admin(update):
        return
    d = safety.get_holder_rpc_diagnostics_snapshot()
    total_rpc = d["rpc_success"] + d["rpc_none_or_failure"]
    rpc_success_rate = (d["rpc_success"] / total_rpc * 100) if total_rpc else None
    calc_attempts = d["calculation_success"] + d["empty_holder_result"]
    calc_success_rate = (d["calculation_success"] / calc_attempts * 100) if calc_attempts else None
    fresh_fail_rate = (
        (d["fresh_token_failures"] / d["fresh_token_checks"] * 100) if d["fresh_token_checks"] else None
    )

    lines = [
        "🧪 Holder RPC Diagnostics (Phase 4C, temporary)",
        "",
        f"RPC calls total: {total_rpc}",
        f"  success: {d['rpc_success']}" + (f" ({rpc_success_rate:.1f}%)" if rpc_success_rate is not None else ""),
        f"  failed: {d['rpc_none_or_failure']}",
        f"    of which timeout: {d['rpc_timeout']}",
        f"    of which rate-limited (429): {d['rpc_rate_limited']}",
        "",
        f"Holder calculations attempted: {calc_attempts}",
        f"  succeeded: {d['calculation_success']}" + (f" ({calc_success_rate:.1f}%)" if calc_success_rate is not None else ""),
        f"  empty result: {d['empty_holder_result']}",
        "",
        f"Fresh tokens checked (age <= {safety.FRESH_TOKEN_THRESHOLD_MINUTES}min): {d['fresh_token_checks']}",
        f"  of which failed: {d['fresh_token_failures']}" + (f" ({fresh_fail_rate:.1f}%)" if fresh_fail_rate is not None else ""),
        "",
    ]

    # Phase 4G -- breakdown per METODE RPC, buat identifikasi PERSIS
    # metode mana yang paling sering kena 429.
    by_method = safety.get_holder_rpc_diagnostics_by_method()
    lines.append("📊 Breakdown per metode RPC (Phase 4G):")
    for method in safety.HOLDER_RPC_METHODS:
        m = by_method.get(method, {})
        total = m.get("total", 0)
        if total == 0:
            lines.append(f"  {method}: belum ada data")
            continue
        success_rate = m.get("success", 0) / total * 100
        lines.append(
            f"  {method}: total={total}, success={m.get('success', 0)} ({success_rate:.1f}%), "
            f"429={m.get('429', 0)}, timeout={m.get('timeout', 0)}, other_fail={m.get('generic_failure', 0)}"
        )

    stages = safety.get_holder_calc_stage_diagnostics()
    lines.append("")
    lines.append("🔍 Kalkulasi holder gagal di tahap mana (Phase 4G):")
    lines.append(f"  Tahap 1 (getTokenLargestAccounts): {stages.get('stage1_largest_accounts_failure', 0)}")
    lines.append(f"  Tahap 2 (getTokenSupply): {stages.get('stage2_token_supply_failure', 0)}")
    lines.append(
        f"  Tahap 3 (owner lookup individual, getAccountInfo): "
        f"{stages.get('stage3_owner_lookup_failure_count', 0)} kegagalan lookup "
        f"(catatan: 1 kalkulasi bisa punya sampai 5 lookup ini, gagal 1 TIDAK otomatis "
        f"gagalin kalkulasinya -- cuma bikin holder itu dianggap 'bukan pool' secara default)"
    )
    # Phase 4I -- diagnostic early-exit owner-lookup (Part C). Cuma
    # mengukur, TIDAK mengubah non_pool_concentration_pct/should_skip.
    early_exit = safety.get_early_exit_diagnostics()
    lines.append("")
    lines.append("⚡ Early-exit owner-lookup (Phase 4I):")
    lines.append(f"  Kalkulasi yang early-exit: {early_exit['calculations_early_exited']}")
    lines.append(f"  Owner-lookup RPC yang dihemat: {early_exit['lookups_saved']}")
    by_rank = early_exit["by_rank_where_2nd_real_wallet_found"]
    for rank in sorted(by_rank):
        lines.append(f"    early_exit_at_rank_{rank}: {by_rank[rank]}")

    lines.append("")
    lines.append("(Semua counter di atas in-memory since last restart, not persisted to DB.)")

    await update.message.reply_text("\n".join(lines))


async def srscore(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Admin diagnostic -- distribusi outcome per nilai SR Score v0 (Phase 4F)
    DAN v1 (Phase 6, shadow mode, terpisah total dari v0). Cuma buat lihat,
    TIDAK PERNAH dipakai buat filter alert.
    """
    if not _is_admin(update):
        return
    dist = db.get_sr_score_distribution()
    if not dist:
        await update.message.reply_text("Belum ada data autopsy-ready yang punya SR Score. Coba lagi nanti.")
        return

    lines = ["🎯 SR Score v0 -- Distribusi Outcome (Shadow Mode)", ""]
    for label in ["3", "2", "1", "0", "unscored"]:
        if label not in dist:
            continue
        b = dist[label]
        display_label = f"Score {label}" if label != "unscored" else "Unscored (data lama/input NULL)"
        lines.append(
            f"{display_label}: n={b['n']} (winner={b['winners']}, loser={b['losers']})\n"
            f"  1.5x={b['rate_1_5x_pct']}% | 2x={b['rate_2x_pct']}% | 3x={b['rate_3x_pct']}% | 5x={b['rate_5x_pct']}%"
        )
    lines.append("")
    lines.append("(SR Score v0 masih HIPOTESIS, belum tervalidasi kuat -- tidak dipakai buat filter alert apa pun.)")
    await update.message.reply_text("\n".join(lines))

    # ---- Phase 6: SR Score v1 (shadow mode, terpisah total dari v0) ----
    rows = db.get_autopsy_dataset()
    if len(rows) < 20:
        await update.message.reply_text(
            f"🆕 SR Score v1: dataset autopsy-ready cuma {len(rows)} baris -- "
            f"terlalu sedikit buat ditampilkan bermakna, tunggu data lebih banyak."
        )
        return
    v1 = ae.sr_score_v1_autopsy(rows)
    v1_lines = [
        "🆕 SR Score v1 -- Distribusi Outcome (Phase 6, Shadow Mode, TERPISAH dari v0)",
        "",
        f"Scored: {v1['scored_n']} | Unscored (histori/data lama): {v1['unscored_n']}",
    ]
    if v1["avg_confidence"] is not None:
        v1_lines.append(f"Rata-rata confidence: {v1['avg_confidence']:.1f}%")
    v1_lines.append("")
    for band in v1["bands"]:
        if band["n"] == 0:
            continue
        v1_lines.append(
            f"Band {band['label']}: n={band['n']} | winner_rate={_fmt_pct(band['winner_rate'])}\n"
            f"  1.5x={_fmt_pct(band['rate_1_5x'])} | 3x={_fmt_pct(band['rate_3x'])} | 5x={_fmt_pct(band['rate_5x'])}\n"
            f"  median time-to-2x: {_fmt_num(band['median_time_to_2x_minutes'])} min | "
            f"survival 1h: {_fmt_pct(band['survival_rate_1h'])} | "
            f"coverage: {_fmt_num(band['coverage']['pct_alerts_retained'])}%"
        )
    v1_lines.append("")
    v1_lines.append("Rata-rata kontribusi komponen:")
    for col, stats in v1["component_avg"].items():
        if stats["n"]:
            v1_lines.append(f"  {col}: {stats['avg']:.1f} (n={stats['n']})")
    v1_lines.append("")
    v1_lines.append("v1 masih SHADOW MODE MURNI -- tidak dipakai filter alert, belum dipromosikan ke mana pun. Cek /autopsy buat validasi temporal per band.")
    await _send_chunked(update, v1_lines)


async def outcomes(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Admin diagnostic for Outcome Engine v1 aggregate results."""
    if not _is_admin(update):
        return
    stats = db.get_outcome_stats()
    total = stats["total"]
    def pct(n):
        return f"{(n / total * 100):.1f}%" if total else "0.0%"
    lines = ["🧠 *Outcome Engine v1*", f"Tracked signals: {total}", ""]
    for key, label in (("1_5x", "1.5X"), ("2x", "2X"), ("3x", "3X"), ("5x", "5X"),
                       ("10x", "10X"), ("20x", "20X"), ("50x", "50X"), ("100x", "100X")):
        n = stats[key]
        lines.append(f"• {label}: {n} ({pct(n)})")
    await update.message.reply_text("\n".join(lines), parse_mode=ParseMode.MARKDOWN)


def _median(values):
    """Median sederhana -- SQLite nggak punya fungsi MEDIAN bawaan, jadi dihitung di Python."""
    vals = sorted(v for v in values if v is not None)
    n = len(vals)
    if n == 0:
        return None
    mid = n // 2
    return vals[mid] if n % 2 else (vals[mid - 1] + vals[mid]) / 2


# Fitur yang dianalisa Task 7 -- (nama kolom, label tampilan, format).
# Kolom boolean (mint/freeze/has_X) sengaja DIKELUARKAN dari sini karena
# median biner (0/1) nggak informatif; itu lebih pas ditampilkan sebagai
# rate (%), bukan median -- ditangani terpisah di bawah kalau perlu nanti.
AUTOPSY_FEATURES = [
    ("market_cap", "Market cap", "$"),
    ("liquidity", "Liquidity", "$"),
    ("volume_m5", "Volume 5m", "$"),
    ("volume_h1", "Volume 1h", "$"),
    ("holder_count", "Holder count", ""),
    ("top_holder_pct", "Top holder %", "%"),
    ("top10_holder_pct", "Top 10 holder %", "%"),
    ("non_pool_concentration_pct", "Non-pool concentration %", "%"),
    ("lp_locked_pct", "LP locked %", "%"),
    ("token_age_minutes", "Token age (min)", ""),
    ("bonding_curve_progress", "Bonding curve progress", "%"),
    ("social_replies", "Social replies", ""),
    ("deployer_token_count", "Deployer token count", ""),
    ("deployer_graduated_count", "Deployer graduated count", ""),
    ("insider_pct", "Insider/bundle %", "%"),
    ("smart_money_count", "Smart money count", ""),
    ("whale_count", "Whale count", ""),
    ("sniper_count", "Sniper count", ""),
    ("bot_count", "Bot count", ""),
]

MIN_SAMPLE_SIZE_FOR_DISPLAY = 5  # di bawah ini, jangan ditampilkan sebagai "menarik"


def _format_feature_value(value, fmt):
    if value is None:
        return "n/a"
    if fmt == "$":
        return f"${value:,.0f}"
    if fmt == "%":
        return f"{value:.1f}%"
    return f"{value:,.1f}" if isinstance(value, float) else str(value)


async def autopsy(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Task 6/7/8 -- bedah dataset signal yang PUNYA fitur lengkap (bukan
    cuma outcome mentah kayak /outcomes). Winner = capai 2x. Loser = TIDAK
    capai 2x TAPI udah diobservasi minimal 1 jam (bukan sekadar "belum
    sempat naik"). Cuma pakai sinyal organik yang di-observasi live
    (bukan promoted, bukan sisa seed lama) -- lihat get_autopsy_dataset().

    CATATAN PENTING (bug produksi yang diperbaiki): pesan di sini SENGAJA
    dikirim sebagai PLAIN TEXT (parse_mode=None), BUKAN Markdown. Isinya
    nyisipin signal_type MENTAH dari database (NEW_TRENDING, NEW_PAIR,
    EARLY_BONDING_CURVE) -- nama-nama itu punya underscore, karakter
    spesial di Markdown Telegram. Begitu campuran jenis sinyal yang
    muncul bikin TOTAL underscore di 1 pesan jadi ganjil, Telegram gagal
    parse ("can't find end of the entity") dan pesan GAGAL TERKIRIM SAMA
    SEKALI. Ini command diagnostic buat admin -- nggak butuh bold/italic,
    jadi plain text jauh lebih robust daripada coba escape satu-satu
    (yang gampang kelewat kalau ada signal_type baru ditambahin nanti).
    """
    if not _is_admin(update):
        return

    # Phase 10I -- argumen opsional /autopsy <YYYY-MM-DD> buat lihat SUBSET
    # data SETELAH tanggal itu saja (laporan user: khawatir histori lama,
    # sebelum bug pelacakan milestone EBC dibenerin Phase 10D/10F/10G/10H,
    # ikut mencemari validasi temporal walau discovery & validation set
    # sama-sama diambil dari histori yang sama-sama lama). TANPA argumen,
    # perilaku PERSIS seperti sebelumnya (semua histori, tidak ada yang
    # berubah diam-diam).
    since_date = None
    if context.args:
        candidate = context.args[0].strip()
        try:
            datetime.strptime(candidate, "%Y-%m-%d")
            since_date = candidate
        except ValueError:
            await update.message.reply_text(
                f"⚠️ Format tanggal tidak dikenali: `{candidate}`. Pakai format YYYY-MM-DD, "
                f"mis. `/autopsy 2026-09-22`. Menjalankan tanpa filter tanggal (semua histori).",
                parse_mode=ParseMode.MARKDOWN,
            )

    report = db.get_data_quality_report()
    rows = db.get_autopsy_dataset(since_date=since_date)

    # ---- Pesan 1: Data Quality Report (Task 8) ----
    dq_lines = ["🔬 Autopsy — Data Quality Report", ""]
    if since_date:
        dq_lines.append(
            f"🗓️ FILTER AKTIF: cuma sinyal sejak {since_date} (Feature Comparison, "
            f"SR Score, Criteria Optimization di bawah pakai subset INI, BUKAN semua histori). "
            f"Data Quality Report & Snapshot Coverage di bawah TETAP semua histori."
        )
        dq_lines.append("")
    dq_lines.append("Snapshot coverage:")
    for sig_type, count in report["snapshots_by_type"].items():
        dq_lines.append(f"• {sig_type}: {count}")
    dq_lines.append("")
    dq_lines.append(
        f"Organic alerts with valid baseline: {report['alerted_tokens_total']}\n"
        f"...with a captured snapshot: {report['alerted_with_snapshot']} "
        f"({report['snapshot_coverage_pct']}%)" if report['snapshot_coverage_pct'] is not None
        else f"Organic alerts with valid baseline: {report['alerted_tokens_total']}"
    )
    dq_lines.append(
        f"Snapshots matched to an outcome row: {report['snapshots_matched_to_outcome']}/"
        f"{report['snapshots_total']} ({report['snapshot_match_pct']}%)"
    )
    breakdown = report["outcome_breakdown"]
    dq_lines.append(
        f"Outcomes — seeded (historical, unreliable): {breakdown['seeded']} | "
        f"live-observed: {breakdown['live']}"
    )
    dq_lines.append(f"Promoted signals excluded from performance stats: {report['promoted_excluded']}")
    dq_lines.append("")
    dq_lines.append(f"✅ Autopsy-ready dataset size: {report['autopsy_ready_count']}")
    dq_lines.append("(organic + live-observed + sufficiently observed — see /autopsy definitions)")

    await update.message.reply_text("\n".join(dq_lines))

    # ---- Pesan 1b (Phase 5A, Part 9): Snapshot Coverage Telemetry ----
    telemetry = db.get_snapshot_telemetry()
    cov_lines = ["📸 SNAPSHOT COVERAGE (persisten, selamat dari restart)", ""]
    if not telemetry:
        cov_lines.append("(Belum ada data telemetry -- akan mulai terisi begitu deploy ini live.)")
    else:
        total_seen = sum(t["alerts_seen"] for t in telemetry)
        total_success = sum(t["snapshot_successes"] for t in telemetry)
        # Phase 9 -- clamp defense-in-depth: rasio TIDAK PERNAH BOLEH > 100%
        # secara tampilan, apa pun penyebabnya (root cause di call-order
        # record_snapshot_alert_seen() vs _capture_signal_snapshot() SUDAH
        # diperbaiki di 4 job masing-masing -- ini cuma jaring pengaman
        # KEDUA di layer laporan, kalau-kalau ada skenario lain di masa
        # depan yang bikin counter-nya kembali tidak sinkron).
        overall_pct = min(100.0, total_success / total_seen * 100) if total_seen else None
        cov_lines.append(
            f"Overall: {total_success}/{total_seen} alert dapat snapshot "
            f"({overall_pct:.1f}%)" if overall_pct is not None else "Overall: belum ada alert tercatat."
        )
        cov_lines.append("")
        for t in telemetry:
            seen = t["alerts_seen"]
            pct = min(100.0, t["snapshot_successes"] / seen * 100) if seen else None
            cov_lines.append(
                f"• {t['signal_type']}: {t['snapshot_successes']}/{seen} alert "
                f"({pct:.1f}%)" if pct is not None else f"• {t['signal_type']}: {t['snapshot_successes']}/{seen} alert"
            )
            if t["snapshot_failures"]:
                reasons = []
                for label, col in (
                    ("missing_market_data", "fail_missing_market_data"), ("rpc", "fail_rpc"),
                    ("api", "fail_api"), ("exception", "fail_exception"),
                    ("database", "fail_database"), ("source_unavailable", "fail_source_unavailable"),
                    ("unknown", "fail_unknown"),
                ):
                    if t[col]:
                        reasons.append(f"{label}={t[col]}")
                cov_lines.append(f"    failures: {t['snapshot_failures']} ({', '.join(reasons)})")
    await _send_chunked(update, cov_lines)

    n_total = len(rows)
    if n_total == 0:
        await update.message.reply_text(
            "⚠️ No autopsy-ready records yet. Nothing to analyze — this is expected "
            "while the dataset is still small. Re-run this once more organic alerts "
            "have accumulated enough observation time."
        )
        return

    # ---- Pesan 2: Dataset & Performance (Task 6) ----
    winners = [r for r in rows if r["reached_2x"]]
    losers = [r for r in rows if not r["reached_2x"]]
    perf_lines = ["📊 Dataset & Performance", ""]
    perf_lines.append(f"Total autopsy-ready signals: {n_total}")
    perf_lines.append(f"Winners (reached 2X): {len(winners)}")
    perf_lines.append(f"Losers (did not reach 2X, observed 1h+): {len(losers)}")
    perf_lines.append("")
    for key, label in (("reached_1_5x", "1.5X"), ("reached_2x", "2X"), ("reached_3x", "3X"),
                       ("reached_5x", "5X"), ("reached_10x", "10X")):
        n_hit = sum(1 for r in rows if r[key])
        rate = (n_hit / n_total * 100) if n_total else 0
        perf_lines.append(f"• {label} rate: {n_hit}/{n_total} ({rate:.1f}%)")

    if n_total < 30:
        perf_lines.append("")
        perf_lines.append(
            f"⚠️ Sample size is small ({n_total}). Treat these rates as directional "
            f"only, not statistically reliable yet."
        )

    await update.message.reply_text("\n".join(perf_lines))

    # ---- Pesan 3+: Feature comparison, winner vs loser (Task 7) ----
    feat_lines = ["🧬 Feature Comparison — Winners vs Losers", ""]
    if len(winners) < MIN_SAMPLE_SIZE_FOR_DISPLAY or len(losers) < MIN_SAMPLE_SIZE_FOR_DISPLAY:
        feat_lines.append(
            f"⚠️ Winner group ({len(winners)}) or loser group ({len(losers)}) is below "
            f"the minimum sample size ({MIN_SAMPLE_SIZE_FOR_DISPLAY}) for a fair comparison. "
            f"Showing raw numbers below, but DO NOT treat any of this as a real pattern yet."
        )
    feat_lines.append("")

    for col, label, fmt in AUTOPSY_FEATURES:
        winner_vals = [r[col] for r in winners]
        loser_vals = [r[col] for r in losers]
        w_missing = sum(1 for v in winner_vals if v is None)
        l_missing = sum(1 for v in loser_vals if v is None)
        w_n = len(winner_vals) - w_missing
        l_n = len(loser_vals) - l_missing
        if w_n == 0 and l_n == 0:
            continue  # kolom ini kosong total di dataset kita sekarang, skip biar nggak berisik
        w_med = _median(winner_vals)
        l_med = _median(loser_vals)
        missing_rate = (w_missing + l_missing) / max(1, len(winner_vals) + len(loser_vals)) * 100
        feat_lines.append(
            f"{label}\n"
            f"  Winner median: {_format_feature_value(w_med, fmt)} (n={w_n})\n"
            f"  Loser median: {_format_feature_value(l_med, fmt)} (n={l_n})\n"
            f"  Missing: {missing_rate:.0f}%"
        )

    # Kirim per-batch biar nggak kena limit 4096 karakter Telegram
    await _send_chunked(update, feat_lines)

    # ---- Phase 5: Autopsy Engine (Top Factors, Combinations, Temporal
    # Validation, SR Score v0 lengkap, Coverage, Data Gaps, kandidat
    # SR Score v1). Semua READ-ONLY -- tidak mengubah alert criteria,
    # SR Score v0, atau apa pun di jalur alert. ----
    await _send_phase5_autopsy_sections(update, rows)


async def _send_chunked(update: Update, lines: list, limit: int = 3500):
    """Kirim daftar baris teks sebagai beberapa pesan Telegram PLAIN TEXT
    (parse_mode=None) -- hindari limit 4096 karakter Telegram DAN bug
    parsing Markdown (signal_type mentah/nama fitur bisa ada underscore,
    lihat catatan panjang di docstring autopsy())."""
    chunk = []
    chunk_len = 0
    for line in lines:
        if chunk_len + len(line) > limit:
            if chunk:
                await update.message.reply_text("\n".join(chunk))
            chunk = []
            chunk_len = 0
        chunk.append(line)
        chunk_len += len(line) + 1
    if chunk:
        await update.message.reply_text("\n".join(chunk))


def _fmt_pct(value, decimals=1):
    return f"{value * 100:.{decimals}f}%" if value is not None else "n/a"


def _fmt_num(value, decimals=1):
    if value is None:
        return "n/a"
    return f"{value:,.{decimals}f}"


def _get_live_criteria_values():
    """
    Phase 7 (Part B) -- baca nilai /setcriteria yang SEDANG BERLAKU saat
    ini dari trending.py (module attribute), buat dijadikan titik acuan
    "current" di analisis Criteria Optimization. SENGAJA baca live value
    (bukan median populasi) supaya kandidat "+25%/+50%/+100%" itu relatif
    ke gate yang BENERAN dipakai sekarang -- lihat catatan panjang di
    autopsy_engine.criteria_candidate_report soal kenapa ini penting.

    Read-only murni -- fungsi ini tidak pernah menulis apa pun.
    """
    values = {}
    for spec in ae.CRITERIA_GATE_SPECS:
        values[spec["key"]] = getattr(trending, spec["attr"], None)
    return values


async def _send_phase5_autopsy_sections(update: Update, rows: list):
    """
    Phase 5 -- bagian 3, 6, 7, 8(lengkap), 9, 10, 11 dari brief
    (TOP SIGNAL FACTORS, COMBINATION PATTERNS, TEMPORAL VALIDATION,
    SR SCORE v0, COVERAGE/TRADE-OFF, DATA GAPS, SR SCORE v1 CANDIDATES).

    Semua angka dihitung lewat autopsy_engine.py (modul murni, tidak
    menyentuh alert path/SR Score production sama sekali) dari dataset
    yang SAMA persis dengan yang sudah dipakai bagian atas (get_autopsy_dataset()).

    Klasifikasi kandidat (STRONG_CANDIDATE/PROMISING/WEAK/UNSTABLE/
    LOW_SAMPLE/INSUFFICIENT_DATA) ditampilkan APA ADANYA per definisi
    Part 10 -- SENGAJA tidak ada "fitur terbaik" tunggal, ini laporan
    bukti statistik, bukan rekomendasi token.
    """
    n_total = len(rows)
    if n_total < 20:
        await update.message.reply_text(
            f"🧪 Phase 5 Autopsy Engine\n\n"
            f"Dataset autopsy-ready cuma {n_total} baris -- di bawah minimum "
            f"yang masuk akal buat analisis fitur/kombinasi/validasi temporal. "
            f"Bagian ini di-skip dulu, tunggu data terkumpul lebih banyak."
        )
        return

    result = ae.run_full_autopsy(rows)

    # ---- 3. TOP SIGNAL FACTORS ----
    top_lines = ["🏆 TOP SIGNAL FACTORS (evidence-ranked, bukan rekomendasi final)", ""]
    scored = []
    for fa in result["numeric_feature_autopsy"] + result["binary_feature_autopsy"]:
        segments = fa.get("buckets") or fa.get("categories") or []
        best = max(
            (s for s in segments if s["n"] >= 10 and s["lift"] is not None),
            key=lambda s: abs(s["lift"]), default=None,
        )
        if best:
            scored.append((fa["feature"], fa["kind"], best))
    scored.sort(key=lambda x: abs(x[2]["lift"]), reverse=True)
    if not scored:
        top_lines.append("(Belum ada fitur dengan sample cukup buat dirangking.)")
    for name, kind, seg in scored[:12]:
        seg_label = seg.get("bucket") or f"={seg.get('value')}"
        top_lines.append(
            f"• {name} [{seg_label}] n={seg['n']} winner_rate={_fmt_pct(seg['winner_rate'])} "
            f"lift={_fmt_pct(seg['lift'])} (rel. {_fmt_pct(seg['relative_lift'])})"
        )
    await _send_chunked(update, top_lines)

    # ---- 6. COMBINATION PATTERNS ----
    combo_lines = ["🔗 COMBINATION PATTERNS (top kandidat dari fase discovery)", ""]
    if not result["combination_candidates"]:
        combo_lines.append("(Belum ada kombinasi dengan sample cukup.)")
    for c in result["combination_candidates"][:10]:
        combo_lines.append(
            f"• {c['name']}\n"
            f"  discovery: n={c['discovery_n']} lift={_fmt_pct(c['discovery_lift'])} | "
            f"validation: n={c['validation_n']} lift={_fmt_pct(c['validation_lift'])} "
            f"→ {c['stability']} / {c['recommendation']}"
        )
    await _send_chunked(update, combo_lines)

    # ---- 7. TEMPORAL VALIDATION (ringkasan) ----
    all_candidates = result["single_feature_candidates"] + result["combination_candidates"]
    stability_counts = {}
    for c in all_candidates:
        stability_counts[c["stability"]] = stability_counts.get(c["stability"], 0) + 1
    temporal_lines = [
        "⏳ TEMPORAL VALIDATION",
        "",
        f"Discovery set: {result['discovery_n']} sinyal (paling lama)",
        f"Validation set: {result['validation_n']} sinyal (paling baru)",
        "",
        "Ringkasan stabilitas seluruh kandidat (fitur tunggal + kombinasi):",
    ]
    for label in ("STABLE", "UNSTABLE", "LOW_SAMPLE", "INSUFFICIENT_DATA"):
        temporal_lines.append(f"  {label}: {stability_counts.get(label, 0)}")
    await _send_chunked(update, temporal_lines)

    # ---- 8/9. SR SCORE v0 (lengkap: downside + coverage) ----
    sr_lines = ["🎯 SR SCORE v0 -- Autopsy Lengkap (READ-ONLY, shadow mode tidak berubah)", ""]
    sr = result["sr_score_v0"]
    for label in sorted(k for k in sr if not k.startswith("_")):
        stats = sr[label]
        sr_lines.append(
            f"Score {label}: n={stats['n']} | winner_rate={_fmt_pct(stats['winner_rate'])} | "
            f"1.5x={_fmt_pct(stats['rate_1_5x'])} 3x={_fmt_pct(stats['rate_3x'])} 5x={_fmt_pct(stats['rate_5x'])}\n"
            f"  median time-to-2x: {_fmt_num(stats['median_time_to_2x_minutes'])} min | "
            f"median drawdown: {_fmt_num(stats['median_max_drawdown_pct'])}% | "
            f"survival 1h: {_fmt_pct(stats['survival_rate_1h'])}\n"
            f"  coverage: {stats['coverage']['candidate_alerts']}/{stats['coverage']['total_baseline_alerts']} alerts "
            f"({_fmt_num(stats['coverage']['pct_alerts_retained'])}%)"
        )
    sr_lines.append("")
    sr_lines.append("Kontribusi marjinal per komponen (dengan vs tanpa flag itu saja -- BUKAN stratifikasi terkontrol penuh):")
    for comp, stats in sr["_component_marginal"].items():
        sr_lines.append(
            f"  {comp}: with={_fmt_pct(stats['winner_rate_with'])} (n={stats['n_with']}) | "
            f"without={_fmt_pct(stats['winner_rate_without'])} (n={stats['n_without']})"
        )
    await _send_chunked(update, sr_lines)

    # ---- Phase 6: SR Score v1 vs v0 (read-only, tidak mempengaruhi apa pun) ----
    v1_comparison = result["sr_score_v1_comparison"]
    v1 = v1_comparison["v1"]
    v1_lines_report = [
        "🆕 SR SCORE v1 (Phase 6, shadow mode, TERPISAH dari v0)",
        "",
        f"Scored: {v1['scored_n']} | Unscored (histori/data lama): {v1['unscored_n']}",
        f"Rata-rata confidence: {_fmt_num(v1['avg_confidence'])}%" if v1['avg_confidence'] is not None else "Rata-rata confidence: n/a",
        "",
    ]
    for band in v1["bands"]:
        v1_lines_report.append(
            f"Band {band['label']}: n={band['n']} | winner_rate={_fmt_pct(band['winner_rate'])} | "
            f"1.5x={_fmt_pct(band['rate_1_5x'])} 3x={_fmt_pct(band['rate_3x'])} 5x={_fmt_pct(band['rate_5x'])}"
        )
    v1_lines_report.append("")
    v1_lines_report.append("Validasi temporal per band (discovery vs validation):")
    for tr in v1_comparison["v1_temporal_validation"]:
        v1_lines_report.append(
            f"  {tr['band']}: disc n={tr['discovery_n']} lift={_fmt_pct(tr['discovery_lift'])} | "
            f"valid n={tr['validation_n']} lift={_fmt_pct(tr['validation_lift'])} → {tr['stability']}"
        )
    v1_lines_report.append("")
    v1_lines_report.append("Rata-rata kontribusi komponen (dari snapshot yang punya datanya):")
    for col, stats in v1["component_avg"].items():
        v1_lines_report.append(f"  {col}: avg={_fmt_num(stats['avg'])} (n={stats['n']})")
    v1_lines_report.append("")
    v1_lines_report.append("v1 BELUM dipromosikan ke production apa pun -- murni evidence buat keputusan berikutnya.")
    await _send_chunked(update, v1_lines_report)

    # ---- 10. DATA GAPS ----
    gap_lines = ["🕳 DATA GAPS", ""]
    missing_pairs = []
    for fa in result["numeric_feature_autopsy"] + result["binary_feature_autopsy"]:
        if fa["missing_rate"] is not None:
            missing_pairs.append((fa["feature"], fa["missing_rate"]))
    missing_pairs.sort(key=lambda x: x[1], reverse=True)
    gap_lines.append("Fitur dengan data paling bolong (dari dataset autopsy-ready):")
    for name, rate in missing_pairs[:10]:
        gap_lines.append(f"  {name}: {_fmt_pct(rate)} missing")
    await _send_chunked(update, gap_lines)

    # ---- 11. SR SCORE v1 CANDIDATES ----
    v1_lines = [
        "🧪 SR SCORE v1 CANDIDATES (klasifikasi bukti, BUKAN rekomendasi token)",
        "",
        "Definisi: STRONG_CANDIDATE/PROMISING/WEAK/UNSTABLE/LOW_SAMPLE/INSUFFICIENT_DATA.",
        "TIDAK ADA yang otomatis dipakai buat SR Score v0/filter apa pun.",
        "",
    ]
    grouped = {}
    for c in all_candidates:
        grouped.setdefault(c["recommendation"], []).append(c)
    for label in ("STRONG_CANDIDATE", "PROMISING", "WEAK", "UNSTABLE", "LOW_SAMPLE", "INSUFFICIENT_DATA"):
        items = grouped.get(label, [])
        v1_lines.append(f"[{label}] ({len(items)})")
        for c in items[:8]:
            v1_lines.append(
                f"  • {c['name']}: disc n={c['discovery_n']} lift={_fmt_pct(c['discovery_lift'])} | "
                f"valid n={c['validation_n']} lift={_fmt_pct(c['validation_lift'])} | "
                f"coverage={_fmt_num(c['coverage']['pct_alerts_retained'])}%"
            )
        v1_lines.append("")
    await _send_chunked(update, v1_lines)

    # ---- Phase 7 (Part B): CRITERIA OPTIMIZATION (shadow, read-only) ----
    # PENTING: ini CUMA analisis, TIDAK PERNAH mengubah nilai /setcriteria
    # produksi -- lihat _get_live_criteria_values() & autopsy_engine.py.
    current_values = _get_live_criteria_values()
    criteria_result = ae.run_criteria_optimization(rows, current_values)
    interaction_results = ae.run_criteria_interactions(rows, current_values)

    crit_lines = [
        "🎯 CRITERIA OPTIMIZATION (shadow, TIDAK mengubah /setcriteria)",
        "",
        "Kandidat SELALU lebih ketat dari sekarang (tidak bisa uji lebih longgar --",
        "data kandidat yang ditolak kriteria sekarang memang tidak pernah direkam).",
        "",
    ]
    any_shown = False
    for report in criteria_result["gate_reports"]:
        if report["status"] != "OK":
            continue
        # Cuma tampilkan kandidat TERKETAT yang masih STABLE & validation_lift positif
        # (kandidat paling bermakna) -- bukan semua delta, biar tidak dump ratusan baris.
        stable_candidates = [c for c in report["candidates"]
                              if c["delta_label"] != "current" and c["stability"] == "STABLE"
                              and c["validation_lift"] is not None and c["validation_lift"] > 0]
        if not stable_candidates:
            continue
        any_shown = True
        best = stable_candidates[-1]  # delta terbesar yang masih stabil
        current_cand = report["candidates"][0]
        tier_label = f" [{report['tier']}]" if report["tier"] else ""
        crit_lines.append(f"• {report['gate']}{tier_label}: current={_fmt_num(report['current_threshold'])}")
        crit_lines.append(
            f"    Current: n={current_cand['n']} winner_rate={_fmt_pct(current_cand['winner_rate'])}"
        )
        crit_lines.append(
            f"    Candidate {best['delta_label']} (≥{_fmt_num(best['threshold'])}): "
            f"n={best['n']} ({_fmt_num(best['coverage']['pct_alerts_retained'])}% retained) "
            f"winner_rate={_fmt_pct(best['winner_rate'])}"
        )
        crit_lines.append(
            f"    Discovery lift={_fmt_pct(best['discovery_lift'])} | Validation lift={_fmt_pct(best['validation_lift'])} "
            f"→ {best['stability']} / {best['recommendation']}"
        )
        crit_lines.append(
            f"    Trade-off: winners retained {best['coverage']['winners_retained']}/{best['coverage']['total_winners']}, "
            f"losers cut {_fmt_num(best['coverage']['loser_reduction_pct'])}%"
        )
        crit_lines.append("")
    if not any_shown:
        crit_lines.append("(Belum ada kandidat gate yang STABLE & lebih baik dari sekarang -- data masih sedikit atau kriteria sekarang sudah cukup baik.)")
        crit_lines.append("")

    crit_lines.append("🔗 Interaksi 2-gate (dites bersamaan, +50% masing-masing):")
    for inter in interaction_results:
        if inter["status"] != "OK":
            crit_lines.append(f"  {inter['pair'][0]} + {inter['pair'][1]}: {inter['status']}")
            continue
        crit_lines.append(
            f"  {inter['pair'][0]} + {inter['pair'][1]}: n={inter['n']} winner_rate={_fmt_pct(inter['winner_rate'])} "
            f"→ disc lift={_fmt_pct(inter['discovery_lift'])} valid lift={_fmt_pct(inter['validation_lift'])} "
            f"({inter['stability']}/{inter['recommendation']})"
        )
    crit_lines.append("")
    crit_lines.append("Gate yang TIDAK bisa dianalisis dari data snapshot saat ini:")
    for key, reason in criteria_result["not_analyzable"].items():
        crit_lines.append(f"  {key}: {reason}")
    await _send_chunked(update, crit_lines)

    # ---- Persist run metadata (Part 12) ----
    try:
        db.record_autopsy_run(
            dataset_size=result["n_total"],
            discovery_n=result["discovery_n"],
            validation_n=result["validation_n"],
            feature_version=result["feature_version"],
            min_sample_single=result["config"]["min_sample_single"],
            min_sample_combo=result["config"]["min_sample_combo"],
            min_sample_strong=result["config"]["min_sample_strong"],
            triggered_by=str(update.effective_user.id) if update.effective_user else "admin",
        )
    except Exception as e:
        logger.warning(f"Gagal mencatat metadata autopsy run (tidak fatal): {e}")


def _format_intelreport2_overview(dataset: dict) -> str:
    """Ringkasan dataset Phase 11B -- arahan architect poin 8: laporan
    HARUS eksplisit soal periode analisis, jumlah token eligible,
    menang/kalah, TIDAK BOLEH menyiratkan dataset ini representasi
    perilaku SolRadar jangka panjang (retensi cuma 3 hari)."""
    winners = sum(1 for v in dataset.values() if v["reached_2x"])
    losers = len(dataset) - winners
    ebc_tokens = sum(1 for v in dataset.values() if any(
        iv2.classify_observation_provenance(o) == "ebc" for o in v["observations"]))
    dex_tokens = sum(1 for v in dataset.values() if any(
        iv2.classify_observation_provenance(o) == "dex" for o in v["observations"]))

    all_alert_times = [v["alerted_at"] for v in dataset.values() if v["alerted_at"]]
    period = f"{min(all_alert_times)} s/d {max(all_alert_times)}" if all_alert_times else "(tidak ada data)"

    lines = [
        "🧪 /intelreport2 — Behavioral Intelligence V1 (Phase 11B)",
        "",
        "⚠️ Analisis/shadow intelligence MURNI. TIDAK ADA perubahan ke SR Score, "
        "kriteria, eligibility, atau threshold apa pun dari laporan ini.",
        "",
        f"Periode alert dalam dataset: {period}",
        f"⚠️ Retensi telemetry saat ini cuma 3 hari (biaya, sementara) -- dataset "
        f"ini TIDAK merepresentasikan perilaku jangka panjang SolRadar.",
        "",
        f"Total token organik eligible (outcome sudah final, PROMOTED dikecualikan): {len(dataset)}",
        f"  • Menang (2x+): {winners}",
        f"  • Kalah: {losers}",
        f"Token dgn observasi EBC asli (real_sol_reserves): {ebc_tokens}",
        f"Token dgn observasi DEX (volume_m5): {dex_tokens}",
    ]
    return "\n".join(lines)


def _format_intelreport2_section(reports: list, section_label: str) -> str:
    """Tabel ringkas per-metrik per-window buat 1 sisi provenance --
    HANYA metrik yg punya minimal 1 window dgn bukti cukup yang
    ditampilkan (arahan architect: jangan jadi dump analitik raksasa)."""
    lines = [f"📊 {section_label}", ""]
    by_metric = {}
    for r in reports:
        by_metric.setdefault(r["metric"], []).append(r)

    shown_any = False
    for metric, metric_reports in by_metric.items():
        if not any(r["sufficient_evidence"] for r in metric_reports):
            continue
        shown_any = True
        lines.append(f"— {metric} —")
        for r in metric_reports:
            if r["sufficient_evidence"]:
                lines.append(
                    f"  {r['window_minutes']}m: menang={r['winner']['median']:.4g} (n={r['winner']['n']}) "
                    f"vs kalah={r['loser']['median']:.4g} (n={r['loser']['n']}) | Δ={r['difference']:+.4g}"
                )
            else:
                lines.append(
                    f"  {r['window_minutes']}m: bukti kurang (coverage menang={r['winner_coverage']}, "
                    f"kalah={r['loser_coverage']})"
                )
        lines.append("")

    if not shown_any:
        lines.append("(Tidak ada metrik dengan sample size cukup di sisi ini -- lihat coverage di /phase11audit.)")
    return "\n".join(lines)


def _format_candidate_signals(candidates: list) -> str:
    """CANDIDATE INTELLIGENCE SIGNALS -- arahan architect poin 10, OUTPUT
    PALING PENTING dari seluruh laporan. Bahasa SELALU "candidate"/
    "observed separation" -- TIDAK PERNAH "predictive"/"proven"."""
    lines = ["🎯 CANDIDATE INTELLIGENCE SIGNALS", ""]
    if not candidates:
        lines.append(
            "Tidak ada pola yang memenuhi syarat bukti minimal "
            f"(>= {iv2.MIN_SAMPLE_SIZE_PER_GROUP} token per grup, konsisten arahnya "
            f"di >= {iv2.MIN_WINDOWS_FOR_CANDIDATE} window) pada dataset saat ini. "
            "Ini bukan berarti tidak ada sinyal -- kemungkinan besar retensi 3 hari "
            "belum cukup data. Jujur dilaporkan apa adanya, bukan dipaksakan."
        )
        return "\n".join(lines)

    for c in candidates:
        direction_label = "lebih tinggi pada pemenang" if c["direction"] == "winner_higher" else "lebih tinggi pada yang kalah"
        lines.append(f"— {c['metric']} ({c['provenance'].upper()}) —")
        lines.append(f"  Arah: {direction_label} (konsisten di {len(c['windows'])} window)")
        for w in c["windows"]:
            lines.append(
                f"  @{w['window_minutes']}m: menang={w['winner']['median']:.4g} (n={w['winner']['n']}) "
                f"vs kalah={w['loser']['median']:.4g} (n={w['loser']['n']})"
            )
        lines.append(f"  Status: {c['status']} (observed separation historis -- BUKAN klaim prediktif/kausal)")
        lines.append("")
    return "\n".join(lines)


_ZERO_DIAGNOSTIC_METRICS = [
    ("volume_velocity_5m", "volume_m5", False),
    ("volume_velocity_1h", "volume_h1", False),
    ("price_velocity_per_minute", "price_usd", False),
    ("price_acceleration", "price_usd", True),
]


async def diagnose_zeros(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Diagnostik Phase 11B -- READ-ONLY MURNI, admin-only, tidak mengubah
    kode/database/skema/kriteria/SR-Score/eligibility/retensi/
    /intelreport2 apa pun. Menyelidiki median persis 0 yang mencurigakan
    di hasil /intelreport2 (volume_velocity_*, price_velocity_per_minute,
    price_acceleration) -- apakah itu perubahan genuinely nol, atau
    artefak perhitungan (data NULL/observasi kurang/dll).

    Lihat db.diagnose_zero_derived_metrics() buat detail metodologi
    lengkap. Command ini MURNI baca & klasifikasi -- TIDAK memperbaiki
    apa pun walau ketemu anomali, sesuai instruksi eksplisit.
    """
    if not _is_admin(update):
        return
    await update.message.reply_text("⏳ Menyelidiki nilai nol pada metrik turunan (read-only, mungkin makan waktu)...")

    for metric, raw_field, is_accel in _ZERO_DIAGNOSTIC_METRICS:
        try:
            result = await asyncio.to_thread(db.diagnose_zero_derived_metrics, metric, raw_field, is_accel)
        except Exception as e:
            await update.message.reply_text(f"⚠️ Gagal diagnosis {metric}: {e}")
            continue

        c = result["counts"]
        lines = [f"🔬 Diagnostik: {metric} = 0.0", ""]
        lines.append(f"Total baris bernilai persis 0.0: {result['total_zero_valued_rows']}")
        lines.append(f"Sample diperiksa: {result['sampled']} ({result['winners_sampled']} menang, {result['losers_sampled']} kalah)")
        lines.append("")
        lines.append(f"1️⃣ Genuinely unchanged (nilai mentah awal=akhir, 0 itu jujur): {c['genuinely_unchanged']}")
        lines.append(f"2️⃣ NULL/missing pada nilai mentah (seharusnya MUSTAHIL -- kalau >0, ini bug baru): {c['null_involved']}")
        lines.append(f"3️⃣ Observasi kurang buat hitung (seharusnya MUSTAHIL -- kalau >0, ini bug baru): {c['insufficient_observations']}")
        lines.append(f"4️⃣ Unexplained (nilai mentah beda tapi hasil turunan tetap 0 -- kemungkinan bug pembulatan/logic): {c['unexplained']}")
        await update.message.reply_text("\n".join(lines))

        for category, examples in result["examples"].items():
            if not examples:
                continue
            ex_lines = [f"  Contoh '{category}' ({metric}):"]
            for e in examples:
                ex_lines.append(
                    f"  • {e['token_address'][:12]}... @ {e['observed_at']} (menang={e['reached_2x']}) "
                    f"window={e['window_size']} titik, nilai_mentah={e['window_raw_values']}"
                )
            await update.message.reply_text("\n".join(ex_lines))

    await update.message.reply_text(
        "✅ Diagnostik selesai. TIDAK ADA kode/data/kriteria yang diubah -- murni evidence buat "
        "keputusan architect. Kalau kategori 2/3 (NULL/observasi kurang) muncul dgn jumlah > 0, "
        "itu tanda ada bug baru yang perlu digali terpisah -- BUKAN ditangani otomatis di sini."
    )


def _format_pressure_layer_section(report: dict, section_label: str) -> str:
    """
    PRESSURE LAYER V1 -- arahan Architect. Format hasil
    iv2.build_pressure_layer_report() jadi 1 pesan Telegram: M5 & H1
    per window (5/15/30/60m, TIDAK PERNAH 180m), PLUS status agreement
    M5+H1 per window. Bahasa SELALU "historical association"/"observed
    separation"/"candidate intelligence signal" -- TIDAK PERNAH
    "predictive"/"proven" (arahan poin 12).
    """
    lines = [f"🧭 {section_label}", ""]

    by_metric = {}
    for r in report["metric_reports"]:
        by_metric.setdefault(r["metric"], []).append(r)

    for metric, metric_reports in by_metric.items():
        lines.append(f"— {metric} —")
        for r in metric_reports:
            if r["sufficient_evidence"]:
                lines.append(
                    f"  {r['window_minutes']}m: menang={r['winner']['median']:.4g} (n={r['winner']['n']}) "
                    f"vs kalah={r['loser']['median']:.4g} (n={r['loser']['n']}) | Δ={r['difference']:+.4g}"
                )
            else:
                lines.append(
                    f"  {r['window_minutes']}m: bukti kurang (coverage menang={r['winner_coverage']}, "
                    f"kalah={r['loser_coverage']})"
                )
        lines.append("")

    lines.append("— M5/H1 Agreement —")
    for a in report["agreement_reports"]:
        w, l = a["winner"], a["loser"]
        lines.append(
            f"  {a['window_minutes']}m: menang agree+={w['agree_positive']}/{w['n_available']} "
            f"({w['agree_positive_rate']:.0f}%)" if w["agree_positive_rate"] is not None else
            f"  {a['window_minutes']}m: menang (tidak ada data cukup)"
        )
        lines.append(
            f"    kalah agree+={l['agree_positive']}/{l['n_available']} "
            f"({l['agree_positive_rate']:.0f}%)" if l["agree_positive_rate"] is not None else
            f"    kalah (tidak ada data cukup)"
        )

    lines.append("")
    lines.append("⚠️ Window 180m TIDAK PERNAH dipakai sebagai bukti Pressure Layer (terbukti tidak reliable).")

    if report["candidates"]:
        lines.append("")
        lines.append("🎯 Kandidat dari Pressure Layer ini:")
        for c in report["candidates"]:
            lines.append(f"  • {c['metric']}: {c['direction']} (candidate -- observed separation historis, BUKAN prediktif)")

    return "\n".join(lines)


async def intelreport2(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Phase 11B -- Behavioral Intelligence V1, arahan architect. Command
    TERPISAH dari /intelreport lama (yang TETAP ada apa adanya, tidak
    disentuh) -- admin-only, READ-ONLY, murni evidence.

    TIDAK PERNAH mengubah SR Score/kriteria/eligibility/threshold apa
    pun. Pemisahan provenance (EBC asli vs DEX) WAJIB di level observasi
    (lihat intelligence_v2.py), window waktu tetap (5/15/30/60/180 menit
    sejak alert) WAJIB buat memutus bias survival token pemenang yang
    terpantau lebih lama. Statistik robust (median/kuartil), bukan
    rata-rata. PROMOTED dikecualikan total dari analisis organik.
    """
    if not _is_admin(update):
        return
    await update.message.reply_text("⏳ Menyusun laporan Behavioral Intelligence V1 (Phase 11B)...")
    try:
        dataset = await asyncio.to_thread(db.get_intelligence_v2_dataset)
    except Exception as e:
        await update.message.reply_text(f"⚠️ Gagal ambil dataset: {e}")
        return

    if not dataset:
        await update.message.reply_text(
            "Belum ada token organik dengan outcome final dalam dataset saat ini -- "
            "coba lagi nanti setelah lebih banyak alert selesai diobservasi."
        )
        return

    await update.message.reply_text(_format_intelreport2_overview(dataset))

    ebc_reports = iv2.build_full_report(dataset, "ebc")
    dex_reports = iv2.build_full_report(dataset, "dex")

    await update.message.reply_text(_format_intelreport2_section(ebc_reports, "SECTION A — Pre-graduation EBC behavior (real_sol_reserves)"))
    await update.message.reply_text(_format_intelreport2_section(dex_reports, "SECTION B — Post-graduation / DEX behavior (volume_m5)"))

    all_candidates = iv2.detect_candidate_signals(ebc_reports) + iv2.detect_candidate_signals(dex_reports)
    await update.message.reply_text(_format_candidate_signals(all_candidates))

    pressure_report = iv2.build_pressure_layer_report(dataset, "dex")
    await update.message.reply_text(_format_pressure_layer_section(pressure_report, "PRESSURE LAYER V1 (M5 + H1 + Agreement)"))


def _format_intelligenceaudit_report(analysis: dict) -> list:
    """Format hasil trending.analyze_intelligence_v1_shadow() jadi
    beberapa pesan Telegram -- dipisah dari command handler biar gampang
    dites tanpa perlu mock Update/Telegram sama sekali."""
    messages = []
    header = [
        "🧪 /intelligenceaudit — Intelligent Alert V1 (SHADOW MODE)",
        "",
        "⚠️ SHADOW ONLY. Tidak ada satu pun hasil di sini yang tampil ke "
        "alert Telegram asli -- INTELLIGENCE_V1_ENABLED masih False.",
        "",
        f"Total token organik eligible (outcome final, PROMOTED dikecualikan): {analysis['total_eligible']}",
        f"  • Menang (2x+): {analysis['winners_total']}",
        f"  • Kalah: {analysis['losers_total']}",
    ]
    messages.append("\n".join(header))

    for name, c in analysis["per_condition"].items():
        lines = [f"— {name} —"]
        lines.append(f"FIRED={c['fired']} · NOT_FIRED={c['not_fired']} · UNKNOWN={c['unknown']} "
                     f"(coverage {c['coverage_pct']:.1f}%)")
        if c["winrate_fired_pct"] is not None:
            lines.append(f"Saat FIRED: {c['winners_among_fired']} menang / {c['losers_among_fired']} kalah "
                         f"(winrate {c['winrate_fired_pct']:.1f}%, n={c['sample_size_fired']})")
        else:
            lines.append("Saat FIRED: (tidak ada data)")
        if c["winrate_not_fired_pct"] is not None:
            lines.append(f"Saat NOT_FIRED: winrate {c['winrate_not_fired_pct']:.1f}% (n={c['sample_size_not_fired']})")
        else:
            lines.append("Saat NOT_FIRED: (tidak ada data)")
        if c["lift_pct"] is not None:
            lines.append(f"Lift: {c['lift_pct']:+.1f} poin persentase")
        else:
            lines.append("Lift: (tidak bisa dihitung, salah satu sisi tidak ada data)")
        messages.append("\n".join(lines))

    combo_lines = ["📎 Kombinasi 2-kondisi (cuma yang sample size memadai)", ""]
    if not analysis["combinations"]:
        combo_lines.append(f"(Tidak ada kombinasi dengan n >= {trending.INTELLIGENCE_V1_MIN_SAMPLE_SIZE} saat ini.)")
    else:
        for combo in analysis["combinations"]:
            combo_lines.append(
                f"{' + '.join(combo['conditions'])}: winrate {combo['winrate_pct']:.1f}% "
                f"({combo['winners']} menang / {combo['losers']} kalah, n={combo['n']})"
            )
    messages.append("\n".join(combo_lines))

    return messages


def _format_pressure_ablation_report(shadow_data: list) -> list:
    """
    ABLATION / INCREMENTAL VALUE ANALYSIS -- arahan Architect, task
    ANALISIS MURNI (tidak ada perubahan produksi apa pun). Menjawab:
    "Apakah Pressure Layer nambah informasi DI ATAS 5 kondisi pra-alert
    yang sudah ada, atau cuma mengulang informasi yang sama?"

    TIDAK mengarang threshold produksi (arahan poin 5) -- median split
    dari populasi gabungan dipakai buat pressure kontinu, dilaporkan
    eksplisit. PRE-ALERT (5 kondisi) vs POST-ALERT (pressure) dipisah
    eksplisit (arahan poin 7).
    """
    messages = []

    total = len(shadow_data)
    winners = sum(1 for d in shadow_data if d["reached_2x"])
    with_pressure = sum(1 for d in shadow_data if d["features"].get("pressure_h1", {}).get("60") is not None)
    header = [
        "🧪 PRESSURE LAYER V1 -- ABLATION / INCREMENTAL VALUE ANALYSIS",
        "",
        "⚠️ ANALISIS MURNI. Tidak ada kriteria/SR-Score/eligibility/Telegram yang berubah.",
        "",
        f"Total token organik eligible: {total} ({winners} menang, {total - winners} kalah)",
        f"Token dgn data pressure H1@60m: {with_pressure}/{total}",
        "",
        "PRE-ALERT: 5 kondisi existing (Section A)",
        "POST-ALERT: Pressure Layer (Section B/C/D) -- arahan poin 7, dipisah eksplisit",
    ]
    messages.append("\n".join(header))

    # --- Section A ---
    section_a = iv2.build_existing_five_condition_summary(shadow_data)
    lines_a = ["### A. EXISTING 5 CONDITIONS", ""]
    for count in sorted(section_a.keys()):
        r = section_a[count]
        if r["n"] > 0:
            lines_a.append(f"  {count} kondisi fired: n={r['n']}, winrate={r['winrate_pct']:.1f}%")
    messages.append("\n".join(lines_a))

    # --- Section B & C ---
    for label, key in [("B. PRESSURE M5", "pressure_m5"), ("C. PRESSURE H1", "pressure_h1")]:
        report = iv2.build_pressure_median_split_report(shadow_data, key)
        lines = [f"### {label}", ""]
        for window in ["5", "15", "30", "60"]:
            w = report[window]
            if w["median_value"] is None:
                lines.append(f"  {window}m: tidak ada data")
                continue
            lines.append(
                f"  {window}m (median={w['median_value']:.4g}): "
                f"di atas median winrate={w['above_median']['winrate_pct']:.1f}% (n={w['above_median']['n']}) | "
                f"di bawah/sama winrate={w['at_or_below_median']['winrate_pct']:.1f}% (n={w['at_or_below_median']['n']}) | "
                f"missing={w['missing_count']}"
                if w["above_median"]["n"] and w["at_or_below_median"]["n"] else
                f"  {window}m: bukti kurang di salah satu sisi (missing={w['missing_count']})"
            )
        messages.append("\n".join(lines))

    # --- Section D ---
    dataset_for_agreement = {d["token_address"]: {"reached_2x": d["reached_2x"], "observations": []} for d in shadow_data}
    # Section D pakai data agreement yang SUDAH dihitung job post-alert (tersimpan di features),
    # bukan dihitung ulang dari behavioral_telemetry mentah -- reuse murni.
    lines_d = ["### D. M5/H1 AGREEMENT", ""]
    for window in ["5", "15", "30", "60"]:
        win_states = [d["features"].get("pressure_agreement", {}).get(window) for d in shadow_data if d["reached_2x"]]
        lose_states = [d["features"].get("pressure_agreement", {}).get(window) for d in shadow_data if not d["reached_2x"]]
        win_avail = [s for s in win_states if s and s != "insufficient_data"]
        lose_avail = [s for s in lose_states if s and s != "insufficient_data"]
        win_pos_rate = (win_avail.count("agree_positive") / len(win_avail) * 100.0) if win_avail else None
        lose_pos_rate = (lose_avail.count("agree_positive") / len(lose_avail) * 100.0) if lose_avail else None
        if win_pos_rate is not None and lose_pos_rate is not None:
            lines_d.append(f"  {window}m: menang agree+={win_pos_rate:.0f}% (n={len(win_avail)}) vs kalah agree+={lose_pos_rate:.0f}% (n={len(lose_avail)})")
        else:
            lines_d.append(f"  {window}m: bukti kurang")
    messages.append("\n".join(lines_d))

    # --- Section E (paling penting) ---
    section_e = iv2.build_incremental_value_analysis(shadow_data, "pressure_h1", "60", strong_threshold=2)
    lines_e = ["### E. EXISTING 5 + PRESSURE (PALING PENTING)", ""]
    lines_e.append(f"Baseline (>=2 dari 5 kondisi fired): n={section_e['baseline_group_n']}, "
                   f"winrate={section_e['baseline_winrate_pct']:.1f}%" if section_e["baseline_winrate_pct"] is not None else
                   f"Baseline (>=2 dari 5 kondisi fired): n={section_e['baseline_group_n']} (tidak ada data)")
    hp, lp = section_e["within_group_high_pressure"], section_e["within_group_low_pressure"]
    if hp["n"] and lp["n"]:
        lines_e.append(f"  + pressure H1 TINGGI (>median): winrate={hp['winrate_pct']:.1f}% (n={hp['n']})")
        lines_e.append(f"  + pressure H1 RENDAH (<=median): winrate={lp['winrate_pct']:.1f}% (n={lp['n']})")
        lines_e.append(f"  Δ di dalam grup yang sama: {hp['winrate_pct'] - lp['winrate_pct']:+.1f} poin persentase")
    else:
        lines_e.append("  Bukti kurang buat memisah dalam grup ini.")
    messages.append("\n".join(lines_e))

    # --- Section F ---
    section_f = iv2.build_overlap_analysis(shadow_data, "pressure_h1", "60")
    lines_f = ["### F. OVERLAP / REDUNDANCY", ""]
    if section_f["pct_high_pressure_when_zero_conditions_fired"] is not None and section_f["pct_high_pressure_when_two_plus_conditions_fired"] is not None:
        lines_f.append(f"  % pressure tinggi saat 0 kondisi fired: {section_f['pct_high_pressure_when_zero_conditions_fired']:.1f}% (n={section_f['n_zero_conditions']})")
        lines_f.append(f"  % pressure tinggi saat >=2 kondisi fired: {section_f['pct_high_pressure_when_two_plus_conditions_fired']:.1f}% (n={section_f['n_two_plus_conditions']})")
    else:
        lines_f.append("  Bukti kurang.")
    messages.append("\n".join(lines_f))

    return messages


async def pressure_ablation(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    ABLATION / INCREMENTAL VALUE ANALYSIS -- arahan Architect, task
    ANALISIS MURNI. Admin-only, READ-ONLY, TIDAK mengubah kode/data/
    kriteria/SR-Score/eligibility/Telegram/threshold apa pun. TIDAK
    mengaktifkan Pressure Layer, TIDAK menambah kondisi produksi baru.
    """
    if not _is_admin(update):
        return
    try:
        shadow_data = await asyncio.to_thread(db.get_intelligence_v1_shadow_data)
    except Exception as e:
        await update.message.reply_text(f"⚠️ Gagal ambil data shadow: {e}")
        return

    if not shadow_data:
        await update.message.reply_text("Belum ada data shadow yang bisa dianalisis.")
        return

    for msg in _format_pressure_ablation_report(shadow_data):
        await update.message.reply_text(msg)


async def intelligence_audit(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Intelligent Alert V1 -- SHADOW MODE ONLY (arahan Architect). Command
    admin-only, READ-ONLY, murni evidence -- TIDAK mengubah kode/data/
    kriteria/SR-Score/eligibility/telemetry/retensi/Phase 11B apa pun.

    Melaporkan populasi shadow yang sudah terkumpul: buat tiap 5 kondisi,
    FIRED/NOT_FIRED/UNKNOWN + coverage + winrate + lift, PLUS kombinasi
    2-kondisi yang sample size-nya memadai. Definisi menang/kalah REUSE
    Phase 11B apa adanya -- tidak didefinisikan ulang.
    """
    if not _is_admin(update):
        return
    try:
        shadow_data = await asyncio.to_thread(db.get_intelligence_v1_shadow_data)
    except Exception as e:
        await update.message.reply_text(f"⚠️ Gagal ambil data shadow: {e}")
        return

    if not shadow_data:
        await update.message.reply_text(
            "Belum ada data shadow Intelligent Alert V1 yang bisa dianalisis -- "
            "tunggu lebih banyak alert organik selesai diobservasi."
        )
        return

    analysis = trending.analyze_intelligence_v1_shadow(shadow_data)
    for msg in _format_intelligenceaudit_report(analysis):
        await update.message.reply_text(msg)


async def ebc_provenance(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Validasi provenance Phase 11A -- READ-ONLY MURNI, admin-only, tidak
    mengubah kode/database/skema apa pun. Menjawab pertanyaan dari audit
    source-code sebelumnya dengan data PRODUKSI SUNGGUHAN: apakah baris
    signal_type='EARLY_BONDING_CURVE' beneran campuran 2 populasi (asli
    pra-graduasi dari pump.fun vs pasca-graduasi dari DexScreener yang
    masih diberi label EBC), dan yang PALING KRITIS -- apakah ada baris
    yang punya real_sol_reserves DAN volume_m5 terisi BERSAMAAN (yang
    seharusnya MUSTAHIL/nol menurut arsitektur kode saat ini, karena 2
    fungsi penulisnya -- build_behavioral_observation_ebc/dex -- saling
    eksklusif). Kalau ternyata BUKAN nol, itu tanda ada jalur kontaminasi
    yang belum ketemu di audit source-code, PERLU digali lebih lanjut.
    """
    if not _is_admin(update):
        return
    try:
        stats = await asyncio.to_thread(db.get_ebc_provenance_validation)
    except Exception as e:
        await update.message.reply_text(f"⚠️ Gagal ambil data validasi: {e}")
        return

    lines = ["🔬 EBC Provenance Validation (signal_type='EARLY_BONDING_CURVE')", ""]
    lines.append(f"1️⃣ Total rows: {stats['total_rows']} ({stats['total_unique_tokens']} token unik)")
    lines.append(f"2️⃣ real_sol_reserves IS NOT NULL: {stats['reserves_not_null_rows']} rows ({stats['reserves_not_null_tokens']} token)")
    lines.append(f"3️⃣ real_sol_reserves IS NULL: {stats['reserves_null_rows']} rows ({stats['reserves_null_tokens']} token)")
    lines.append(f"4️⃣ volume_m5 IS NOT NULL: {stats['volume_not_null_rows']} rows ({stats['volume_not_null_tokens']} token)")
    lines.append("")
    lines.append(f"5️⃣ 🚨 KRITIS -- KEDUANYA terisi bersamaan: {stats['both_not_null_rows']} rows "
                 f"({stats['both_not_null_tokens']} token)")
    if stats["both_not_null_rows"] == 0:
        lines.append("   ✅ SESUAI EKSPEKTASI -- 0, konsisten dengan arsitektur kode saat ini "
                     "(2 fungsi penulis mutually exclusive).")
    else:
        lines.append("   ⚠️ TIDAK SESUAI EKSPEKTASI -- seharusnya 0. Ada jalur kontaminasi "
                     "yang belum ketemu di audit source-code, perlu digali lebih lanjut "
                     "SEBELUM dipakai buat Intelligent Alert V1.")
    lines.append(f"6️⃣ Keduanya NULL (metadata-only observation): {stats['neither_rows']} rows "
                 f"({stats['neither_tokens']} token)")
    await update.message.reply_text("\n".join(lines))

    def format_sample(title, rows):
        out = [title]
        if not rows:
            out.append("  (kosong)")
        for r in rows:
            out.append(
                f"  • {r['token_address'][:12]}... @ {r['observed_at']} | "
                f"reserves={r['real_sol_reserves']} progress={r['bonding_curve_progress']} | "
                f"vol_m5={r['volume_m5']} buys={r['buys_m5']} sells={r['sells_m5']}"
            )
        return "\n".join(out)

    await update.message.reply_text(format_sample(
        "📌 Sample -- real_sol_reserves IS NOT NULL (harusnya genuinely EBC/pump.fun):",
        stats["sample_reserves_not_null"],
    ))
    await update.message.reply_text(format_sample(
        "📌 Sample -- volume_m5 IS NOT NULL (harusnya pasca-graduasi/DexScreener, meski berlabel EBC):",
        stats["sample_volume_not_null"],
    ))
    if stats["both_not_null_rows"] > 0:
        await update.message.reply_text(format_sample(
            "🚨 Sample -- KEDUANYA terisi (harusnya TIDAK ADA sama sekali):",
            stats["sample_both_not_null"],
        ))
    await update.message.reply_text(format_sample(
        "📌 Sample -- keduanya NULL:",
        stats["sample_neither"],
    ))


async def phase11audit(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Phase 11A -- audit READ-ONLY buat data behavioral_telemetry yang sudah
    kekumpul: coverage per field, EBC vs DEX, linkage ke outcome, kesehatan
    data dasar. TIDAK mengubah kriteria/SR-Score/eligibility/telemetri apa
    pun -- murni SELECT, sama filosofinya dengan /autopsy & /intelreport.

    TIDAK bisa menjawab soal error/429/kegagalan polling -- itu cuma ada
    di Deploy Logs (Railway), bukan di database (yang gagal ya tidak
    pernah masuk ke tabel). Baris terakhir laporan ini bilang eksplisit
    kata kunci apa yang perlu dicari manual di log buat itu.

    Admin-only, sama seperti /autopsy & /intelreport.
    """
    if not _is_admin(update):
        return

    fields_to_check = [
        "market_cap", "price_usd", "liquidity", "volume_m5", "volume_h1",
        "buys_m5", "sells_m5", "buys_h1", "sells_h1", "real_sol_reserves",
        "bonding_curve_progress", "buy_sell_pressure_m5", "buy_sell_pressure_h1",
        "volume_velocity_5m", "volume_velocity_1h", "volume_acceleration",
        "price_velocity_per_minute", "price_acceleration",
        "reserve_velocity", "reserve_acceleration", "bonding_progress_velocity",
    ]

    try:
        stats = db.get_behavioral_telemetry_audit_stats(fields_to_check)
    except Exception as e:
        await update.message.reply_text(f"⚠️ Gagal ambil data audit: {e}")
        return

    # ---- Pesan 1: Dataset + Data Quality + Outcome Linkage + DB Impact ----
    lines = ["📊 Phase 11A — Production Audit", ""]
    lines.append("1️⃣ DATASET")
    lines.append(f"Total telemetry rows: {stats['total_rows']}")
    lines.append(f"Unique tokens: {stats['unique_tokens']}")
    lines.append(f"EBC: {stats['ebc_rows']} rows / {stats['ebc_tokens']} unique tokens")
    lines.append(f"DEX: {stats['dex_rows']} rows / {stats['dex_tokens']} unique tokens")
    lines.append(f"PROMOTED: {stats['promoted_rows']} rows / {stats['promoted_tokens']} unique tokens")
    lines.append(f"Lainnya/tidak dikenal: {stats['other_rows']} rows / {stats['other_tokens']} unique tokens")
    if stats["other_breakdown"]:
        lines.append("  Rincian signal_type di kategori 'lainnya':")
        for item in stats["other_breakdown"]:
            label = item["signal_type"] if item["signal_type"] is not None else "(NULL)"
            lines.append(f"  • {label}: {item['n']} rows / {item['toks']} tokens")
        lines.append("  (\"UNKNOWN\" = token yang tidak punya baris signal_snapshots sama sekali --")
        lines.append("  kemungkinan besar token lama dari sebelum tabel snapshot ada, yang masih")
        lines.append("  terus di-track check_milestones_job. Bukan bug data, tapi worth ditinjau.)")
        lines.append("")
        lines.append("  🔍 10 token 'lainnya' dgn observasi PALING BARU (buat cek apakah fix")
        lines.append("  skip-UNKNOWN beneran jalan -- token LAMA harusnya BERHENTI nambah baris")
        lines.append("  baru sejak deploy fix; kalau last_seen-nya BARU dari SETELAH deploy DAN")
        lines.append("  first_seen-nya juga LAMA (dari SEBELUM deploy), berarti fix belum jalan):")
        for item in stats["other_last_seen_per_token"]:
            short_addr = item["token_address"][:8] + "..." if len(item["token_address"]) > 8 else item["token_address"]
            lines.append(f"  • {short_addr}: first={item['first_seen']} last={item['last_seen']} (n={item['n']})")
    lines.append("")
    lines.append("4️⃣ DATA QUALITY (dari data -- soal error/429/gagal polling ada di poin terakhir)")
    lines.append(f"Baris (token, waktu) duplikat yang lolos: {stats['duplicate_rows']} (harus 0, dicegah constraint)")
    lines.append(f"Baris observed_at NULL: {stats['null_observed_at']} (harus 0)")
    lines.append(f"Baris token_address NULL: {stats['null_token_address']} (harus 0)")
    lines.append(f"Baris signal_type NULL: {stats['null_signal_type']}")
    lines.append("")
    lines.append("6️⃣ OUTCOME LINKAGE")
    lines.append(f"Token telemetry yang punya baris signal_outcomes: {stats['linked_tokens']}")
    lines.append(f"...yang outcome-nya SUDAH final (menang atau cukup lama diobservasi): {stats['resolvable_tokens']}")
    lines.append(f"Winners (reached 2X): {stats['winners']}")
    lines.append(f"Losers (final, belum 2X): {stats['resolvable_tokens'] - stats['winners']}")
    lines.append("")
    lines.append("7️⃣ DATABASE IMPACT")
    lines.append(f"Ukuran file database total: {stats['db_size_mb']:.2f} MB")
    if stats['oldest_observed_at']:
        lines.append(f"Observasi paling lama: {stats['oldest_observed_at']}")
        lines.append(f"Observasi paling baru: {stats['newest_observed_at']}")
    await update.message.reply_text("\n".join(lines))

    # ---- Pesan 2: Field coverage keseluruhan ----
    lines2 = ["2️⃣ FIELD COVERAGE — KESELURUHAN", f"(dari {stats['total_rows']} baris)", ""]
    for field in fields_to_check:
        non_null = stats["coverage_all"].get(field, 0)
        pct = (non_null / stats["total_rows"] * 100) if stats["total_rows"] else 0
        lines2.append(f"{field}: {non_null}/{stats['total_rows']} ({pct:.1f}%)")
    await update.message.reply_text("\n".join(lines2))

    # ---- Pesan 3: Field coverage EBC ----
    lines3 = ["3️⃣ FIELD COVERAGE — KHUSUS EBC", f"(dari {stats['ebc_rows']} baris EBC)", ""]
    for field in fields_to_check:
        non_null = stats["coverage_ebc"].get(field, 0)
        pct = (non_null / stats["ebc_rows"] * 100) if stats["ebc_rows"] else 0
        lines3.append(f"{field}: {non_null}/{stats['ebc_rows']} ({pct:.1f}%)")
    lines3.append("")
    lines3.append("Field yang KONSISTEN 0% di EBC itu memang TIDAK tersedia dari pump.fun")
    lines3.append("(dikonfirmasi via riset Phase 11A) -- bukan bug, sesuai desain.")
    await update.message.reply_text("\n".join(lines3))

    # ---- Pesan 4: Field coverage DEX ----
    lines4 = ["3️⃣b FIELD COVERAGE — KHUSUS DEX", f"(dari {stats['dex_rows']} baris DEX)", ""]
    for field in fields_to_check:
        non_null = stats["coverage_dex"].get(field, 0)
        pct = (non_null / stats["dex_rows"] * 100) if stats["dex_rows"] else 0
        lines4.append(f"{field}: {non_null}/{stats['dex_rows']} ({pct:.1f}%)")
    lines4.append("")
    lines4.append("5️⃣ PRODUCTION HEALTH (429/RPC-error/polling failure) — TIDAK ADA di database,")
    lines4.append("cuma ada di Deploy Logs. Cari kata ini manual di Railway:")
    lines4.append("• \"Phase 11A: gagal proses/tulis\" — gagal tulis behavioral telemetry")
    lines4.append("• \"pump.fun per-token rate-limited\" — kena 429 pas polling aktif EBC")
    lines4.append("• \"Gagal ambil data batch buat milestone\" — gagal fetch DexScreener")
    await update.message.reply_text("\n".join(lines4))

    # ---- Pesan 5: Field coverage kategori "lainnya" (kalau ada) ----
    if stats["other_rows"] > 0:
        lines5 = ["3️⃣c FIELD COVERAGE — LAINNYA/TIDAK DIKENAL", f"(dari {stats['other_rows']} baris)", ""]
        for field in fields_to_check:
            non_null = stats["coverage_other"].get(field, 0)
            pct = (non_null / stats["other_rows"] * 100) if stats["other_rows"] else 0
            lines5.append(f"{field}: {non_null}/{stats['other_rows']} ({pct:.1f}%)")
        await update.message.reply_text("\n".join(lines5))


async def cleanup_telemetry(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Bugfix PRODUKSI DARURAT -- volume Railway penuh 99%, bot crash
    "database or disk is full". Command admin-only buat menjalankan
    SEKARANG pembersihan satu-kali yang DISETUJUI EKSPLISIT product owner
    (biaya upgrade volume tidak memungkinkan saat ini) -- hapus SEMUA
    baris behavioral_telemetry yang signal_type-nya di luar 4 jenis valid
    ('UNKNOWN' dkk, token yang TIDAK PUNYA signal_snapshots sama sekali,
    TIDAK PERNAH BISA disambungkan ke outcome, nilai risetnya NOL).

    TIDAK menyentuh data EBC/DEX/PROMOTED yang MASIH ada nilai risetnya --
    cuma kategori yang sudah dikonfirmasi (lewat /phase11audit) sebagai
    sampah murni.

    Retensi BERKELANJUTAN (default 3 hari -- diperpendek dari rencana awal
    14 hari, sementara, sampai SolRadar termonetisasi & mampu upgrade
    volume Railway -- lihat database.py buat detail lengkap. Otomatis,
    TIDAK perlu command manual lagi ke depannya) diurus TERPISAH lewat
    job harian -- lihat prune_old_behavioral_telemetry() di database.py
    & job terjadwalnya.

    BUGFIX KEDUA (laporan user: batch 500 baris SENDIRI masih gagal --
    disk BENERAN 0 byte sisa) -- batch default diturunkan drastis jadi
    20, dan sekarang bisa dikecilkan lebih lanjut lewat argumen manual,
    mis. /cleanuptelemetry 5 -- makin kecil batch-nya, makin sedikit
    ruang sementara yang dibutuhkan buat catatan WAL per putaran.
    """
    if not _is_admin(update):
        return
    batch_size = 20
    if context.args:
        try:
            batch_size = max(1, int(context.args[0]))
        except ValueError:
            await update.message.reply_text("Format salah -- contoh: /cleanuptelemetry 5 (angka batch, makin kecil makin aman di disk kritis).")
            return
    await update.message.reply_text(
        f"⏳ Membersihkan telemetry {batch_size} baris per putaran (biar tetap "
        f"aman walau disk hampir penuh) -- mungkin makan waktu beberapa puluh detik..."
    )
    try:
        deleted = await asyncio.to_thread(db.cleanup_unlinkable_behavioral_telemetry, batch_size)
    except Exception as e:
        await update.message.reply_text(
            f"⚠️ Gagal membersihkan telemetry (batch={batch_size}): {e}\n\n"
            f"Coba batch lebih kecil, mis. /cleanuptelemetry {max(1, batch_size // 4)} , "
            f"atau /walcheckpoint dulu buat coba bebasin sedikit ruang."
        )
        return
    await update.message.reply_text(
        f"✅ {deleted:,} baris behavioral_telemetry (kategori 'lainnya/tidak dikenal', "
        f"nilai riset nol) berhasil dihapus. Data EBC/DEX/PROMOTED TIDAK disentuh.\n\n"
        f"CATATAN: ini membebaskan ruang LOGIS di dalam file database (bisa dipakai "
        f"ulang buat tulisan baru) -- persentase volume di Railway BISA SAJA belum "
        f"langsung turun, tapi bot seharusnya berhenti crash 'disk full'."
    )


async def disk_usage(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Diagnostik admin-only, READ-ONLY -- laporan user: Railway bilang
    volume 80% terpakai dari 1GB (~800MB), tapi ukuran file database
    utama (dari /phase11audit) cuma ~428MB dan /walcheckpoint melaporkan
    WAL sudah nyaris kosong (0 frame). Ada selisih ~370MB yang belum
    terjelaskan dari file database + WAL saja.

    Command ini me-list SEMUA file di folder yang sama dengan database
    (termasuk file -wal/-shm SQLite, dan APA PUN LAIN yang mungkin ada di
    situ -- backup lama, file yang ketinggalan dari implementasi
    sebelumnya, dll) beserta ukurannya, supaya selisih itu bisa
    diidentifikasi PERSIS alih-alih ditebak-tebak terus.
    """
    if not _is_admin(update):
        return
    try:
        folder = os.path.dirname(os.path.abspath(db.DB_PATH)) or "."
        entries = []
        total_size = 0
        for name in os.listdir(folder):
            full_path = os.path.join(folder, name)
            if os.path.isfile(full_path):
                size = os.path.getsize(full_path)
                entries.append((name, size))
                total_size += size
        entries.sort(key=lambda x: x[1], reverse=True)
    except Exception as e:
        await update.message.reply_text(f"⚠️ Gagal baca folder: {e}")
        return

    lines = [f"📁 Isi folder: {folder}", ""]
    for name, size in entries:
        lines.append(f"  • {name}: {size / 1024 / 1024:.2f} MB")
    lines.append("")
    lines.append(f"TOTAL semua file di folder ini: {total_size / 1024 / 1024:.2f} MB")
    await update.message.reply_text("\n".join(lines))


async def wal_checkpoint_now(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Bugfix PRODUKSI DARURAT -- disk BENERAN 0 byte sisa. Command admin-only
    buat coba PRAGMA wal_checkpoint(TRUNCATE) SEKARANG -- menggabungkan
    isi file WAL (termasuk sisa-sisa upaya DELETE yang gagal di tengah
    jalan sebelumnya) kembali ke file utama & mengecilkan file WAL itu
    sendiri. Ada kemungkinan (tidak dijamin) ini membebaskan sedikit
    ruang TANPA butuh ruang tambahan -- coba SEBELUM /cleanuptelemetry
    kalau batch sekecil apa pun masih gagal "disk is full".
    """
    if not _is_admin(update):
        return
    try:
        result = await asyncio.to_thread(db.try_wal_checkpoint)
    except Exception as e:
        await update.message.reply_text(f"⚠️ Gagal checkpoint: {e}")
        return
    await update.message.reply_text(f"🔧 {result}")


async def prune_now(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Bugfix PRODUKSI DARURAT -- retensi harian (prune_behavioral_telemetry_job)
    cuma jalan OTOMATIS 1x sehari jam 3 pagi UTC. Kalau admin baru saja
    menurunkan BEHAVIORAL_TELEMETRY_RETENTION_DAYS (mis. dari 14 ke 3 hari,
    demi menghemat volume Railway yang mepet) dan butuh efeknya LANGSUNG
    (bukan nunggu sampai jadwal otomatis berikutnya), command ini
    menjalankan prune_old_behavioral_telemetry() SEKARANG JUGA, admin-only.

    Dihapus per-batch kecil (sama seperti cleanup_unlinkable_behavioral_telemetry())
    -- aman dipanggil walau disk sedang kritis. Batch bisa dikecilkan
    manual lewat argumen, mis. /prunenow 5, kalau default masih gagal
    "disk is full" di kondisi disk yang BENAR-BENAR nol sisa.
    """
    if not _is_admin(update):
        return
    batch_size = 20
    if context.args:
        try:
            batch_size = max(1, int(context.args[0]))
        except ValueError:
            await update.message.reply_text("Format salah -- contoh: /prunenow 5 (angka batch, makin kecil makin aman di disk kritis).")
            return
    await update.message.reply_text(
        f"⏳ Menjalankan retensi ({db.BEHAVIORAL_TELEMETRY_RETENTION_DAYS} hari), "
        f"{batch_size} baris per putaran, SEKARANG (mungkin makan waktu beberapa puluh detik)..."
    )
    try:
        deleted = await asyncio.to_thread(db.prune_old_behavioral_telemetry, db.BEHAVIORAL_TELEMETRY_RETENTION_DAYS, batch_size)
    except Exception as e:
        await update.message.reply_text(
            f"⚠️ Gagal menjalankan retensi (batch={batch_size}): {e}\n\n"
            f"Coba batch lebih kecil, mis. /prunenow {max(1, batch_size // 4)} , "
            f"atau /walcheckpoint dulu buat coba bebasin sedikit ruang."
        )
        return
    await update.message.reply_text(
        f"✅ {deleted:,} baris behavioral_telemetry yang lebih tua dari "
        f"{db.BEHAVIORAL_TELEMETRY_RETENTION_DAYS} hari berhasil dihapus.\n\n"
        f"CATATAN: sama seperti /cleanuptelemetry -- ini membebaskan ruang LOGIS "
        f"di dalam file, persentase Railway bisa saja belum langsung turun."
    )


async def intelreport(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Intelligence V1 -- laporan admin-only, READ-ONLY: "aktivitas seperti
    apa yang beneran berkorelasi sama outcome bagus?" Menjawab pakai
    telemetri EBC Phase 10B (velocity/akselerasi NET SOL reserve, BUKAN
    volume) + data DEX yang sudah lengkap sejak Phase 8/9 (volume, B/S,
    proksi akselerasi harga).

    PENTING: murni evidence. TIDAK ADA satu pun angka di sini yang
    otomatis masuk SR Score/kriteria/eligibility -- itu keputusan
    manusia terpisah, kapan pun nanti diputuskan.

    TIDAK diekspos ke user biasa -- admin-only, sama seperti /autopsy.
    """
    if not _is_admin(update):
        return

    ebc_data = db.get_ebc_activity_with_outcomes()
    ebc_rows = ae.build_ebc_derived_rows(
        ebc_data,
        compute_velocity=trending.compute_reserve_velocity_per_minute,
        compute_mc_velocity=trending.compute_market_cap_velocity_per_minute,
        compute_bonding_velocity=trending.compute_bonding_progress_velocity_per_minute,
        compute_acceleration=trending.compute_reserve_acceleration,
    )
    dex_rows = [r for r in db.get_autopsy_dataset() if r["signal_type"] in ("NEW_PAIR", "NEW_TRENDING")]
    report = ae.run_intelligence_v1_report(ebc_rows, dex_rows)

    def pct(x):
        return f"{x * 100:.1f}%" if x is not None else "n/a"

    def render_section(lines, title, section):
        lines.append(title)
        if section["status"] == "LOW_SAMPLE":
            lines.append(f"  LOW_SAMPLE (n_present={section['n_present']}, belum cukup data buat dianalisis jujur)")
            lines.append("")
            return
        lines.append(f"  stability antar-periode: {section['stability']}")
        lines.append("  bucket | n | 2X | 3X | 5X")
        for b in section["buckets"]:
            lines.append(f"  {b['bucket']} | {b['n']} | {pct(b['rate_2x'])} | {pct(b['rate_3x'])} | {pct(b['rate_5x'])}")
        lines.append("")

    lines = [
        "🧠 Intelligence V1 — Activity vs Outcome (READ-ONLY, admin)",
        "",
        f"Sampel EBC (token dgn telemetri Phase 10B + outcome siap nilai): {report['ebc_sample_size']}",
        f"Sampel DEX (NEW_PAIR + NEW_TRENDING): {report['dex_sample_size']}",
        "",
        "⚠️ EBC: telemetri retensinya cuma 30 menit -- dataset ini SECARA",
        "STRUKTURAL bias ke token yang nasibnya cepat ketahuan, bukan semua EBC.",
        "",
    ]
    render_section(lines, "📈 EBC NET RESERVE CHANGE / MENIT (lamport)", report["ebc_reserve_velocity"])
    render_section(lines, "🚀 EBC RESERVE ACCELERATION (lamport/menit)", report["ebc_reserve_acceleration"])
    render_section(lines, "📊 EBC BONDING VELOCITY (%/menit)", report["ebc_bonding_velocity"])
    render_section(lines, "💰 EBC MARKET CAP VELOCITY ($/menit)", report["ebc_mc_velocity"])
    render_section(lines, "💧 DEX VOLUME 5M ($)", report["dex_volume_m5"])
    render_section(lines, "⚖️ DEX BUY/SELL PRESSURE (-1..+1, bukan volume)", report["dex_buy_sell_pressure"])
    render_section(lines, "⚡ DEX PRICE ACCELERATION (proksi, 5m vs rata-rata 1h)", report["dex_price_acceleration"])
    lines.append("Semua di atas evidence read-only -- BELUM ada yang dipromosikan ke SR Score/kriteria/eligibility.")

    await _send_chunked(update, lines)


async def global_error_handler(update: object, context: ContextTypes.DEFAULT_TYPE):
    """
    Kalau ada exception di handler mana pun (start, ads, promote, dll),
    python-telegram-bot defaultnya cuma DIAM -- user nggak dapat respons
    apa pun, dan kita nggak lihat apa-apa tanpa gali log Railway manual.
    Sekarang setiap error otomatis dicatat ke log ("EXCEPTION_CAUGHT",
    gampang di-grep) DAN dikirim langsung ke admin lewat Telegram.
    """
    logger.error("EXCEPTION_CAUGHT", exc_info=context.error)
    if ADMIN_CHAT_ID:
        try:
            tb_string = "".join(
                traceback.format_exception(None, context.error, context.error.__traceback__)
            )
            await context.bot.send_message(
                ADMIN_CHAT_ID,
                f"⚠️ Bot error:\n<pre>{html.escape(tb_string[-3500:])}</pre>",
                parse_mode=ParseMode.HTML,
            )
        except Exception:
            pass  # jangan sampai error-handler-nya sendiri ikut crash


async def pause_bot(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Pause posting alert baru (buat maintenance) -- bot TETAP hidup & bisa dipakai command lain."""
    if not _is_admin(update):
        return
    db.set_state("paused", "1")
    await update.message.reply_text("⏸️ Alert baru DI-PAUSE. Command admin lain tetap jalan normal. Ketik /resume kalau udah selesai.")


async def resume_bot(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Lanjutkan lagi posting alert setelah di-pause."""
    if not _is_admin(update):
        return
    db.set_state("paused", "0")
    await update.message.reply_text("▶️ Alert baru DILANJUTKAN lagi.")


def _is_paused() -> bool:
    return db.get_state("paused") == "1"


async def exportdb(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Kirim file database SQLite langsung ke admin lewat Telegram sebagai
    dokumen -- cara paling gampang buat "download" file dari Railway,
    nggak perlu Railway CLI atau akses volume manual.
    """
    if not _is_admin(update):
        return
    if not os.path.exists(db.DB_PATH):
        await update.message.reply_text(f"File database nggak ketemu di path `{db.DB_PATH}`.", parse_mode=ParseMode.MARKDOWN)
        return
    try:
        with open(db.DB_PATH, "rb") as f:
            await update.message.reply_document(
                document=f,
                filename="bot_data.db",
                caption=f"Database export -- {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}",
            )
    except Exception as e:
        await update.message.reply_text(f"Gagal kirim file: {e}")


async def health(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Lihat kapan tiap job otomatis terakhir jalan, dan apakah ada error."""
    if not _is_admin(update):
        return

    lines = ["🩺 *Bot Health*\n"]

    if not JOB_STATUS:
        lines.append("No job runs recorded yet (bot might have just started).\n")
    else:
        now = datetime.now(timezone.utc)
        for name, info in sorted(JOB_STATUS.items()):
            ago = int((now - info["last_run"]).total_seconds())
            status = "✅ OK" if not info["last_error"] else f"⚠️ {info['last_error'][:80]}"
            duration = info.get("duration_seconds")
            duration_text = f" (durasi: {duration:.1f}s)" if duration is not None else ""
            lines.append(f"• `{name}`: {ago}s ago{duration_text} — {status}")

    stats = db.get_tracking_stats()
    lines.append(
        f"\n📊 *Tracking*\n"
        f"Total alerted: {stats['total_alerted']}\n"
        f"Being tracked (milestone/ATH): {stats['tracked']}\n"
        f"⚠️ Stuck at $0 baseline (NOT tracked): {stats['untracked_zero_baseline']}\n"
        f"Reached 2x+: {stats['milestone_2x_plus']}"
    )

    await update.message.reply_text("\n".join(lines), parse_mode=ParseMode.MARKDOWN)


async def setcriteria(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Ubah threshold kriteria langsung dari Telegram, tanpa edit kode / restart."""
    if not _is_admin(update):
        return

    if len(context.args) != 2:
        lines = ["Current criteria:\n"]
        for key, (attr, _) in CRITERIA_MAP.items():
            line = f"• `{key}` = {getattr(trending, attr)}"
            if key == "risky_min_mcap" and trending.RISKY_MIN_MARKET_CAP_SOL_LAMPORTS is not None:
                line += f" (dibekukan ≈{trending.RISKY_MIN_MARKET_CAP_SOL_LAMPORTS / 1e9:.2f} SOL)"
            elif key == "risky_max_mcap" and trending.RISKY_MAX_MARKET_CAP_SOL_LAMPORTS is not None:
                line += f" (dibekukan ≈{trending.RISKY_MAX_MARKET_CAP_SOL_LAMPORTS / 1e9:.2f} SOL)"
            lines.append(line)
        lines.append("\nUsage: /setcriteria <name> <value>")
        await update.message.reply_text("\n".join(lines), parse_mode=ParseMode.MARKDOWN)
        return

    key, value_str = context.args[0].lower(), context.args[1]
    if key not in CRITERIA_MAP:
        known = ", ".join(f"`{k}`" for k in CRITERIA_MAP)
        await update.message.reply_text(
            f"Unknown criteria `{key}`. Known: {known}", parse_mode=ParseMode.MARKDOWN
        )
        return

    attr, cast = CRITERIA_MAP[key]
    try:
        value = cast(value_str)
    except ValueError:
        await update.message.reply_text("Invalid value — couldn't convert to a number.")
        return

    # Phase 10H -- special-case risky_min_mcap/risky_max_mcap: konversi
    # sekali ke SOL-equivalent (pakai proxy harga SOL yang diturunkan dari
    # data pump.fun yang SUDAH mengalir, BUKAN price-feed baru) supaya
    # ambang ini TETAP merepresentasikan jumlah SOL yang sama walau harga
    # SOL bergerak naik/turun ke depannya -- laporan user soal ambang
    # dolar statis yang "melemah" seiring harga SOL naik.
    if key in ("risky_min_mcap", "risky_max_mcap"):
        sol_price = trending.get_sol_price_proxy()
        if sol_price is None or sol_price <= 0:
            await update.message.reply_text(
                "⚠️ Belum ada data harga SOL yang cukup buat konversi (bot perlu "
                "memproses minimal 1 token EBC dgn reserves > 1 SOL dulu). Coba lagi sebentar lagi."
            )
            return
        lamports = int((value / sol_price) * 1_000_000_000)
        lamports_attr = "RISKY_MIN_MARKET_CAP_SOL_LAMPORTS" if key == "risky_min_mcap" else "RISKY_MAX_MARKET_CAP_SOL_LAMPORTS"
        setattr(trending, lamports_attr, lamports)
        setattr(trending, attr, value)  # tetap simpan versi USD-nya juga, buat referensi/display saja
        db.set_state(f"criteria:{key}", str(value))
        db.set_state(f"criteria:{key}_sol_lamports", str(lamports))
        sol_amount = lamports / 1_000_000_000
        await update.message.reply_text(
            f"✅ `{key}` diset ke ${value:,.0f} (≈{sol_amount:.2f} SOL di harga saat ini ~${sol_price:,.2f}/SOL).\n\n"
            f"Mulai sekarang ambang ini dibandingkan sebagai *{sol_amount:.2f} SOL* di curve, "
            f"BUKAN dolar tetap -- jadi otomatis tetap relevan walau harga SOL berubah nanti.",
            parse_mode=ParseMode.MARKDOWN,
        )
        return

    setattr(trending, attr, value)
    db.set_state(f"criteria:{key}", str(value))
    await update.message.reply_text(f"✅ `{key}` ({attr}) updated to {value}", parse_mode=ParseMode.MARKDOWN)


# ---------- Fungsi bantu: bangun keyboard + kirim ke channel & subscriber DM ----------

def _build_keyboard(pair: dict) -> InlineKeyboardMarkup:
    rows = trending.build_trade_buttons(pair)
    keyboard = [
        [InlineKeyboardButton(label, url=url) for label, url in row]
        for row in rows
    ]
    return InlineKeyboardMarkup(keyboard)


# Milestone yang dapat tombol "Generate PnL Card" -- SESUAI dgn kolom
# time_to_Xx_minutes yang benar-benar ada di signal_outcomes (Finalization
# Sprint bagian 2/3). Cuma milestone >= 10 (poin 3 brief: "Do not expose
# the button for tokens that have not reached 10X").
PNL_CARD_ELIGIBLE_MILESTONES = (10.0, 20.0, 50.0, 100.0)


def _build_milestone_keyboard(pair: dict, token_address: str, multiplier: float) -> InlineKeyboardMarkup:
    """
    Sama seperti _build_keyboard(), DITAMBAH 1 baris tombol
    "Generate PnL Card" KALAU DAN CUMA KALAU multiplier ini >= 10 (milestone
    kecil seperti 1.5x/2x/3x/5x TIDAK dapat tombol ini sama sekali).

    callback_data berisi token_address & multiplier PERSIS milestone yang
    memicu pesan ini (bukan "current ATH") -- jadi tombol 10X akan SELALU
    generate kartu 10X, walau tokennya belakangan naik lebih tinggi lagi;
    tombol 20X (kalau/waktu muncul terpisah nanti) generate kartu 20X
    sendiri (poin 9 brief: "20X card even if it previously generated a
    10X card").
    """
    base_rows = list(_build_keyboard(pair).inline_keyboard)
    if multiplier in PNL_CARD_ELIGIBLE_MILESTONES:
        # Format callback_data: "pnlcard:<token_address>:<multiplier>" --
        # dites eksplisit tetap di bawah batas 64 byte Telegram (alamat
        # Solana terpanjang ~44 char + prefix + multiplier masih aman).
        callback_data = f"pnlcard:{token_address}:{multiplier:g}"
        base_rows = base_rows + [[InlineKeyboardButton("📸 Generate PnL Card", callback_data=callback_data)]]
    return InlineKeyboardMarkup(base_rows)


def _milestone_time_column(multiplier: float):
    """Peta multiplier -> nama kolom time_to_Xx_minutes yang BENERAN ada
    di signal_outcomes. Return None kalau multiplier bukan salah satu
    dari 4 milestone yang dapat tombol kartu (tidak boleh nebak kolom yang
    tidak ada)."""
    mapping = {10.0: "time_to_10x_minutes", 20.0: "time_to_20x_minutes",
               50.0: "time_to_50x_minutes", 100.0: "time_to_100x_minutes"}
    return mapping.get(multiplier)


async def pnlcard_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Callback tombol "📸 Generate PnL Card" -- generate kartu PNG deterministik
    (pnl_card.py, Pillow) dari data outcome yang SUDAH ADA, kirim sebagai
    foto balasan. TIDAK PERNAH klaim PnL personal user -- wording SELALU
    "X since SolRadar signal" (lihat pnl_card.py utk aturan lengkap).

    Manual generate TETAP jalan biarpun notifikasi milestone otomatisnya
    sudah lama terkirim (poin 9 brief) -- tombol ini murni baca data
    TERKINI dari DB tiap kali diklik, tidak bergantung status kirim
    sebelumnya sama sekali.
    """
    query = update.callback_query
    try:
        await query.answer()
    except Exception:
        pass

    try:
        _, token_address, multiplier_str = query.data.split(":", 2)
        multiplier = float(multiplier_str)
    except (ValueError, AttributeError, TypeError):
        logger.warning(f"pnlcard callback_data tidak valid: {query.data!r}")
        return

    try:
        row = db.get_milestone_card_data(token_address)
    except Exception as e:
        logger.warning(f"Gagal ambil data PnL card utk {token_address}: {e}")
        return

    if not row or not row["baseline_market_cap"] or row["baseline_market_cap"] <= 0:
        try:
            await context.bot.send_message(query.message.chat_id, "⚠️ Data token belum cukup buat generate kartu.",
                                            reply_to_message_id=query.message.message_id)
        except Exception:
            pass
        return

    # Safety check -- jangan generate kartu buat milestone yang BELUM
    # beneran tercapai token ini (jaga-jaga data/tombol basi/salah kirim).
    if (row["last_milestone"] or 0) < multiplier:
        try:
            await context.bot.send_message(query.message.chat_id, "⚠️ Milestone ini belum tercapai untuk token ini.",
                                            reply_to_message_id=query.message.message_id)
        except Exception:
            pass
        return

    time_col = _milestone_time_column(multiplier)
    time_to_ms = row[time_col] if time_col else None

    card_data = {
        "symbol": row["token_symbol"] or "???",
        "name": row["token_name"] or "Unknown",
        "multiplier": multiplier,
        "baseline_market_cap": row["baseline_market_cap"],
        "milestone_market_cap": row["baseline_market_cap"] * multiplier,
        "signal_type": row["signal_type"],
        "time_to_milestone_minutes": time_to_ms,
        "contract_address": token_address,
    }

    mult_label = f"{multiplier:g}X"
    output_path = f"/tmp/pnlcard_{token_address}_{int(multiplier)}.png"
    try:
        pnl_card.render_milestone_card(card_data, output_path)
        with open(output_path, "rb") as f:
            await context.bot.send_photo(
                chat_id=query.message.chat_id,
                photo=f,
                caption=f"🚀 {mult_label} since SolRadar signal\n\n${card_data['symbol']}",
                reply_to_message_id=query.message.message_id,
            )
    except Exception as e:
        logger.warning(f"Gagal generate/kirim PnL card {token_address} ({mult_label}): {e}")
        try:
            await context.bot.send_message(query.message.chat_id, "⚠️ Gagal generate kartu, coba lagi nanti.",
                                            reply_to_message_id=query.message.message_id)
        except Exception:
            pass
    finally:
        try:
            os.remove(output_path)
        except OSError:
            pass


async def _send_one(bot, chat_id, text, reply_markup=None, image_url=None, reply_to_message_id=None):
    """
    Kirim 1 pesan ke 1 chat. Coba pakai foto (logo token) kalau ada URL-nya,
    fallback ke teks biasa kalau foto gagal (link mati, dsb). reply_to_message_id
    cuma dipakai kalau target-nya masih valid — kalau gagal, dicoba ulang tanpa itu.
    """
    kwargs = {"parse_mode": ParseMode.MARKDOWN}
    if reply_markup is not None:
        kwargs["reply_markup"] = reply_markup

    def _with_reply(extra):
        merged = dict(kwargs)
        merged.update(extra)
        if reply_to_message_id is not None:
            merged["reply_to_message_id"] = reply_to_message_id
        return merged

    if image_url:
        try:
            return await bot.send_photo(chat_id, photo=image_url, caption=text, **_with_reply({}))
        except Exception as e:
            logger.warning(f"send_photo failed ({e}), falling back to text")

    try:
        return await bot.send_message(chat_id, text, **_with_reply({}))
    except Exception as e:
        if reply_to_message_id is not None:
            logger.warning(f"Send with reply_to failed ({e}), retrying without it")
            try:
                return await bot.send_message(chat_id, text, **kwargs)
            except Exception as e2:
                logger.warning(f"Failed to send message to {chat_id}: {e2}")
                return None
        logger.warning(f"Failed to send message to {chat_id}: {e}")
        return None


async def broadcast(app: Application, msg: str, reply_markup=None, image_url=None, reply_to_message_id=None):
    """
    Kirim ke channel SAJA (dengan dukungan foto + reply-chain). Alert
    SENGAJA tidak lagi dikirim ke DM subscriber mana pun -- satu-satunya
    cara dapat alert adalah join channel-nya langsung. Ini keputusan
    produk: subscriber count channel jadi social proof yang keliatan
    publik, dan bot ini direservasi khusus buat advertiser order promosi.
    Return objek Message hasil post ke channel (buat disimpan message_id-nya).
    """
    return await _send_one(
        app.bot, CHANNEL_ID, msg, reply_markup, image_url, reply_to_message_id
    )


def _compute_initial_milestone(baseline_mc: float, ath_mc: float) -> float:
    """
    Kalau ATH awal (dari histori candle, lihat trending.compute_initial_ath)
    sudah lebih tinggi dari baseline — misal token LAMA yang sempat viral
    jauh sebelum kita alert — catat level itu SEBAGAI milestone yang
    "sudah diketahui sejak awal", bukan dibiarkan default 1.0.

    Kalau ini dilewatkan (dibiarkan default), check_milestones_job bakal
    salah kira histori lama sebagai "baru aja naik" pas dia jalan
    pertama kali — bug lucu yang bikin bot ngaku "udah naik 50x!" cuma
    1 menit setelah alert pertama, padahal itu ATH lama yang emang udah
    ada dari dulu, bukan kenaikan beneran sejak kita call.
    """
    if not baseline_mc or baseline_mc <= 0 or not ath_mc or ath_mc <= baseline_mc:
        return 1.0
    implied_multiple = ath_mc / baseline_mc
    crossed = [m for m in trending.MILESTONES if m <= implied_multiple]
    return max(crossed) if crossed else 1.0


async def _refresh_pair_for_posting(pair: dict, token_address: str) -> float:
    """
    SELALU coba ambil data PALING FRESH dari DexScreener sesaat sebelum
    pesan diposting — bukan cuma kalau datanya kosong. Ini penting karena
    antara token pertama kali ketemu (discovery) sampai pesan BENERAN
    dikirim, ada beberapa proses yang makan waktu (cek safety, cek LP
    lock ke RugCheck, ambil ATH dari GeckoTerminal) — market cap yang
    ditampilkan harus mencerminkan detik alert itu MUNCUL, bukan detik
    token itu PERTAMA KALI ketemu beberapa saat sebelumnya.

    Update field numerik utama di `pair` langsung (in-place) supaya
    format_alert_message() otomatis pakai angka yang paling baru. Field
    lain yang sudah nempel di `pair` (imageUrl, socialLinks, info safety,
    dll) TETAP dipertahankan dari hasil discovery — cuma angka yang
    berubah cepat yang di-refresh di sini.

    Return market cap TERBARU (dipakai sebagai baseline yang disimpan).
    """
    fresh_pair = await asyncio.to_thread(trending.get_pair_data, token_address)
    if fresh_pair:
        mc = fresh_pair.get("marketCap") or fresh_pair.get("fdv") or 0
        if mc and mc > 0:
            pair["marketCap"] = fresh_pair.get("marketCap")
            pair["fdv"] = fresh_pair.get("fdv")
            pair["priceUsd"] = fresh_pair.get("priceUsd")
            pair["volume"] = fresh_pair.get("volume")
            pair["liquidity"] = fresh_pair.get("liquidity")
            pair["priceChange"] = fresh_pair.get("priceChange")
            # Phase 9: `txns` (buys/sells m5+h1) DULU TIDAK ikut disinkron di
            # sini -- padahal fresh_pair (DexScreener, SUDAH di-fetch tepat
            # di baris ini, BUKAN request baru) punya data itu. Akibatnya
            # signal_snapshots menyimpan txns dari waktu DISCOVERY (basi
            # sejauh proses safety-check/LP-lock/ATH tadi makan waktu),
            # bukan dari detik alert BENERAN diposting -- padahal marketCap/
            # volume/liquidity/priceChange di baris atas SUDAH benar pakai
            # data ter-fresh. Utamanya buat tier NEW_PAIR: token yang BARU
            # BANGET, txns.m5 di titik discovery seringkali masih kosong
            # (DexScreener belum sempat catat transaksi), tapi begitu
            # sampai ke titik posting ini (beberapa detik/menit kemudian)
            # datanya seringkali SUDAH ada -- fix ini menangkap data yang
            # 'baru muncul' itu, bukan cuma soal freshness semata.
            pair["txns"] = fresh_pair.get("txns") or pair.get("txns")
            return mc
        logger.warning(f"Market cap kosong saat refresh {token_address}, pakai data discovery yang lama.")

    # fallback: DexScreener belum sempat index / gagal fetch -> pakai
    # data dari waktu discovery apa adanya
    return pair.get("marketCap") or pair.get("fdv") or 0


def _capture_signal_snapshot(pair: dict, signal_type: str, signal_source: str):
    """Capture features immediately before an alert is posted.

    This is intentionally an observation layer only: it does not change
    eligibility/scoring and it must run before the outcome is known.

    Phase 5A -- setiap panggilan sekarang tercatat ke snapshot_telemetry
    (PERSISTEN, bukan in-memory) sebagai attempt/success/failure. Sebelumnya
    kegagalan di sini cuma jadi 1 baris log yang hilang begitu restart --
    sekarang bisa dilihat lewat /autopsy berapa kali & KENAPA gagal per tier.
    """
    db.record_snapshot_attempt(signal_type)
    try:
        base = pair.get("baseToken") or {}
        address = base.get("address")
        if not address:
            db.record_snapshot_failure(signal_type, "source_unavailable")
            return

        volume = pair.get("volume") or {}
        price_change = pair.get("priceChange") or {}
        txns = pair.get("txns") or {}
        m5_txns = txns.get("m5") or {}
        h1_txns = txns.get("h1") or {}
        socials = pair.get("socialLinks") or {}

        created_ms = pair.get("pairCreatedAt")
        age_minutes = None
        if created_ms:
            try:
                age_minutes = max(0.0, (datetime.now(timezone.utc).timestamp() * 1000 - float(created_ms)) / 60000.0)
            except (TypeError, ValueError):
                pass

        # Phase 4F -- SR Score v0, SHADOW MODE SAJA. Dihitung dari 3 fitur
        # yang SUDAH TERSEDIA di titik ini (age_minutes, holder_count,
        # bonding_curve_progress) -- TIDAK ada RPC/computation tambahan,
        # TIDAK mempengaruhi keputusan alert apa pun, cuma disimpan buat
        # riset. Lihat trending.compute_sr_score_v0() buat detail aturan
        # & kenapa NULL-handling-nya sengaja begitu.
        sr_score_result = trending.compute_sr_score_v0(
            bonding_curve_progress=pair.get("_progress_pct"),
            token_age_minutes=age_minutes,
            holder_count=pair.get("_holder_count"),
        )

        # Phase 6 -- SR Score v1, SHADOW MODE (v0 di atas TIDAK disentuh).
        # Dihitung dari data yang SAMA PERSIS yang sudah tersedia di titik
        # ini (tidak ada RPC/API call tambahan). Lihat trending.compute_sr_score_v1
        # untuk breakdown komponen & rasionalnya.
        socials_for_v1 = pair.get("socialLinks") or {}
        sr_v1_result = trending.compute_sr_score_v1(
            bonding_curve_progress=pair.get("_progress_pct"),
            token_age_minutes=age_minutes,
            market_cap=pair.get("marketCap") or pair.get("fdv"),
            holder_count=pair.get("_holder_count"),
            has_website=True if socials_for_v1.get("website") else (False if socials_for_v1 else None),
            has_twitter=True if socials_for_v1.get("twitter") else (False if socials_for_v1 else None),
            has_telegram=True if socials_for_v1.get("telegram") else (False if socials_for_v1 else None),
            deployer_graduated_count=pair.get("_deployer_graduated_count"),
            mint_authority_active=pair.get("_mint_authority_active"),
            freeze_authority_active=pair.get("_freeze_authority_active"),
            non_pool_concentration_pct=pair.get("_non_pool_concentration_pct"),
        )

        # Intelligent Alert V1 -- SHADOW MODE ONLY (arahan Architect).
        # Dievaluasi dari field PRE-ALERT yang SAMA PERSIS yang sudah
        # tersedia di titik ini (persis input SR Score v1 di atas) --
        # TIDAK ADA RPC/API call tambahan sama sekali. Hasilnya CUMA
        # disimpan buat riset -- TIDAK PERNAH memengaruhi teks alert yang
        # dikirim (format_alert_message() tidak menyentuh fungsi ini sama
        # sekali di fase ini). Kegagalan di sini TIDAK BOLEH menggagalkan
        # penyimpanan snapshot/alert -- dibungkus try/except sendiri.
        intelligence_v1_conditions_json = None
        intelligence_v1_features_json = None
        try:
            has_website_for_intel = True if socials_for_v1.get("website") else (False if socials_for_v1 else None)
            intel_result = trending.build_intelligence_summary(
                token_age_minutes=age_minutes,
                holder_count=pair.get("_holder_count"),
                bonding_curve_progress=pair.get("_progress_pct"),
                market_cap=pair.get("marketCap") or pair.get("fdv"),
                has_website=has_website_for_intel,
                deployer_graduated_count=pair.get("_deployer_graduated_count"),
            )
            intelligence_v1_conditions_json = json.dumps(intel_result["conditions"])
            intelligence_v1_features_json = json.dumps(intel_result["features_used"])
        except Exception as e:
            logger.warning(f"Intelligence V1 (shadow) gagal dievaluasi, dilewati (tidak fatal): {e}")

        db.save_signal_snapshot(
            token_address=address,
            alerted_at=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
            signal_type=signal_type,
            signal_source=signal_source,
            market_cap=pair.get("marketCap") or pair.get("fdv") or None,
            liquidity=(pair.get("liquidity") or {}).get("usd"),
            volume_m5=volume.get("m5"), volume_h1=volume.get("h1"), volume_h24=volume.get("h24"),
            price_change_m5=price_change.get("m5"), price_change_h1=price_change.get("h1"),
            price_change_h6=price_change.get("h6"), price_change_h24=price_change.get("h24"),
            buys_m5=m5_txns.get("buys"), sells_m5=m5_txns.get("sells"),
            buys_h1=h1_txns.get("buys"), sells_h1=h1_txns.get("sells"),
            holder_count=pair.get("_holder_count"), top_holder_pct=pair.get("_top_holder_pct"),
            top10_holder_pct=pair.get("_top10_holder_pct"),
            non_pool_concentration_pct=pair.get("_non_pool_concentration_pct"),
            mint_authority_active=pair.get("_mint_authority_active"),
            freeze_authority_active=pair.get("_freeze_authority_active"),
            lp_locked_pct=pair.get("_lp_locked_pct"),
            has_twitter=True if socials.get("twitter") else (False if socials else None),
            has_telegram=True if socials.get("telegram") else (False if socials else None),
            has_website=True if socials.get("website") else (False if socials else None),
            social_replies=pair.get("_reply_count"),
            deployer_token_count=pair.get("_deployer_token_count"),
            deployer_graduated_count=pair.get("_deployer_graduated_count"),
            deployer_address=pair.get("_creator_address"),
            token_age_minutes=age_minutes,
            bonding_curve_progress=pair.get("_progress_pct"),
            # Reserved for CMC/on-chain holder-tag integration in the next phase.
            smart_money_count=pair.get("_smart_money_count"),
            whale_count=pair.get("_whale_count"),
            sniper_count=pair.get("_sniper_count"),
            bot_count=pair.get("_bot_count"),
            insider_count=pair.get("_insider_count"),
            insider_pct=pair.get("_insider_pct"),
            sr_score=sr_score_result["sr_score"],
            sr_score_bonding_progress=sr_score_result["sr_score_bonding_progress"],
            sr_score_token_age=sr_score_result["sr_score_token_age"],
            sr_score_holder_count=sr_score_result["sr_score_holder_count"],
            sr_score_inputs_available=sr_score_result["sr_score_inputs_available"],
            sr_score_v1=sr_v1_result["sr_score_v1"],
            sr_score_v1_confidence=sr_v1_result["sr_score_v1_confidence"],
            sr_score_v1_version=sr_v1_result["sr_score_v1_version"],
            sr_score_v1_early_stage=sr_v1_result["sr_score_v1_early_stage"],
            sr_score_v1_market_context=sr_v1_result["sr_score_v1_market_context"],
            sr_score_v1_social=sr_v1_result["sr_score_v1_social"],
            sr_score_v1_holder=sr_v1_result["sr_score_v1_holder"],
            sr_score_v1_interaction_bonus=sr_v1_result["sr_score_v1_interaction_bonus"],
            sr_score_v1_risk_adjustment=sr_v1_result["sr_score_v1_risk_adjustment"],
            sr_score_v1_bonuses_applied=sr_v1_result["sr_score_v1_bonuses_applied"],
            intelligence_v1_conditions=intelligence_v1_conditions_json,
            intelligence_v1_features=intelligence_v1_features_json,
            intelligence_v1_version=trending.INTELLIGENCE_V1_VERSION,
        )
        db.record_snapshot_success(signal_type)
    except Exception as e:
        # Snapshot failure must NEVER block an otherwise valid alert.
        logger.warning(f"Failed to capture signal snapshot: {e}")
        reason = "database_failure" if isinstance(e, sqlite3.Error) else "exception"
        db.record_snapshot_failure(signal_type, reason)


# ---------- Job otomatis #1: deteksi trending organik, posting ke channel ----------

async def check_trending_job(app: Application):
    if _is_paused():
        return
    logger.info("Checking for new trending tokens...")
    try:
        results = await asyncio.to_thread(trending.find_new_trending_tokens, db.is_already_alerted)
    except Exception as e:
        logger.warning(f"Failed to fetch trending data: {e}")
        _mark_job_run("trending", error=str(e))
        return
    _mark_job_run("trending")

    if not results:
        logger.info("No tokens currently meet the trending criteria.")
        return

    logger.info(f"Found {len(results)} new trending token(s).")
    for pair in results:
        try:
            token_address = pair.get("baseToken", {}).get("address")
            if not token_address or not db.claim_alert_slot(token_address):
                continue  # sudah diklaim tier/job lain di siklus yang nyaris bersamaan
            baseline_mc = await _refresh_pair_for_posting(pair, token_address)
            if not trending.passes_final_sanity_check(pair):
                # Data ter-fresh nunjukkin token ini kemungkinan besar baru kena
                # rug/collapse (di antara discovery & posting). Batalkan posting.
                logger.warning(f"{token_address}: gagal sanity check terakhir (kemungkinan rug baru terjadi), batalkan posting.")
                db.delete_latest_signal_snapshot(token_address)
                db.finalize_alert(token_address, baseline_market_cap=0, last_message_id=None)
                continue
            true_ath = await asyncio.to_thread(trending.compute_initial_ath, pair)
            msg = trending.format_alert_message(pair, ath_market_cap=true_ath)
            _capture_signal_snapshot(pair, "NEW_TRENDING", "dexscreener_boost")
            # Phase 9 (bugfix rasio coverage "398/397" -- lihat /autopsy):
            # DULU record_snapshot_alert_seen() cuma dipanggil kalau
            # broadcast SUKSES, tapi _capture_signal_snapshot() di atas
            # (yang nge-increment snapshot_successes) SELALU jalan duluan
            # TANPA syarat broadcast. Kalau broadcast gagal, kode di bawah
            # cuma hapus BARIS snapshot-nya (delete_latest_signal_snapshot)
            # tapi TIDAK PERNAH mundurin counter snapshot_successes yang
            # sudah kadung ke-+1 -- sementara alerts_seen-nya malah TIDAK
            # PERNAH ke-+1 sama sekali (kena `continue` sebelum sampai ke
            # bawah). Hasilnya snapshot_successes > alerts_seen (rasio
            # >100%, kejadian persis). Fix: catat "alert seen" di titik
            # yang SAMA dengan capture (sebelum tau hasil broadcast),
            # bukan ditunda sampai broadcast sukses -- keduanya sekarang
            # SELALU naik bareng, jadi TIDAK PERNAH bisa lebih dari
            # alerts_seen lagi.
            db.record_snapshot_alert_seen("NEW_TRENDING")
            sent = await broadcast(app, msg, reply_markup=_build_keyboard(pair), image_url=pair.get("imageUrl"))
            if not sent:
                # PENTING: kalau pengiriman gagal (Telegram error/rate-limit sesaat),
                # JANGAN simpan baseline asli -- itu bikin token ini ke-track buat
                # milestone/dex-activity padahal alert-nya sendiri TIDAK PERNAH
                # kelihatan oleh siapa pun (laporan user: $fefer dapat notifikasi
                # "1.5x since we called it" padahal alert awalnya nggak pernah ada).
                logger.warning(f"{token_address}: gagal kirim alert, baseline DIRESET ke 0 (tidak di-track).")
                db.delete_latest_signal_snapshot(token_address)
                db.finalize_alert(token_address, baseline_market_cap=0, last_message_id=None)
                continue
            db.finalize_alert(
                token_address,
                baseline_market_cap=baseline_mc,
                last_message_id=sent.message_id,
                initial_ath=true_ath,
                name=pair.get("baseToken", {}).get("name"),
                symbol=pair.get("baseToken", {}).get("symbol"),
                initial_milestone=_compute_initial_milestone(baseline_mc, true_ath),
            )
            db.init_signal_outcome(token_address, baseline_mc, alerted_at=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"))
        except Exception as e:
            logger.warning(f"Failed to process/post one trending candidate, skipping it: {e}")
            continue


# ---------- Job otomatis #2: cek pembayaran promosi, posting kalau cocok ----------

async def check_ads_job(app: Application):
    """
    Jalan berkala: cek apakah ad yang lagi 'active' udah lewat masa
    tayangnya. Kalau iya, expire-kan, terus otomatis promosikan ad
    berikutnya di antrean (kalau ada) jadi 'active'.
    """
    try:
        expired_id = db.expire_active_ad_if_needed()
    except Exception as e:
        logger.warning(f"Gagal cek status ads: {e}")
        _mark_job_run("ads", error=str(e))
        return
    _mark_job_run("ads")

    if not expired_id:
        return

    logger.info(f"Ad #{expired_id} expired.")
    next_ad = db.get_next_queued_ad()
    if next_ad:
        db.activate_ad(next_ad["id"], next_ad["duration_hours"])
        logger.info(f"Ad #{next_ad['id']} sekarang aktif (dipromosikan dari antrean).")
        if ADMIN_CHAT_ID:
            await app.bot.send_message(
                ADMIN_CHAT_ID,
                f"📢 Ad #{next_ad['id']} is now live (auto-promoted from the queue).",
            )


async def _finalize_paid_promotion(app: Application, promo, signature: str, verified_by: str = "auto"):
    """
    Logic SETELAH promosi dipastikan dibayar -- dipakai BERSAMA oleh
    check_payments_job (deteksi otomatis via RPC) DAN /approvepromo
    (fallback manual admin, arahan audit monetisasi: kalau deteksi
    otomatis gagal karena SEBAB APA PUN, tetap ada jalan keluar selain
    ubah database manual). `verified_by` cuma buat teks notifikasi admin
    (bedain "auto-verified" vs "manually approved oleh admin").
    """
    db.mark_promotion_paid(promo["id"], signature)

    pair = await asyncio.to_thread(trending.get_pair_data, promo["token_address"])
    if not pair:
        logger.warning(f"Promosi #{promo['id']} terbayar tapi data token tidak ditemukan.")
        return False

    token_address = pair.get("baseToken", {}).get("address")
    baseline_mc = await _refresh_pair_for_posting(pair, token_address) if token_address else 0
    if not trending.passes_final_sanity_check(pair):
        logger.warning(f"Promosi #{promo['id']}: gagal sanity check terakhir (kemungkinan rug baru terjadi), batalkan posting.")
        if ADMIN_CHAT_ID:
            await app.bot.send_message(
                ADMIN_CHAT_ID,
                f"⚠️ Promotion #{promo['id']} sudah dibayar tapi BATAL diposting — "
                f"data token itu kelihatan kayak abis kena rug pas mau posting. Cek manual ke token-nya.",
            )
        return False

    true_ath = await asyncio.to_thread(trending.compute_initial_ath, pair)
    msg = trending.format_alert_message(pair, is_promoted=True, ath_market_cap=true_ath)
    _capture_signal_snapshot(pair, "PROMOTED", "paid_promotion")
    db.record_snapshot_alert_seen("PROMOTED")  # Phase 9 bugfix -- lihat catatan di check_trending_job
    sent = await broadcast(app, msg, reply_markup=_build_keyboard(pair), image_url=pair.get("imageUrl"))

    if token_address:
        if not sent:
            logger.warning(f"{token_address}: gagal kirim alert promoted, baseline DIRESET ke 0 (tidak di-track).")
            db.delete_latest_signal_snapshot(token_address)
            db.mark_as_alerted(token_address, baseline_market_cap=0, last_message_id=None)
        else:
            db.mark_as_alerted(
                token_address,
                baseline_market_cap=baseline_mc,
                last_message_id=sent.message_id,
                initial_ath=true_ath,
                name=pair.get("baseToken", {}).get("name"),
                symbol=pair.get("baseToken", {}).get("symbol"),
                initial_milestone=_compute_initial_milestone(baseline_mc, true_ath),
            )

    if ADMIN_CHAT_ID:
        label = "auto-verified" if verified_by == "auto" else "manually approved"
        await app.bot.send_message(
            ADMIN_CHAT_ID,
            f"✅ Promotion #{promo['id']} {label} & posted to the channel.",
        )
    return True


async def _finalize_paid_ad(app: Application, ad, signature: str, verified_by: str = "auto"):
    """
    Logic SETELAH ad dipastikan dibayar -- dipakai BERSAMA oleh
    check_payments_job (otomatis) DAN /approvead (fallback manual admin).
    """
    updated_ad = db.mark_ad_paid(ad["id"], signature)
    if not updated_ad:
        return False

    if updated_ad["status"] == "active":
        status_msg = "Your ad is now live! 🎉"
    else:
        status_msg = (
            "Payment received ✅ Your ad has been QUEUED — it'll automatically start "
            "showing once the current ad's run ends."
        )

    try:
        await app.bot.send_message(ad["requested_by"], status_msg)
    except Exception as e:
        logger.warning(f"Gagal kirim notifikasi ad #{ad['id']} ke pemesan: {e}")

    if ADMIN_CHAT_ID:
        label = "auto-verified" if verified_by == "auto" else "manually approved"
        await app.bot.send_message(
            ADMIN_CHAT_ID,
            f"✅ Ad #{ad['id']} {label} (status: {updated_ad['status']}).",
        )
    return True


async def check_payments_job(app: Application):
    if _is_paused():
        return
    if ADMIN_WALLET_ADDRESS.startswith("GANTI_DENGAN"):
        return  # belum dikonfigurasi, skip diam-diam

    logger.info("Mengecek pembayaran promosi & ads masuk...")
    pending_promos = db.get_unpaid_promotions()
    pending_ads = db.get_unpaid_ads()
    if not pending_promos and not pending_ads:
        return

    try:
        transfers = await asyncio.to_thread(payments.get_recent_incoming_transfers, ADMIN_WALLET_ADDRESS)
    except Exception as e:
        logger.warning(f"Gagal cek RPC Solana: {e}")
        _mark_job_run("payments", error=str(e))
        return
    _mark_job_run("payments")

    matches = payments.find_matching_promotion(transfers, pending_promos)

    for promo, signature in matches:
        try:
            if db.is_signature_used(signature):
                continue  # transaksi ini sudah dipakai untuk promosi lain
            await _finalize_paid_promotion(app, promo, signature, verified_by="auto")
        except Exception as e:
            logger.warning(f"Failed to process one promotion payment, skipping it: {e}")
            continue

    # Sama persis mekanismenya, tapi buat ads -- pakai transfer list yang SAMA
    # (nggak nambah request RPC baru sama sekali).
    ad_matches = payments.find_matching_promotion(transfers, pending_ads)
    for ad, signature in ad_matches:
        try:
            if db.is_signature_used(signature):
                continue
            await _finalize_paid_ad(app, ad, signature, verified_by="auto")
        except Exception as e:
            logger.warning(f"Failed to process one ad payment, skipping it: {e}")
            continue


# ---------- Job otomatis #3: deteksi pool yang baru saja graduate ----------

async def check_fresh_graduates_job(app: Application):
    if _is_paused():
        return
    logger.info("Checking for freshly graduated pools...")
    try:
        results = await asyncio.to_thread(trending.find_fresh_graduates, db.is_already_alerted)
    except Exception as e:
        logger.warning(f"Failed to fetch fresh graduate data: {e}")
        _mark_job_run("fresh_graduates", error=str(e))
        return
    _mark_job_run("fresh_graduates")

    if not results:
        logger.info("No fresh graduates matched the criteria.")
        return

    logger.info(f"Found {len(results)} new pair candidate(s).")
    for pair in results:
        try:
            token_address = pair.get("baseToken", {}).get("address")
            if not token_address or not db.claim_alert_slot(token_address):
                continue  # sudah diklaim tier/job lain di siklus yang nyaris bersamaan
            baseline_mc = await _refresh_pair_for_posting(pair, token_address)
            if not trending.passes_final_sanity_check(pair):
                logger.warning(f"{token_address}: gagal sanity check terakhir (kemungkinan rug baru terjadi), batalkan posting.")
                db.finalize_alert(token_address, baseline_market_cap=0, last_message_id=None)
                continue
            true_ath = await asyncio.to_thread(trending.compute_initial_ath, pair)
            msg = trending.format_alert_message(pair, is_fresh=True, ath_market_cap=true_ath)
            _capture_signal_snapshot(pair, "NEW_PAIR", "geckoterminal_new_pool")
            db.record_snapshot_alert_seen("NEW_PAIR")  # Phase 9 bugfix -- lihat catatan di check_trending_job
            sent = await broadcast(app, msg, reply_markup=_build_keyboard(pair), image_url=pair.get("imageUrl"))
            if not sent:
                logger.warning(f"{token_address}: gagal kirim alert, baseline DIRESET ke 0 (tidak di-track).")
                db.delete_latest_signal_snapshot(token_address)
                db.finalize_alert(token_address, baseline_market_cap=0, last_message_id=None)
                continue
            db.finalize_alert(
                token_address,
                baseline_market_cap=baseline_mc,
                last_message_id=sent.message_id,
                initial_ath=true_ath,
                name=pair.get("baseToken", {}).get("name"),
                symbol=pair.get("baseToken", {}).get("symbol"),
                initial_milestone=_compute_initial_milestone(baseline_mc, true_ath),
            )
            db.init_signal_outcome(token_address, baseline_mc, alerted_at=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"))
        except Exception as e:
            logger.warning(f"Failed to process/post one new-pair candidate, skipping it: {e}")
            continue


# ---------- Job otomatis: update boost/profile DexScreener utk token yang SUDAH dialert ----------

DEX_ACTIVITY_GAP_THRESHOLD_MINUTES = 5  # gap lebih dari ini = kemungkinan besar abis restart, bukan siklus normal


async def check_dex_activity_job(app: Application):
    if _is_paused():
        return

    # Deteksi GAP sejak run TERAKHIR -- dipersist ke DB (bukan JOB_STATUS
    # yang in-memory & reset tiap restart), supaya tetap akurat lintas
    # restart. Bug produksi yang dilaporkan user: tiap restart/deploy
    # file baru, SEMUA backlog boost/profile-update yang numpuk selama
    # bot down (job ini nggak jalan) nongol SEKALIGUS begitu bot nyala
    # lagi -- kadang buat token yang sekarang udah mati. Kalau gap-nya
    # jauh lebih besar dari interval normal job ini (~60-90 detik), itu
    # tanda kuat baru abis restart -- backlog TETAP "dikonsumsi" lewat
    # can_notify_dex_activity (biar nggak numpuk/muncul lagi nanti),
    # TAPI TIDAK di-posting sekaligus ke channel.
    last_check_at = db.get_state("last_dex_activity_check_at")
    is_after_gap = False
    if last_check_at:
        try:
            gap_minutes = (datetime.now(timezone.utc) - datetime.strptime(last_check_at, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)).total_seconds() / 60.0
            is_after_gap = gap_minutes > DEX_ACTIVITY_GAP_THRESHOLD_MINUTES
        except (ValueError, TypeError):
            pass
    db.set_state("last_dex_activity_check_at", datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"))

    logger.info("Checking DexScreener boosts & profile updates for already-alerted tokens...")
    try:
        results = await asyncio.to_thread(
            trending.find_dex_activity_updates, db.has_valid_alert, db.can_notify_dex_activity
        )
    except Exception as e:
        logger.warning(f"Failed to fetch DexScreener activity data: {e}")
        _mark_job_run("dex_activity", error=str(e))
        return
    _mark_job_run("dex_activity")

    if not results:
        logger.info("No DexScreener activity updates for tracked tokens this cycle.")
        return

    if is_after_gap:
        logger.info(
            f"Gap {gap_minutes:.1f} menit sejak cek terakhir (kemungkinan abis restart) -- "
            f"{len(results)} backlog update di-drain diam-diam, TIDAK di-posting ke channel."
        )
        return

    logger.info(f"Found {len(results)} DexScreener activity update(s).")
    for pair in results:
        try:
            token_address = pair.get("baseToken", {}).get("address")
            thread = db.get_token_thread_info(token_address)
            if not thread:
                continue  # jaga-jaga, seharusnya sudah difilter is_tracked_checker

            msg = trending.format_dex_activity_update(pair)
            # reply ke thread yang SUDAH ADA, sama seperti update milestone —
            # supaya semua update token ini (kenaikan harga, boost, profile
            # update) nyambung jadi 1 thread
            sent = await broadcast(
                app, msg,
                reply_markup=_build_keyboard(pair),
                image_url=pair.get("imageUrl"),
                reply_to_message_id=thread["last_message_id"],
            )
            if sent:
                db.update_last_message_id(token_address, sent.message_id)
        except Exception as e:
            logger.warning(f"Failed to process/post one DexScreener activity update, skipping it: {e}")
            continue


# ---------- Job otomatis #4: cek kenaikan token yang sudah pernah dialert ----------


def _record_outcome_observation(token_address: str, pair: dict):
    """Record live market cap for Outcome Engine; never affects public alerts."""
    if not pair:
        return
    current_mc = pair.get("marketCap") or pair.get("fdv") or 0
    if current_mc <= 0:
        return
    try:
        db.update_signal_outcome(
            token_address,
            current_mc,
            observed_at=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        )
    except Exception as e:
        logger.warning(f"Failed to update outcome for {token_address}: {e}")


def _process_one_milestone_result(row, pair) -> bool:
    """
    Proses HASIL yang SUDAH DI-FETCH (lewat batch) buat 1 token — hitung
    ATH/milestone, siapkan pesan kalau ada yang baru. Tidak ada network
    call di sini sama sekali (itu sudah kelar di check_milestones_job
    lewat get_pairs_batch), jadi fungsi ini murni cepat & lokal.

    Return dict {"send": True, "msg":..., ...} kalau ada milestone baru
    buat dikirim, atau None kalau tidak ada apa-apa yang perlu dikirim.
    """
    token_address = row["token_address"]
    baseline = row["baseline_market_cap"]
    last_milestone = row["last_milestone"]
    last_message_id = row["last_message_id"]

    if not baseline or baseline <= 0:
        return None

    if not pair:
        logger.info(f"{token_address}: DexScreener tidak punya data pair (kemungkinan masih di bonding curve), skip cycle ini.")
        return None

    # Outcome Engine observes the live MC independently from the public
    # milestone sanity/liquidity gate. A rug/collapse is an outcome too.
    _record_outcome_observation(token_address, pair)

    current_mc = pair.get("marketCap") or pair.get("fdv") or 0
    if current_mc <= 0:
        logger.info(f"{token_address}: market cap live 0/kosong, skip cycle ini.")
        return None

    # SANITY CHECK: kalau liquidity SEKARANG nyaris nol (misal abis kena
    # rug SETELAH dialert), harga & market cap yang kebaca dari pool itu
    # tidak bisa dipercaya. Skip cycle ini buat token itu.
    # Pakai MILESTONE_MIN_LIQUIDITY_TO_MCAP_RATIO (lebih longgar dari yang
    # dipakai pas alert pertama) — token yang lagi pump kenceng wajar
    # rasionya turun (market cap ngebut duluan), itu BUKAN tanda rug baru.
    current_liquidity = (pair.get("liquidity") or {}).get("usd", 0) or 0
    if current_liquidity < trending.MILESTONE_MIN_LIQUIDITY_USD or (current_liquidity / current_mc) < trending.MILESTONE_MIN_LIQUIDITY_TO_MCAP_RATIO:
        logger.warning(f"{token_address}: liquidity sekarang terlalu tipis (${current_liquidity:,.0f} vs mcap ${current_mc:,.0f}), skip update ATH cycle ini.")
        return None

    # Update ATH DULU, baru hitung milestone dari ATH (bukan harga
    # sekarang) — supaya token yang sempat naik tinggi lalu turun lagi
    # TETAP dianggap sudah capai level itu, tidak "mundur".
    new_ath = db.update_ath_if_higher(
        token_address, current_mc, baseline_market_cap=baseline,
        max_multiplier=trending.MAX_ATH_MULTIPLIER,
        max_per_cycle_multiplier=trending.MAX_ATH_PER_CYCLE_MULTIPLIER,
    )
    ath_multiple = new_ath / baseline
    new_milestone = trending.get_new_milestone(ath_multiple, last_milestone)

    if new_milestone is None:
        return None

    if last_milestone < RECAP_MIN_MULTIPLIER <= new_milestone:
        # CATATAN: nama kolom di database masih "first_2x_at" (peninggalan
        # waktu threshold-nya masih hardcode 2.0), tapi sekarang beneran
        # nyatet "pertama kali capai RECAP_MIN_MULTIPLIER" -- brapa pun
        # nilainya sekarang (1.5x). Nggak diganti nama kolomnya biar nggak
        # perlu migrasi skema database.
        db.set_first_2x_date_if_unset(token_address)

    logger.info(f"{token_address} crossed {new_milestone}x milestone (ATH-based).")
    return {
        "token_address": token_address,
        "pair": pair,
        "new_milestone": new_milestone,
        "new_ath": new_ath,
        "last_message_id": last_message_id,
    }


def _process_one_ebc_milestone_result(row, pair) -> dict:
    """
    Phase 10D -- SAMA seperti _process_one_milestone_result(), TAPI khusus
    buat token EBC yang datanya dari pump.fun (BUKAN DexScreener) dan
    MASIH PRA-GRADUASI. Bedanya sengaja:

    - TIDAK ADA sanity-check liquidity DEX (MILESTONE_MIN_LIQUIDITY_USD
      dkk) -- token pra-graduasi memang TIDAK PUNYA liquidity pool DEX
      sama sekali, itu BUKAN tanda rug buat tier ini, beda konteks total
      dari token yang sudah punya pool.
    - TIDAK memanggil fungsi pencatat-outcome Intelligence V1 -- itu
      SUDAH ditangani terpisah lewat db.update_signal_outcome() di dalam
      find_risky_bonding_curve_candidates() sendiri (Phase 10C). Manggil
      lagi di sini cuma bakal dobel-catat.

    ATH tracking (db.update_ath_if_higher, sanity cap yang sama) &
    deteksi milestone (trending.get_new_milestone) TETAP dipakai identik
    -- itu logic yang sama-sama valid buat kedua sumber data.
    """
    token_address = row["token_address"]
    baseline = row["baseline_market_cap"]
    last_milestone = row["last_milestone"]
    last_message_id = row["last_message_id"]

    if not baseline or baseline <= 0:
        return None
    if not pair:
        return None

    current_mc = pair.get("marketCap") or 0
    if current_mc <= 0:
        return None

    new_ath = db.update_ath_if_higher(
        token_address, current_mc, baseline_market_cap=baseline,
        max_multiplier=trending.MAX_ATH_MULTIPLIER,
        max_per_cycle_multiplier=trending.MAX_ATH_PER_CYCLE_MULTIPLIER,
    )
    ath_multiple = new_ath / baseline
    new_milestone = trending.get_new_milestone(ath_multiple, last_milestone)
    if new_milestone is None:
        return None

    if last_milestone < RECAP_MIN_MULTIPLIER <= new_milestone:
        db.set_first_2x_date_if_unset(token_address)

    logger.info(f"{token_address} crossed {new_milestone}x milestone (EBC/pump.fun, pra-graduasi).")
    return {
        "token_address": token_address,
        "pair": pair,
        "new_milestone": new_milestone,
        "new_ath": new_ath,
        "last_message_id": last_message_id,
    }


async def _send_milestone_updates(app: Application, to_send: list) -> int:
    """
    Phase 10D -- diekstrak dari check_milestones_job() supaya bisa dipakai
    ULANG oleh check_risky_job() (buat milestone EBC pra-graduasi) TANPA
    duplikasi logic pengiriman. Perilaku identik persis dengan sebelumnya.

    Return jumlah pengiriman yang gagal (buat logging caller, boleh diabaikan).
    """
    failed_count = 0
    for item in to_send:
        try:
            msg = trending.format_milestone_message(item["pair"], item["new_milestone"], ath_market_cap=item["new_ath"])
            sent = await broadcast(
                app, msg,
                reply_markup=_build_milestone_keyboard(item["pair"], item["token_address"], item["new_milestone"]),
                image_url=item["pair"].get("imageUrl"),
                reply_to_message_id=item["last_message_id"],
            )
            db.update_milestone(
                item["token_address"], item["new_milestone"],
                message_id=sent.message_id if sent else item["last_message_id"],
            )
        except Exception as e:
            failed_count += 1
            logger.warning(f"Failed to send milestone update for {item['token_address']}: {e}")
            continue
    return failed_count


def _process_milestones_and_telemetry_sync(tracked: list, pairs_by_address: dict):
    """
    Bugfix PRODUKSI DARURAT (laporan user: bot berhenti merespons/health
    check tidak reaksi selama berjam-jam) -- diekstrak dari
    check_milestones_job() supaya bisa dijalankan lewat asyncio.to_thread(),
    PERSIS pola yang SUDAH BENAR dipakai check_risky_job() buat
    find_risky_bonding_curve_candidates().

    Akar masalah: seluruh loop pemrosesan milestone + blok penulisan
    behavioral telemetry Phase 11A itu MURNI sinkron (query SQLite +
    komputasi Python, TIDAK ADA I/O jaringan/Telegram) tapi dulu dijalankan
    LANGSUNG di dalam fungsi async check_milestones_job() -- artinya
    SELAMA fungsi ini jalan, seluruh event loop (termasuk polling Telegram
    buat command seperti /health) IKUT MACET TOTAL. Begitu database makin
    besar & makin banyak job lain yang menulis bersamaan (kontensi lock
    SQLite), durasi blocking ini bisa membengkak sampai hitungan menit --
    cukup lama buat bikin bot kelihatan "mati" walau prosesnya sendiri
    masih "Active".

    Fungsi ini TIDAK melakukan panggilan Telegram/broadcast apa pun --
    HANYA data & komputasi murni -- supaya aman 100% dijalankan di thread
    terpisah. Return (to_send, failed_count) -- `to_send` diproses caller
    (async) lewat _send_milestone_updates() SETELAH thread ini selesai.
    """
    failed_count = 0
    to_send = []
    for row in tracked:
        try:
            pair = pairs_by_address.get(row["token_address"])
            result = _process_one_milestone_result(row, pair)
            if result:
                to_send.append(result)
        except Exception as e:
            failed_count += 1
            logger.warning(f"Milestone check failed for one token, skipping it this cycle: {e}")
            continue

    # Phase 11A -- behavioral telemetry PERMANEN buat sisi DEX, pakai data
    # DexScreener yang SAMA yang baru saja di-fetch di atas (BUKAN request
    # baru). `pairs_by_address` isinya token NEW_PAIR/NEW_TRENDING asli
    # MAUPUN token EBC yang sudah graduate (dua-duanya sama-sama DexScreener
    # begitu ada pool nyata) -- signal_type per-token dicek via 1 query
    # batch (get_latest_signal_type_for_tokens), TIDAK 1 query per token.
    # Try/except SENDIRI, TERPISAH dari alur milestone di atas -- kegagalan
    # di sini TIDAK BOLEH mengganggu notifikasi milestone yang sudah diproses.
    #
    # BUGFIX (laporan user, audit /phase11audit): token yang TIDAK PUNYA
    # baris signal_snapshots sama sekali (kemungkinan besar token lama dari
    # SEBELUM tabel signal_snapshots ada -- get_trackable_tokens() memang
    # sengaja tidak punya batas umur, jadi token seumur apa pun tetap terus
    # dipantau) dulu SEMPAT tetap ditulis dengan signal_type="UNKNOWN"
    # literal. Token begini TIDAK PERNAH bisa disambungkan ke outcome
    # (butuh signal_snapshots buat itu) -- jadi behavioral telemetry buat
    # mereka murni buang tempat, TIDAK ADA nilai riset sama sekali (di
    # produksi ini nyumbang ~40% dari seluruh baris behavioral_telemetry).
    # Sekarang token TANPA signal_type dikenali di-SKIP TOTAL dari
    # penulisan Phase 11A -- TIDAK menulis baris "UNKNOWN" apa pun lagi.
    # Milestone/ATH tracking token itu di ATAS TIDAK berubah sama sekali
    # (masih tetap dipantau seperti biasa) -- ini MURNI soal telemetri
    # Phase 11A, tidak menyentuh alert/kriteria/milestone apa pun.
    try:
        valid_pairs = {addr: p for addr, p in pairs_by_address.items() if p}
        if valid_pairs:
            signal_types = db.get_latest_signal_type_for_tokens(list(valid_pairs.keys()))
            # Cuma token yang PUNYA signal_type asli (ada baris signal_snapshots)
            # yang diproses -- token tanpa itu di-skip, bukan ditulis "UNKNOWN".
            identifiable_pairs = {addr: p for addr, p in valid_pairs.items() if addr in signal_types}
            skipped_count = len(valid_pairs) - len(identifiable_pairs)
            if skipped_count:
                logger.info(
                    f"Phase 11A: {skipped_count} token tanpa signal_snapshots (kemungkinan token lama "
                    f"pra-Phase-5) di-skip dari penulisan behavioral telemetry -- tidak bisa disambungkan "
                    f"ke outcome, tidak ada nilai riset."
                )
            if identifiable_pairs:
                dex_observed_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
                raw_observations = [
                    trending.build_behavioral_observation_dex(
                        addr, signal_types[addr], pair, dex_observed_at,
                    )
                    for addr, pair in identifiable_pairs.items()
                ]
                recent_history = db.get_recent_behavioral_telemetry_for_tokens(
                    list(identifiable_pairs.keys()), limit_per_token=5,
                )
                # BUGFIX PRODUKSI SERIUS (ditemukan lewat /ebcprovenance --
                # 1.349 token menyumbang 625.295 baris, rata-rata ~463
                # observasi/token, jauh timpang dibanding sisi EBC yang
                # cuma ~1.2 observasi/token). Akar masalah: throttle 5
                # menit (_filter_observations_by_min_interval,
                # EBC_TELEMETRY_MIN_INTERVAL_MINUTES) SUDAH dipasang di
                # poll_tracked_ebc_tokens() & find_risky_bonding_curve_candidates()
                # (trending.py) TAPI TERLEWAT di jalur DEX ini -- jadi
                # check_milestones_job (jalan tiap 60 detik) menulis baris
                # BARU tiap siklus, TANPA batas, buat SEMUA token yang lagi
                # aktif dipantau. Ini persis pola pertumbuhan yang
                # menyebabkan krisis disk-penuh sebelumnya, cuma lewat
                # jalur DEX, bukan EBC. Sekarang throttle yang SAMA
                # diterapkan di sini juga -- konsisten di KEDUA sisi.
                throttled_observations = trending._filter_observations_by_min_interval(
                    raw_observations, recent_history, trending.EBC_TELEMETRY_MIN_INTERVAL_MINUTES,
                )
                final_rows = []
                for raw_obs in throttled_observations:
                    prior = recent_history.get(raw_obs["token_address"], [])
                    derived = trending.compute_behavioral_derived_fields(raw_obs, prior)
                    final_rows.append({**raw_obs, **derived})
                db.record_behavioral_telemetry_batch(final_rows)
    except Exception as e:
        logger.warning(f"Phase 11A: gagal proses/tulis behavioral telemetry DEX (tidak fatal): {e}")

    return to_send, failed_count


async def check_milestones_job(app: Application):
    # PENTING: pause CUMA boleh nge-skip POSTING publik (loop kedua di
    # bawah), BUKAN seluruh fungsi ini -- fungsi ini JUGA yang merekam
    # observasi outcome buat dataset (_record_outcome_observation, lewat
    # _process_one_milestone_result). Kalau di-pause total, kita kehilangan
    # data observasi selama maintenance -- padahal intent /pause cuma
    # "jangan posting alert publik dulu", bukan "berhenti ngumpulin data".
    logger.info("Checking price milestones for previously alerted tokens...")
    try:
        tracked = await asyncio.to_thread(db.get_actively_trackable_tokens)
    except Exception as e:
        logger.warning(f"Failed to load trackable tokens: {e}")
        _mark_job_run("milestones", error=str(e))
        return

    if not tracked:
        _mark_job_run("milestones")
        return

    # SATU (atau segelintir) request BATCH buat SEMUA token yang dipantau,
    # bukan 1 request per token. Ini yang bikin ratusan token bisa dicek
    # tanpa ngelewatin jatah 60 request/menit DexScreener — 300 token
    # cuma butuh 10 request lewat batch ini, bukan 300 lewat cara lama.
    addresses = [row["token_address"] for row in tracked]
    try:
        pairs_by_address = await asyncio.to_thread(trending.get_pairs_batch, addresses)
    except Exception as e:
        logger.warning(f"Gagal ambil data batch buat milestone check: {e}")
        _mark_job_run("milestones", error=str(e))
        return

    # FALLBACK: token yang "hilang" dari hasil batch (mismatch/limitasi
    # endpoint batch DexScreener, bukan berarti token itu genuinely nggak
    # ada pair-nya) dicoba lagi SATU-SATU. Dibatasi jumlahnya biar tidak
    # balik lagi ke masalah rate-limit kalau ternyata banyak yang hilang.
    MILESTONE_FALLBACK_CAP = 20
    missing_addresses = [addr for addr in addresses if addr not in pairs_by_address]
    if missing_addresses:
        logger.info(f"{len(missing_addresses)} token hilang dari hasil batch, coba fallback satu-satu (maks {MILESTONE_FALLBACK_CAP}).")
        for addr in missing_addresses[:MILESTONE_FALLBACK_CAP]:
            try:
                fallback_pair = await asyncio.to_thread(trending.get_pair_data, addr)
                if fallback_pair:
                    pairs_by_address[addr] = fallback_pair
            except Exception:
                continue

    # Bugfix produksi darurat -- seluruh pemrosesan milestone + penulisan
    # behavioral telemetry (MURNI sinkron, tidak ada I/O Telegram) sekarang
    # dijalankan lewat asyncio.to_thread(), PERSIS pola yang sudah benar
    # dipakai check_risky_job(). Lihat _process_milestones_and_telemetry_sync()
    # buat penjelasan lengkap kenapa ini krusial.
    to_send, failed_count = await asyncio.to_thread(
        _process_milestones_and_telemetry_sync, tracked, pairs_by_address,
    )

    # Kirim pesan SETELAH semua data selesai diproses -- bagian ini manggil
    # Telegram, bukan DexScreener, jadi tidak perlu dikhawatirkan soal rate
    # limit yang sama. Di-skip kalau lagi di-pause, tapi observasi outcome
    # di atas (loop pertama) TETAP jalan normal.
    if _is_paused():
        _mark_job_run("milestones", error=(f"{failed_count} token(s) failed this cycle" if failed_count else None))
        return
    send_failed = await _send_milestone_updates(app, to_send)
    failed_count += send_failed

    _mark_job_run("milestones", error=(f"{failed_count} token(s) failed this cycle" if failed_count else None))


# ---------- Job otomatis #5: update & pin rekap "2x+ Hall of Fame" tiap 12 jam ----------

async def evaluate_post_alert_intelligence_job(app: Application):
    """
    PRESSURE LAYER V1 (SHADOW ONLY) -- arahan Architect. Job terjadwal
    yang SUDAH ADA (tidak ada perubahan jadwal/frekuensi) -- SEKARANG
    memanggil trending.evaluate_post_alert_intelligence() yang sudah
    dikonsolidasi buat menghitung SELURUH Pressure Layer V1 (M5 + H1 +
    agreement, window 5/15/30/60 menit) DALAM SATU EVALUASI, bukan cuma
    EARLY_BUY_PRESSURE_H1 seperti sebelumnya -- TIDAK ADA fetch/query/
    tulis TAMBAHAN dibanding sebelumnya (observasi yang SAMA yang sudah
    difetch dipakai buat menghitung SEMUA window sekaligus, retrospektif).

    Jalan periodik, cari token yang sudah lewat window 60-menit tapi
    belum dievaluasi (db.get_tokens_pending_post_alert_intelligence_evaluation),
    evaluasi, gabung hasilnya (termasuk data Pressure Layer BARU) ke
    kondisi pra-alert yang SUDAH tersimpan
    (db.update_intelligence_v1_conditions -- TIDAK PERNAH menimpa 5
    kondisi pra-alert).

    TIDAK ADA RPC/API call baru. TIDAK PERNAH menyentuh Telegram/alert/
    kriteria/SR-Score apa pun -- murni evaluasi & simpan shadow.
    Kegagalan per-token TIDAK BOLEH menghentikan token lain dalam batch
    yang sama.
    """
    try:
        pending = await asyncio.to_thread(db.get_tokens_pending_post_alert_intelligence_evaluation)
    except Exception as e:
        logger.warning(f"Gagal ambil daftar token pending evaluasi post-alert intelligence (tidak fatal): {e}")
        return

    if not pending:
        return

    processed = 0
    for item in pending:
        try:
            observations = await asyncio.to_thread(
                db.get_token_observations_with_elapsed, item["token_address"], item["alerted_at"],
            )
            result = trending.evaluate_post_alert_intelligence(observations)
            await asyncio.to_thread(
                db.update_intelligence_v1_conditions,
                item["token_address"], item["alerted_at"], result["conditions"], result["features_used"],
            )
            processed += 1
        except Exception as e:
            logger.warning(f"Gagal evaluasi post-alert intelligence buat {item['token_address']} (tidak fatal, lanjut token lain): {e}")
            continue

    if processed:
        logger.info(f"Intelligence V1 (shadow): {processed}/{len(pending)} token dievaluasi kondisi EARLY_BUY_PRESSURE_H1.")


async def prune_behavioral_telemetry_job(app: Application):
    """
    Bugfix PRODUKSI DARURAT -- retensi BERKELANJUTAN buat behavioral_telemetry
    (Phase 11A), supaya krisis "disk penuh" (volume Railway 500MB kepake
    99%, bot crash "database or disk is full") TIDAK TERULANG lagi ke
    depannya. Dijalankan HARIAN, hapus baris yang lebih tua dari
    BEHAVIORAL_TELEMETRY_RETENTION_DAYS (default 3 hari, sementara sampai
    SolRadar termonetisasi -- lihat catatan di database.py) -- lihat
    prune_old_behavioral_telemetry() (database.py) buat detail lengkap.

    TIDAK PERNAH menyentuh alerted_tokens/signal_snapshots/signal_outcomes
    (data outcome/kriteria/milestone) -- CUMA tabel telemetri behavioral
    yang murni observasi mentah.
    """
    try:
        deleted = await asyncio.to_thread(db.prune_old_behavioral_telemetry)
        if deleted:
            logger.info(f"Retensi behavioral_telemetry: {deleted:,} baris lebih tua dari "
                        f"{db.BEHAVIORAL_TELEMETRY_RETENTION_DAYS} hari dihapus.")
    except Exception as e:
        logger.warning(f"Gagal jalankan retensi behavioral_telemetry (tidak fatal): {e}")


async def check_recap_job(app: Application):
    logger.info("Refreshing today's Hall of Fame recap...")

    # Deteksi pergantian hari UTC DI SINI -- bukan lewat job terpisah yang
    # presisi jam 00:01 UTC seperti sebelumnya (TERBUKTI tidak reliable,
    # 2 hari berturut-turut nggak jalan entah kenapa). Job INI (3 jam
    # sekali) TERBUKTI jalan konsisten, jadi recap final harian sekarang
    # "numpang" di sini -- begitu ke-deteksi harinya udah ganti, recap
    # final buat hari SEBELUMNYA langsung diproses dulu sebelum lanjut
    # ke recap biasa. Worst case cuma telat maksimal ~3 jam dari tengah
    # malam UTC, jauh lebih baik daripada nggak pernah muncul sama sekali.
    today_utc = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    last_daily_recap_date = db.get_state("last_daily_recap_date")
    if last_daily_recap_date != today_utc:
        logger.info(f"Hari UTC sudah ganti ({last_daily_recap_date} -> {today_utc}), jalankan recap final harian dulu.")
        try:
            await daily_final_recap_job(app)
        except Exception as e:
            logger.warning(f"Gagal jalankan recap final harian: {e}")
        # SENGAJA berhenti di sini -- lanjut posting recap BIASA buat hari
        # yang BARU AJA mulai itu pasti isinya kosong ("No 2x+ calls yet
        # today"), jadi cuma nambah noise nempel tepat setelah recap final.
        # Recap biasa yang PERTAMA buat hari ini biar nunggu siklus jadwal
        # berikutnya aja, di titik itu baru ada kemungkinan isinya nggak kosong.
        _mark_job_run("recap")
        return

    # PENTING: fungsi ini dipanggil dari 2 sumber -- CronTrigger terjadwal
    # (yang beneran nunjukkin "udah waktunya update Hall of Fame") DAN
    # secara manual sekali di post_init tiap kali bot start/restart (buat
    # nangkep pergantian hari yang mungkin kelewat -- lihat blok di atas).
    # Bug produksi yang dilaporkan user: SETIAP restart/deploy file baru
    # bikin Hall of Fame ke-post ULANG, karena dulu fungsi ini nggak
    # pernah ngecek "apa beneran udah waktunya", cuma langsung post kalau
    # dipanggil dari mana pun. Sekarang dicek dulu -- kalau belum genap
    # HALL_OF_FAME_MIN_INTERVAL_HOURS sejak post TERAKHIR (persisted ke
    # DB, jadi tetap akurat lintas restart), skip diam-diam. Panggilan
    # dari CronTrigger yang BENERAN jadwalnya bakal tetap lolos normal
    # (karena jaraknya emang udah pas 6 jam).
    last_post_at = db.get_state("last_hall_of_fame_post_at")
    if last_post_at:
        try:
            elapsed_hours = (datetime.now(timezone.utc) - datetime.strptime(last_post_at, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)).total_seconds() / 3600.0
            if elapsed_hours < HALL_OF_FAME_MIN_INTERVAL_HOURS - 0.1:  # toleransi kecil buat jitter scheduler
                logger.info(f"Hall of Fame baru di-post {elapsed_hours:.1f} jam lalu (< {HALL_OF_FAME_MIN_INTERVAL_HOURS} jam) -- belum waktunya, skip (kemungkinan dipanggil dari startup, bukan jadwal beneran).")
                _mark_job_run("recap")
                return
        except (ValueError, TypeError):
            pass  # kalau format timestamp lama korup/nggak sesuai, jangan sampai nge-block -- lanjut post seperti biasa

    try:
        rows = db.get_todays_hall_of_fame_tokens()
    except Exception as e:
        logger.warning(f"Failed to load recap data from database: {e}")
        _mark_job_run("recap", error=str(e))
        return

    channel_username = CHANNEL_ID.lstrip("@")
    entries = []
    failed_count = 0
    for row in rows:
        try:
            baseline = row["baseline_market_cap"]
            ath = row["ath_market_cap"]
            if not baseline or baseline <= 0 or not ath:
                continue

            multiplier = ath / baseline
            if multiplier < RECAP_MIN_MULTIPLIER:
                continue

            # Link ke postingan TERAKHIR soal token ini (thread paling update),
            # dipasang di ticker $SYMBOL supaya sekali klik langsung nyampe ke sana
            post_link = None
            if row["last_message_id"] and channel_username:
                post_link = f"https://t.me/{channel_username}/{row['last_message_id']}"

            entries.append({
                "name": row["token_name"] or "Unknown",
                "symbol": row["token_symbol"] or "",
                "multiplier": multiplier,
                "market_cap": ath,
                "post_link": post_link,
            })
        except Exception as e:
            failed_count += 1
            logger.warning(f"Recap entry failed for one token, skipping it: {e}")
            continue

    if failed_count:
        logger.warning(f"{failed_count} token(s) skipped while building recap this cycle.")

    # Judul selalu pakai tanggal HARI INI (UTC) dalam Bahasa Inggris — begitu
    # lewat tengah malam UTC, siklus berikutnya otomatis bikin board baru
    # dengan judul & daftar token yang berbeda (reset harian tanpa perlu
    # job terpisah pas jam 00:00).
    date_str = datetime.now(timezone.utc).strftime("%B %d, %Y")
    recap_text = trending.format_recap_message(entries, date_str, min_multiplier=RECAP_MIN_MULTIPLIER)

    try:
        sent = await app.bot.send_message(CHANNEL_ID, recap_text, parse_mode=ParseMode.MARKDOWN)
    except Exception as e:
        logger.warning(f"Failed to post recap to channel: {e}")
        _mark_job_run("recap", error=str(e))
        return
    _mark_job_run("recap")

    # BUGFIX PRODUKSI PALING KRITIS (laporan user: bot "Active" tapi
    # TOTAL tidak bereaksi ke command apa pun, PLUS Hall of Fame terus
    # nge-post ULANG konten yang SAMA tiap restart) -- akar masalah:
    # db.set_state() di bawah ini dulu dipanggil TELANJANG, tanpa
    # try/except. Kalau gagal (mis. disk penuh -- persis skenario
    # produksi yang dikonfirmasi traceback user), exception-nya nembus
    # ke atas -- dan karena fungsi ini dipanggil LANGSUNG dari post_init()
    # (yang jalan DI DALAM run_polling()), itu MENJATUHKAN SELURUH proses
    # sebelum bot sempat mulai memproses pesan Telegram. Efek SAMPING-nya
    # juga menjelaskan bug HoF berulang: karena "last_hall_of_fame_post_at"
    # tidak PERNAH berhasil tersimpan, cek jarak-waktu di atas (baris
    # ~2804) selalu menganggap "belum pernah post", jadi konten yang SAMA
    # (data belum sempat berubah karena bot keburu crash lagi) di-post
    # ulang tiap kali restart.
    #
    # Sekarang seluruh sisa fungsi ini (state-saving + pin management)
    # dibungkus try/except -- pesan Hall of Fame yang SUDAH berhasil
    # terkirim di atas TIDAK BOLEH batal dianggap sukses gara-gara
    # kegagalan di langkah SETELAHNYA yang sebenarnya tidak fatal.
    try:
        db.set_state("last_hall_of_fame_post_at", datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"))
    except Exception as e:
        logger.warning(f"Gagal simpan waktu post Hall of Fame terakhir (tidak fatal, tapi HoF berikutnya mungkin post ulang): {e}")

    try:
        old_message_id = db.get_state("last_recap_message_id")
    except Exception as e:
        logger.warning(f"Gagal ambil ID pesan recap lama: {e}")
        old_message_id = None
    if old_message_id:
        try:
            await app.bot.unpin_chat_message(CHANNEL_ID, int(old_message_id))
        except Exception as e:
            logger.warning(f"Could not unpin old recap (may already be unpinned): {e}")

    try:
        await app.bot.pin_chat_message(CHANNEL_ID, sent.message_id, disable_notification=True)
        db.set_state("last_recap_message_id", str(sent.message_id))
    except Exception as e:
        logger.warning(f"Failed to pin recap message: {e}")


async def daily_final_recap_job(app: Application):
    """
    Jalan SEKALI tiap hari, tepat jam 00:01 UTC (bukan lewat interval
    biasa — lihat pendaftaran CronTrigger di post_init) — bikin recap
    FINAL buat hari yang BARU SAJA berakhir, lengkap dengan statistik
    (total token dialert, berapa yang capai 2x+, win rate hari itu saja).

    PENTING: pesan ini di-pin sebagai PIN TERPISAH dari Hall of Fame
    30-menit-an (lihat check_recap_job) — bukan gantiin pin itu. Channel
    jadi punya 2 pin sekaligus: Hall of Fame yang terus update tiap 30
    menit (paling atas/terbaru), dan recap final hari sebelumnya (di
    bawahnya). Subscriber baru bakal lihat Hall of Fame yang lagi
    berjalan duluan, baru kalau di-scroll ke pin sebelumnya ketemu
    recap harian kemarin.
    """
    yesterday_str = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")
    logger.info(f"Membuat recap final harian untuk {yesterday_str}...")

    try:
        rows = db.get_hall_of_fame_tokens_for_date(yesterday_str)
        stats = db.get_daily_stats(yesterday_str, min_multiplier=RECAP_MIN_MULTIPLIER)
    except Exception as e:
        logger.warning(f"Gagal ambil data recap final harian: {e}")
        _mark_job_run("daily_recap", error=str(e))
        return

    channel_username = CHANNEL_ID.lstrip("@")
    entries = []
    for row in rows:
        try:
            baseline = row["baseline_market_cap"]
            ath = row["ath_market_cap"]
            if not baseline or baseline <= 0 or not ath:
                continue
            multiplier = ath / baseline
            if multiplier < RECAP_MIN_MULTIPLIER:
                continue
            post_link = (
                f"https://t.me/{channel_username}/{row['last_message_id']}"
                if row["last_message_id"] and channel_username else None
            )
            entries.append({
                "name": row["token_name"] or "Unknown",
                "symbol": row["token_symbol"] or "",
                "multiplier": multiplier,
                "market_cap": ath,
                "post_link": post_link,
            })
        except Exception as e:
            logger.warning(f"Recap final harian: skip 1 entry karena error: {e}")
            continue

    try:
        date_obj = datetime.strptime(yesterday_str, "%Y-%m-%d")
        date_str_formatted = date_obj.strftime("%B %d, %Y") + " (FINAL)"
    except ValueError:
        date_str_formatted = f"{yesterday_str} (FINAL)"

    recap_text = trending.format_recap_message(entries, date_str_formatted, daily_stats=stats, min_multiplier=RECAP_MIN_MULTIPLIER)

    try:
        sent = await app.bot.send_message(CHANNEL_ID, recap_text, parse_mode=ParseMode.MARKDOWN)
    except Exception as e:
        # Lapis pengaman TERAKHIR: kalau tetap gagal kirim (misal nama/ticker
        # token yang kepanjangan bikin lolos dari batas MAX_RECAP_ENTRIES_SHOWN
        # tapi tetap kelewat 4096 karakter), coba lagi TANPA daftar entry sama
        # sekali -- statistiknya (yang paling penting) tetap harus sampai,
        # daripada gagal total dan bikin siklus retry tanpa henti tiap 3 jam.
        logger.warning(f"Gagal posting recap final harian (percobaan 1): {e}")
        try:
            fallback_text = trending.format_recap_message([], date_str_formatted, daily_stats=stats, min_multiplier=RECAP_MIN_MULTIPLIER)
            fallback_text += "\n\n_(Daftar token dipersingkat karena kepanjangan)_"
            sent = await app.bot.send_message(CHANNEL_ID, fallback_text, parse_mode=ParseMode.MARKDOWN)
        except Exception as e2:
            logger.warning(f"Gagal posting recap final harian (fallback juga gagal): {e2}")
            _mark_job_run("daily_recap", error=str(e2))
            return
    _mark_job_run("daily_recap")

    # Catat tanggal UTC SAAT INI (bukan yesterday_str) — ini basis buat
    # post_init ngecek "apakah siklus recap harian HARI INI sudah jalan",
    # supaya kalau bot sempat mati pas jam 00:01 UTC, begitu nyala lagi
    # bisa langsung jalankan susulan tanpa nunggu besok.
    db.set_state("last_daily_recap_date", datetime.now(timezone.utc).strftime("%Y-%m-%d"))

    # SENGAJA TIDAK unpin recap harian sebelumnya — semua recap final
    # harian tetap ke-pin selamanya, menumpuk hari demi hari, sesuai
    # permintaan user. Cuma nge-pin yang baru di atasnya.
    try:
        await app.bot.pin_chat_message(CHANNEL_ID, sent.message_id, disable_notification=True)
        logger.info("Recap final harian di-pin (recap harian sebelumnya TETAP di-pin, tidak dihapus).")
    except Exception as e:
        logger.warning(f"Gagal pin recap final harian: {e}")


# ---------- Job otomatis #6: kandidat pre-graduation (paling berisiko) ----------

async def check_risky_job(app: Application):
    if _is_paused():
        return
    # DIAGNOSTIK (lihat catatan _mark_job_run) -- ukur durasi SELURUH
    # siklus ini (bukan cuma sampai kandidat baru selesai difetch),
    # dicatat di SEMUA jalur keluar (try/finally) termasuk yang gagal di
    # tengah, biar /health nunjukkin bukti asli seberapa lama siklus ini
    # BENERAN makan waktu -- bukan cuma asumsi 90 detik nominal.
    _cycle_start = time.monotonic()
    logger.info("Checking pre-graduation bonding curve candidates...")
    try:
        results, alerted_token_pairs = await asyncio.to_thread(trending.find_risky_bonding_curve_candidates, db.is_already_alerted)
    except Exception as e:
        logger.warning(f"Failed to fetch pump.fun bonding curve data (unofficial endpoint may have changed): {e}")
        _mark_job_run("risky", error=str(e), duration_seconds=time.monotonic() - _cycle_start)
        return
    _mark_job_run("risky_candidates_fetched", duration_seconds=time.monotonic() - _cycle_start)

    # Phase 10D/10F -- proses milestone (2x/3x/5x/10x/dst) buat token EBC yang
    # SUDAH dialert & MASIH PRA-GRADUASI. Blok ini SELALU jalan tiap siklus
    # (TIDAK digantungkan ke alerted_token_pairs dari listing top-50 --
    # Phase 10F sengaja independen, poll token yang di-track LANGSUNG,
    # supaya token yang kedorong keluar dari top-50 tetap kecek). Ini yang
    # benerin recap harian ("Win rate") & notifikasi milestone yang
    # SEBELUMNYA cuma bisa lihat token yang sudah punya data DexScreener
    # (sudah graduate) -- token yang 2x/3x MURNI di bonding curve
    # sebelum/tanpa graduate SELAMA INI tidak pernah kecatat menang di
    # mana pun yang user-facing. Dibungkus try/except SENDIRI -- kegagalan
    # di sini TIDAK BOLEH mengganggu pencarian kandidat BARU (results) di bawah.
    try:
        tracked_by_address = {row["token_address"]: row for row in db.get_trackable_tokens()}

        # Phase 10F -- poll AKTIF token EBC yang masih fresh & belum
        # ketahuan nasibnya lewat endpoint per-token pump.fun (BUKAN
        # cuma numpang listing top-50 lagi). Ini yang nutup celah
        # token yang kedorong keluar dari top-50 sebelum sempat
        # 2x/3x -- dikonfirmasi lewat evidence produksi (Phase 10E)
        # bahwa endpoint per-token bisa diakses tanpa auth.
        try:
            active_ebc_rows = db.get_active_ebc_tracked_tokens()
            polled_pairs = await asyncio.to_thread(trending.poll_tracked_ebc_tokens, active_ebc_rows)
        except Exception as e:
            logger.warning(f"Phase 10F: gagal poll token EBC aktif (tidak fatal): {e}")
            polled_pairs = {}

        combined_pairs = {**alerted_token_pairs, **polled_pairs}
        ebc_to_send = []
        for token_address, pair in combined_pairs.items():
            row = tracked_by_address.get(token_address)
            if not row:
                continue
            result = _process_one_ebc_milestone_result(row, pair)
            if result:
                ebc_to_send.append(result)
        if ebc_to_send and not _is_paused():
            await _send_milestone_updates(app, ebc_to_send)
    except Exception as e:
        logger.warning(f"Gagal proses milestone EBC pra-graduasi (tidak fatal): {e}")

    if not results:
        logger.info("No pre-graduation candidates matched the criteria.")
        _mark_job_run("risky", duration_seconds=time.monotonic() - _cycle_start)
        return

    logger.info(f"Found {len(results)} pre-graduation candidate(s).")
    for pair in results:
        try:
            token_address = pair.get("baseToken", {}).get("address")
            if not token_address or not db.claim_alert_slot(token_address):
                continue  # sudah diklaim tier/job lain di siklus yang nyaris bersamaan
            msg = trending.format_alert_message(pair, is_risky=True)
            _capture_signal_snapshot(pair, "EARLY_BONDING_CURVE", "pumpfun_bonding_curve")
            db.record_snapshot_alert_seen("EARLY_BONDING_CURVE")  # Phase 9 bugfix -- lihat catatan di check_trending_job
            sent = await broadcast(app, msg, reply_markup=_build_keyboard(pair), image_url=pair.get("imageUrl"))
            if not sent:
                logger.warning(f"{token_address}: gagal kirim alert, baseline DIRESET ke 0 (tidak di-track).")
                db.delete_latest_signal_snapshot(token_address)
                db.finalize_alert(token_address, baseline_market_cap=0, last_message_id=None)
                continue
            db.finalize_alert(
                token_address,
                baseline_market_cap=pair.get("marketCap") or 0,
                last_message_id=sent.message_id,
                name=pair.get("baseToken", {}).get("name"),
                symbol=pair.get("baseToken", {}).get("symbol"),
            )
            db.init_signal_outcome(token_address, pair.get("marketCap") or 0, alerted_at=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"))
        except Exception as e:
            logger.warning(f"Failed to process/post one pre-graduation candidate, skipping it: {e}")
            continue

    _mark_job_run("risky", duration_seconds=time.monotonic() - _cycle_start)


async def repair_stuck_baselines(app: Application):
    """
    Migrasi SEKALI-JALAN (bukan tiap restart) -- coba benerin token yang
    baseline-nya kesangkut di $0 dari SEBELUM ada fallback resolver. Fix
    di kode cuma mencegah kejadian BARU -- ini yang benerin sisa-sisa
    dari sebelumnya.

    BUGFIX v2 (laporan user: token "$3%/STONK" dapat pesan "up 1.5x since
    we called it!" padahal alert aslinya TIDAK PERNAH ada -- search di
    channel cuma nemu 1 hasil, pesan milestone itu sendiri): versi
    sebelumnya (Phase 4I) cuma pakai batas UMUR (`older_than_hours`) buat
    bedain baris lama vs baru -- itu SALAH, karena baris yang gagal kirim
    beneran BISA jadi "tua" (>6 jam) tanpa pernah ada pesan asli, dan
    tetap ke-"perbaiki" secara keliru. Sekarang get_stuck_baseline_tokens()
    default-nya mewajibkan `last_message_id IS NOT NULL` -- signal yang
    PASTI benar (finalize_alert selalu nge-set baseline & last_message_id
    BERSAMAAN), bukan sekadar perkiraan umur. Lihat cleanup_wrongly_tracked_tokens()
    di bawah buat pembersihan korban bug versi lama yang SUDAH kejadian.

    Fungsi ini (termasuk kedua panggilan db.set_state()) tetap dibungkus
    fail-safe -- dipanggil TELANJANG dari post_init() tanpa try/except di
    caller, jadi kegagalan apa pun di sini TIDAK BOLEH menjatuhkan startup bot.
    """
    try:
        if db.get_state("stuck_baseline_repair_done"):
            return

        try:
            stuck = db.get_stuck_baseline_tokens()
        except Exception as e:
            logger.warning(f"Gagal ambil daftar token stuck: {e}")
            return  # jangan tandai selesai -- coba lagi di restart berikutnya

        if not stuck:
            try:
                db.set_state("stuck_baseline_repair_done", "1")
            except Exception as e:
                logger.warning(f"Gagal set flag migrasi selesai (bakal dicoba lagi restart berikutnya): {e}")
            return

        logger.info(
            f"Mencoba perbaiki {len(stuck)} token dengan baseline $0 peninggalan lama "
            f"(pesan sudah pernah terkirim, migrasi one-time)..."
        )
        fixed = 0
        for token_address in stuck:
            try:
                pair = await asyncio.to_thread(trending.get_pair_data, token_address)
                if not pair:
                    continue
                mc = pair.get("marketCap") or pair.get("fdv") or 0
                if mc and mc > 0:
                    db.repair_baseline(token_address, mc)
                    fixed += 1
            except Exception as e:
                logger.warning(f"Gagal perbaiki {token_address}: {e}")
                continue

        logger.info(f"Berhasil perbaiki {fixed}/{len(stuck)} token yang stuck.")
        try:
            db.set_state("stuck_baseline_repair_done", "1")
        except Exception as e:
            logger.warning(f"Gagal set flag migrasi selesai (bakal dicoba lagi restart berikutnya): {e}")
    except Exception as e:
        # Jaring pengaman terakhir: fungsi ini dipanggil tanpa try/except
        # dari post_init(), jadi apa pun yang lolos dari penanganan di atas
        # TIDAK BOLEH sampai bikin bot gagal start.
        logger.warning(f"repair_stuck_baselines() gagal total, dilewati (tidak fatal): {e}")


async def cleanup_wrongly_tracked_tokens(app: Application):
    """
    Migrasi SEKALI-JALAN (flag TERPISAH dari repair_stuck_baselines,
    karena ini masalah BEDA) -- bersihkan KORBAN bug lama: token yang
    SUDAH terlanjur trackable (baseline_market_cap > 0) padahal tidak
    pernah punya pesan asli (last_message_id NULL).

    Ini remediation, bukan pencegahan -- repair_stuck_baselines() versi
    lama (sebelum last_message_id jadi syarat wajib) bisa saja SUDAH
    salah "memperbaiki" baris seperti ini di masa lalu, dan itu tidak
    bisa dibetulkan sendiri cuma dengan memperbaiki query ke depan --
    baris yang SUDAH kena harus dicari & di-untrack manual sekali ini.

    Fail-safe sama seperti repair_stuck_baselines(): dipanggil telanjang
    dari post_init(), jadi TIDAK BOLEH menjatuhkan startup bot.
    """
    try:
        if db.get_state("wrongly_tracked_cleanup_done"):
            return

        try:
            wrongly_tracked = db.get_wrongly_tracked_tokens()
        except Exception as e:
            logger.warning(f"Gagal ambil daftar token yang salah ke-track: {e}")
            return  # jangan tandai selesai -- coba lagi di restart berikutnya

        for token_address in wrongly_tracked:
            try:
                db.untrack_falsely_tracked_token(token_address)
            except Exception as e:
                logger.warning(f"Gagal untrack {token_address}: {e}")
                continue

        if wrongly_tracked:
            logger.info(
                f"Berhasil untrack {len(wrongly_tracked)} token yang salah ke-track "
                f"(baseline ada tapi tidak pernah ada pesan asli -- korban bug lama)."
            )
        try:
            db.set_state("wrongly_tracked_cleanup_done", "1")
        except Exception as e:
            logger.warning(f"Gagal set flag cleanup selesai (bakal dicoba lagi restart berikutnya): {e}")
    except Exception as e:
        logger.warning(f"cleanup_wrongly_tracked_tokens() gagal total, dilewati (tidak fatal): {e}")


async def repair_corrupted_ath_entries(app: Application):
    """
    Jalan SEKALI tiap kali bot start: bersihkan token yang ATH-nya
    kebukti tidak masuk akal (misal jutaan/miliaran x) dari SEBELUM ada
    sanity cap di update_ath_if_higher. Direset ke "belum ada kenaikan
    terkonfirmasi" supaya tidak terus muncul di Hall of Fame dengan
    angka yang jelas-jelas keliru.

    BUGFIX PRODUKSI KRITIS (laporan user: bot "Active" di Railway tapi
    TIDAK PERNAH bereaksi ke command Telegram apa pun, berkali-kali
    setelah restart) -- akar masalah: fungsi ini SATU-SATUNYA di antara
    5 rutinitas startup post_init() yang TIDAK punya try/except sama
    sekali (beda dari repair_stuck_baselines/cleanup_wrongly_tracked_tokens/
    repair_thin_liquidity_ath yang semuanya sudah dilindungi). Dipanggil
    TELANJANG dari post_init(), yang jalan DI DALAM run_polling() --
    kalau db.repair_corrupted_ath() gagal (mis. disk penuh) buat SATU
    SAJA token, exception-nya nembus ke atas & MENJATUHKAN SELURUH
    run_polling() SEBELUM bot sempat mulai memproses pesan Telegram sama
    sekali. Traceback produksi yang dikonfirmasi user PERSIS menunjuk ke
    frame run_polling() ini.

    Sekarang dilindungi 2 lapis, PERSIS pola yang sudah dipakai
    saudara-saudaranya: try/except PER TOKEN (1 token gagal tidak
    menghentikan sisanya) + try/except LUAR sebagai jaring pengaman
    terakhir (kegagalan apa pun di sini TIDAK BOLEH menjatuhkan startup bot).
    """
    try:
        try:
            corrupted = db.get_corrupted_ath_tokens(max_multiplier=trending.MAX_ATH_MULTIPLIER)
        except Exception as e:
            logger.warning(f"Gagal ambil daftar token dengan ATH corrupt: {e}")
            return

        if not corrupted:
            return

        logger.info(f"Membersihkan {len(corrupted)} token dengan ATH yang tidak masuk akal (data glitch lama)...")
        fixed = 0
        for token_address in corrupted:
            try:
                db.repair_corrupted_ath(token_address)
                fixed += 1
            except Exception as e:
                logger.warning(f"Gagal bersihkan ATH corrupt {token_address}: {e}")
                continue
        logger.info(f"Selesai membersihkan {fixed}/{len(corrupted)} token.")
    except Exception as e:
        # Jaring pengaman terakhir: fungsi ini dipanggil tanpa try/except
        # dari post_init(), jadi apa pun yang lolos dari penanganan di atas
        # TIDAK BOLEH sampai bikin bot gagal start.
        logger.warning(f"repair_corrupted_ath_entries() gagal total, dilewati (tidak fatal): {e}")


async def repair_thin_liquidity_ath(app: Application):
    """
    Jalan SEKALI tiap kali bot start: SEMUA token yang lagi di-track
    dicek ulang liquidity-nya SEKARANG. Kalau ternyata sudah nyaris nol
    (kemungkinan besar kena rug SETELAH dialert, sebelum sanity check
    liquidity ini ada), reset ATH/milestone-nya — soalnya kita nggak
    bisa lagi bedain mana kenaikan asli vs artifact matematis dari
    liquidity yang ditarik.

    Ini yang nangkep kasus kayak RABROC/POKECOIN/MEDUSA yang lolos dari
    repair_corrupted_ath_entries (soalnya multiplier-nya di bawah cap
    1000x, meski liquidity-nya sekarang jelas-jelas sudah rusak).
    """
    try:
        tracked = db.get_trackable_tokens()
    except Exception as e:
        logger.warning(f"Gagal ambil daftar token buat cek liquidity: {e}")
        return

    fixed = 0
    for row in tracked:
        try:
            token_address = row["token_address"]
            if row["last_milestone"] < 2.0:
                continue  # cuma perlu cek yang udah masuk Hall of Fame

            pair = await asyncio.to_thread(trending.get_pair_data, token_address)
            if not pair:
                continue

            current_liquidity = (pair.get("liquidity") or {}).get("usd", 0) or 0
            current_mc = pair.get("marketCap") or pair.get("fdv") or 0

            is_thin = (
                current_liquidity < trending.MILESTONE_MIN_LIQUIDITY_USD
                or (current_mc > 0 and (current_liquidity / current_mc) < trending.MILESTONE_MIN_LIQUIDITY_TO_MCAP_RATIO)
            )
            if is_thin:
                db.repair_corrupted_ath(token_address)
                fixed += 1
        except Exception as e:
            logger.warning(f"Gagal cek ulang liquidity {token_address}: {e}")
            continue

    if fixed:
        logger.info(f"Membersihkan {fixed} token dari Hall of Fame karena liquidity-nya sekarang sudah nyaris nol.")


async def backfill_missing_token_names(app: Application):
    """
    Jalan SEKALI tiap kali bot start: isi nama/simbol token yang masih
    kosong ("Unknown") dari SEBELUM kolom token_name/token_symbol ada.
    """
    try:
        missing = db.get_tokens_missing_name()
    except Exception as e:
        logger.warning(f"Gagal ambil daftar token tanpa nama: {e}")
        return

    if not missing:
        return

    logger.info(f"Mencoba lengkapi nama untuk {len(missing)} token lama...")
    fixed = 0
    for token_address in missing:
        try:
            pair = await asyncio.to_thread(trending.get_pair_data, token_address)
            if not pair:
                continue
            base = pair.get("baseToken", {})
            name, symbol = base.get("name"), base.get("symbol")
            if name:
                db.backfill_token_name(token_address, name, symbol or "")
                fixed += 1
        except Exception as e:
            logger.warning(f"Gagal lengkapi nama {token_address}: {e}")
            continue

    logger.info(f"Berhasil lengkapi nama {fixed}/{len(missing)} token.")


async def post_init(app: Application):
    """
    Dipanggil python-telegram-bot SETELAH event loop benar-benar jalan.
    Scheduler HARUS disetup di sini (bukan di main() biasa), karena
    Python versi baru (3.12+) tidak lagi otomatis membuat event loop
    di luar konteks async — itu penyebab error 'no current event loop'.
    """
    scheduler = AsyncIOScheduler()

    # Ambil username bot sendiri, dibutuhkan buat bikin deep-link
    # "https://t.me/<username>?start=ads" di tombol "Put your ads here".
    try:
        me = await app.bot.get_me()
        trending.BOT_USERNAME = me.username
    except Exception as e:
        logger.warning(f"Gagal ambil username bot sendiri: {e}")

    # Perbaiki dulu sisa-sisa token yang baseline-nya stuck $0 dari sebelumnya.
    #
    # BUGFIX PRODUKSI KRITIS (laporan user: bot "Active" tapi TOTAL tidak
    # bereaksi ke command apa pun, berkali-kali) -- SEMUA 5 pemanggilan
    # rutinitas startup ini SEKARANG dibungkus try/except di titik
    # PANGGILAN ini juga (lapis KE-3, di atas 2 lapis internal masing2
    # fungsi) -- pertahanan berlapis, supaya SEKALIPUN ada bug serupa
    # (lupa nangkep exception) muncul lagi di fungsi manapun nanti,
    # post_init() -- yang jalan DI DALAM run_polling() -- TIDAK PERNAH
    # lagi bisa menjatuhkan SELURUH proses menerima pesan Telegram.
    for repair_fn in (repair_stuck_baselines, cleanup_wrongly_tracked_tokens,
                      repair_corrupted_ath_entries, repair_thin_liquidity_ath,
                      backfill_missing_token_names):
        try:
            await repair_fn(app)
        except Exception as e:
            logger.warning(f"{repair_fn.__name__}() gagal total di titik panggilan post_init (tidak fatal, startup tetap lanjut): {e}")

    scheduler.add_job(
        check_trending_job,
        "interval",
        seconds=CHECK_INTERVAL_SECONDS,
        args=[app],
    )
    scheduler.add_job(
        check_payments_job,
        "interval",
        seconds=CHECK_PAYMENT_INTERVAL_SECONDS,
        args=[app],
    )
    scheduler.add_job(
        check_ads_job,
        "interval",
        seconds=CHECK_PAYMENT_INTERVAL_SECONDS,
        args=[app],
    )
    scheduler.add_job(
        check_fresh_graduates_job,
        "interval",
        seconds=CHECK_FRESH_INTERVAL_SECONDS,
        args=[app],
    )
    scheduler.add_job(
        check_dex_activity_job,
        "interval",
        seconds=CHECK_DEX_ACTIVITY_INTERVAL_SECONDS,
        args=[app],
    )
    scheduler.add_job(
        check_milestones_job,
        "interval",
        seconds=CHECK_MILESTONE_INTERVAL_SECONDS,
        args=[app],
    )
    scheduler.add_job(
        check_risky_job,
        "interval",
        seconds=CHECK_RISKY_INTERVAL_SECONDS,
        args=[app],
    )
    scheduler.add_job(
        evaluate_post_alert_intelligence_job,
        "interval",
        seconds=INTELLIGENCE_V1_POST_ALERT_JOB_INTERVAL_SECONDS,
        args=[app],
    )
    scheduler.add_job(
        check_recap_job,
        CronTrigger(hour="*/6", minute=0, timezone="UTC"),
        args=[app],
        misfire_grace_time=1800,  # kalau bot sempat mati pas jadwal, masih dianggap valid kalau nyala lagi dalam 30 menit
    )
    scheduler.add_job(
        prune_behavioral_telemetry_job,
        CronTrigger(hour=3, minute=0, timezone="UTC"),  # sekali sehari, jam sepi
        args=[app],
        misfire_grace_time=3600,
    )
    scheduler.start()
    logger.info("Scheduler aktif.")

    # Panggil sekali pas startup juga -- supaya begitu bot baru nyala (misal
    # abis redeploy), langsung dicek apakah hari UTC sudah ganti sejak
    # terakhir recap final harian jalan, tanpa perlu nunggu sampai jadwal
    # 3-jam-an berikutnya.
    #
    # BUGFIX PRODUKSI PALING KRITIS -- dibungkus try/except di titik
    # panggilan ini juga (lapis pertahanan TAMBAHAN, di atas perbaikan
    # internal check_recap_job() itu sendiri) -- persis pola yang sudah
    # diterapkan ke 5 rutinitas startup lain di atas. TIDAK PERNAH lagi
    # boleh ada satu panggilan pun di post_init() yang bisa menjatuhkan
    # SELURUH proses run_polling() cuma gara-gara satu kegagalan internal.
    try:
        await check_recap_job(app)
    except Exception as e:
        logger.warning(f"check_recap_job() gagal total di titik panggilan post_init (tidak fatal, startup tetap lanjut): {e}")


def main():
    db.init_db()
    _load_persisted_criteria()

    app = Application.builder().token(BOT_TOKEN).post_init(post_init).build()

    # Command yang harus BISA motong alur dari state mana pun -- ditempel
    # LANGSUNG ke tiap state (bukan cuma di fallbacks, yang terbukti nggak
    # reliable buat kasus ini), biar ganti command di tengah alur ads/promote
    # bikin bot langsung move on, bukan macet.
    _escape_commands = [
        CommandHandler("start", start),
        CommandHandler("promote", promote),
        CommandHandler("ads", ads_entry),
        MessageHandler(filters.COMMAND, conversation_interrupted_by_other_command),
    ]

    ads_conv_handler = ConversationHandler(
        entry_points=[
            CommandHandler("start", start),
            CommandHandler("ads", ads_entry),
            CallbackQueryHandler(menu_promote_callback, pattern="^menu_promote$"),
            CallbackQueryHandler(menu_ads_callback, pattern="^menu_ads$"),
        ],
        states={
            ADS_CONFIRM_QUEUE: [CallbackQueryHandler(ads_confirm_queue_callback, pattern="^ads_confirm_"), *_escape_commands],
            ADS_ASKING_TEXT: [MessageHandler(filters.TEXT & ~filters.COMMAND, ads_receive_text), *_escape_commands],
            ADS_ASKING_LINK: [MessageHandler(filters.TEXT & ~filters.COMMAND, ads_receive_link), *_escape_commands],
            ADS_ASKING_DURATION: [CallbackQueryHandler(ads_receive_duration, pattern="^ads_duration_"), *_escape_commands],
            PROMOTE_ASKING_ADDRESS: [MessageHandler(filters.TEXT & ~filters.COMMAND, promote_receive_address), *_escape_commands],
        },
        fallbacks=[CommandHandler("cancel", ads_cancel), *_escape_commands],
    )
    app.add_handler(ads_conv_handler)
    app.add_handler(CommandHandler("promote", promote))
    app.add_handler(CommandHandler("pending", pending))
    app.add_handler(CommandHandler("reject", reject))
    app.add_handler(CommandHandler("approvepromo", approvepromo))
    app.add_handler(CommandHandler("approvead", approvead))
    app.add_handler(CommandHandler("health", health))
    app.add_handler(CommandHandler("outcomes", outcomes))
    app.add_handler(CommandHandler("holderdiag", holderdiag))
    app.add_handler(CommandHandler("srscore", srscore))
    app.add_handler(CommandHandler("autopsy", autopsy))
    app.add_handler(CommandHandler("intelreport", intelreport))
    app.add_handler(CommandHandler("phase11audit", phase11audit))
    app.add_handler(CommandHandler("ebcprovenance", ebc_provenance))
    app.add_handler(CommandHandler("intelligenceaudit", intelligence_audit))
    app.add_handler(CommandHandler("pressureablation", pressure_ablation))
    app.add_handler(CommandHandler("intelreport2", intelreport2))
    app.add_handler(CommandHandler("diagnosezeros", diagnose_zeros))
    app.add_handler(CommandHandler("cleanuptelemetry", cleanup_telemetry))
    app.add_handler(CommandHandler("walcheckpoint", wal_checkpoint_now))
    app.add_handler(CommandHandler("diskusage", disk_usage))
    app.add_handler(CommandHandler("prunenow", prune_now))
    app.add_handler(CallbackQueryHandler(pnlcard_callback, pattern="^pnlcard:"))
    app.add_handler(CommandHandler("checktoken", checktoken))
    app.add_handler(CommandHandler("cmctest", cmctest))
    app.add_handler(CommandHandler("setcriteria", setcriteria))
    app.add_handler(CommandHandler("pause", pause_bot))
    app.add_handler(CommandHandler("resume", resume_bot))
    app.add_handler(CommandHandler("exportdb", exportdb))
    app.add_error_handler(global_error_handler)

    logger.info("Bot mulai jalan...")
    app.run_polling()


if __name__ == "__main__":
    main()
