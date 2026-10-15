"""
Antarmuka Telegram: laporan otomatis + perintah untuk mengontrol agent.
Hanya chat dengan TELEGRAM_CHAT_ID yang dilayani; pesan dari orang lain diabaikan.
"""

from __future__ import annotations

import logging
import re
import time
from typing import TYPE_CHECKING

from . import reports

if TYPE_CHECKING:
    from .engine import Agent
    from .config import Settings

log = logging.getLogger(__name__)

HELP = """<b>Perintah agent</b>
/status – kondisi agent, equity, mode
/posisi – posisi terbuka
/trades – 10 trade terakhir
/pnl – ringkasan profit/rugi
/narrative – narrative yang sedang panas
/kandidat – token yang lagi dipertimbangkan & alasan ditolak
/belajar – apa yang sudah dipelajari agent
/params – semua parameter
/set nama nilai – ubah parameter (mis. /set stop_loss_pct 10)
/pause – stop buka posisi baru (posisi lama tetap dijaga SL/TP)
/resume – lanjut (setelah kill switch: /resume yakin)
/close MINT – jual satu posisi sekarang · /close all – jual semua
/report – laporan harian sekarang"""


class TelegramUI:
    def __init__(self, settings: "Settings"):
        self.s = settings
        self.agent: "Agent | None" = None
        self.app = None
        self.feed = None
        self.enabled = bool(settings.telegram_token and settings.telegram_chat_id)

    async def send(self, text: str) -> None:
        if not self.enabled or self.app is None:
            log.info("[notify] %s", re.sub(r"<[^>]+>", "", text))
            return
        from telegram.constants import ParseMode
        try:
            for i in range(0, len(text), 4000):
                await self.app.bot.send_message(
                    chat_id=self.s.telegram_chat_id, text=text[i:i + 4000],
                    parse_mode=ParseMode.HTML, disable_web_page_preview=True,
                )
            self._send_failures = 0
        except Exception as exc:
            # Telegram bermasalah tidak boleh mematikan agent: trading & SL tetap jalan.
            self._send_failures = getattr(self, "_send_failures", 0) + 1
            if self._send_failures in (1, 10, 100) or self._send_failures % 1000 == 0:
                hint = (" — cek TELEGRAM_CHAT_ID dan pastikan kamu sudah kirim /start ke bot"
                        if "chat not found" in str(exc).lower() else "")
                log.error("gagal kirim Telegram (%dx): %s%s", self._send_failures, exc, hint)
            log.info("[notify] %s", re.sub(r"<[^>]+>", "", text))

    async def start(self, agent: "Agent", feed=None) -> None:
        self.agent = agent
        self.feed = feed
        if not self.enabled:
            log.warning("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID kosong → notifikasi hanya ke log")
            return
        from telegram import BotCommand
        from telegram.ext import Application, CommandHandler, filters

        self.app = Application.builder().token(self.s.telegram_token).build()
        only_me = filters.Chat(chat_id=self.s.telegram_chat_id)
        handlers = {
            ("start", "help"): self.cmd_help,
            ("status",): self.cmd_status,
            ("posisi", "positions"): self.cmd_positions,
            ("trades",): self.cmd_trades,
            ("pnl",): self.cmd_pnl,
            ("narrative", "narasi"): self.cmd_narrative,
            ("kandidat", "candidates"): self.cmd_candidates,
            ("belajar", "learn"): self.cmd_learn,
            ("params",): self.cmd_params,
            ("set",): self.cmd_set,
            ("pause",): self.cmd_pause,
            ("resume",): self.cmd_resume,
            ("close",): self.cmd_close,
            ("report",): self.cmd_report,
        }
        for names, fn in handlers.items():
            self.app.add_handler(CommandHandler(list(names), fn, filters=only_me))
        self.app.add_error_handler(self._on_error)

        await self.app.initialize()
        await self.app.start()
        await self.app.updater.start_polling(drop_pending_updates=True)
        try:
            await self.app.bot.set_my_commands([
                BotCommand(n[0], n[0]) for n in handlers if n[0] not in ("start",)
            ])
        except Exception:
            pass

    async def stop(self) -> None:
        if self.app is None:
            return
        try:
            await self.app.updater.stop()
            await self.app.stop()
            await self.app.shutdown()
        except Exception:
            log.exception("gagal mematikan telegram")

    async def _on_error(self, update, context) -> None:
        log.error("telegram error: %s", context.error)

    async def _reply(self, update, text: str) -> None:
        from telegram.constants import ParseMode
        for i in range(0, len(text), 4000):
            await update.effective_message.reply_text(
                text[i:i + 4000], parse_mode=ParseMode.HTML, disable_web_page_preview=True,
            )

    # ---------- perintah ----------

    async def cmd_help(self, update, context):
        await self._reply(update, HELP)

    async def cmd_status(self, update, context):
        connected = getattr(self.feed, "connected", None)
        await self._reply(update, reports.status_text(self.agent, time.time(), connected))

    async def cmd_positions(self, update, context):
        await self._reply(update, reports.positions_text(self.agent, time.time()))

    async def cmd_trades(self, update, context):
        await self._reply(update, reports.trades_text(self.agent))

    async def cmd_pnl(self, update, context):
        await self._reply(update, reports.pnl_text(self.agent, time.time()))

    async def cmd_narrative(self, update, context):
        await self._reply(update, reports.narratives_text(self.agent, time.time()))

    async def cmd_candidates(self, update, context):
        await self._reply(update, reports.candidates_text(self.agent))

    async def cmd_learn(self, update, context):
        await self._reply(update, reports.learn_text(self.agent))

    async def cmd_params(self, update, context):
        await self._reply(update, reports.params_text(self.agent))

    async def cmd_report(self, update, context):
        await self._reply(update, reports.daily_report(self.agent, time.time()))

    async def cmd_set(self, update, context):
        args = context.args or []
        if len(args) != 2:
            await self._reply(update, "Format: /set nama nilai\nLihat nama parameter di /params")
            return
        key, raw = args
        agent = self.agent
        if agent.mode == "live" and key == "max_position_sol":
            try:
                if float(raw) > self.s.live_max_position_sol:
                    await self._reply(update, f"Ditolak: batas keras live adalah {self.s.live_max_position_sol} SOL "
                                              "(LIVE_MAX_POSITION_SOL di .env)")
                    return
            except ValueError:
                pass
        try:
            old = getattr(agent.p, key, None)
            new = agent.p.set(key, raw)
        except ValueError as exc:
            await self._reply(update, f"Ditolak: {reports.esc(exc)}")
            return
        agent.save_state()
        await self._reply(update, f"✔ <code>{key}</code>: {old} → {new}")

    async def cmd_pause(self, update, context):
        self.agent.risk.state.paused = True
        self.agent.save_state()
        await self._reply(update, "⏸ Dijeda. Tidak buka posisi baru; posisi terbuka tetap dijaga SL/TP.")

    async def cmd_resume(self, update, context):
        agent = self.agent
        st = agent.risk.state
        if st.halted and (context.args or [""])[0].lower() != "yakin":
            await self._reply(update, f"Agent berhenti karena: {reports.esc(st.halt_reason)}\n"
                                      "Kalau kamu sudah evaluasi dan mau lanjut, kirim: /resume yakin")
            return
        agent.risk.resume(agent.equity())
        agent.save_state()
        await self._reply(update, "▶️ Agent aktif lagi.")

    async def cmd_close(self, update, context):
        args = context.args or []
        if not args:
            await self._reply(update, "Format: /close MINT atau /close all")
            return
        agent = self.agent
        if args[0].lower() == "all":
            n = await agent.close_all("MANUAL")
            await self._reply(update, f"Menutup {n} posisi.")
            return
        target = args[0]
        matches = [m for m in agent.positions if m == target or m.startswith(target)
                   or agent.positions[m].symbol.lower() == target.lower()]
        if len(matches) != 1:
            await self._reply(update, "Posisi tidak ditemukan (atau ambigu). Cek /posisi.")
            return
        ok = await agent.close_position(matches[0], "MANUAL")
        await self._reply(update, "Ditutup." if ok else "Gagal menutup, akan dicoba lagi otomatis.")
