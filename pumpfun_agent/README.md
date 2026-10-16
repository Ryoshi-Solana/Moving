# Agent trading pump.fun

Agent ini memantau semua token baru di pump.fun secara realtime, belajar
perilaku market & narrative, membeli token yang sedang punya momentum, dan
menjaga risiko dengan stop loss ketat. Kamu mengontrol & menerima laporan
lewat Telegram.

> ⚠️ **Baca dulu.** Mayoritas token pump.fun berakhir mendekati nol, dan
> banyak trader di sana adalah bot yang lebih cepat dari agent ini. Hasil
> paper trading **selalu lebih bagus** daripada live (tidak ada tx gagal,
> tidak ada MEV, likuiditas tidak benar-benar terpakai). Anggap modal live
> sebagai biaya belajar yang siap hilang 100%. Ini bukan nasihat keuangan.

---

## Cara kerja

```
PumpPortal (gratis) + RPC Solana ──► MarketTracker ──► fitur momentum per token
  (token baru, trade,    NarrativeTracker ──► kata kunci yang sedang panas
   migrasi)                      │
                                 ▼
                  filter keras ──► skor 0–100 ──► RiskManager ──► Broker (paper / live)
                                 │                                    │
                                 ▼                                    ▼
                  Learner (catat semua sinyal,               Exit manager tiap trade:
                  ikuti hasilnya, sesuaikan bobot            SL, breakeven, trailing,
                  & min_score)                               TP1/TP2, dev dump, waktu
                                 │
                                 ▼
                      Telegram (laporan + perintah)
```

**Entry.** Token harus lolos filter keras dulu (umur, market cap, jumlah
pembeli unik, volume beli, tidak didominasi satu wallet, dev belum jual,
holder tidak terlalu terpusat, bukan falling knife). Lalu diberi skor dari
7 komponen: tekanan beli, volume, jumlah pembeli, momentum harga,
akselerasi trade, panasnya narrative, dan sebaran holder. Beli kalau skor ≥
`min_score` dan risk manager mengizinkan.

**Narrative.** Nama & simbol tiap token baru dipecah jadi kata kunci. Tema
dianggap panas kalau peluncurannya sedang naik dibanding 3 jam terakhir
**dan** menyedot porsi besar dari uang beli di market. Lihat dengan `/narrative`.

**Exit** (dicek di setiap trade yang masuk, bukan per menit):

| Aturan | Default |
| --- | --- |
| Stop loss keras dari harga masuk efektif (termasuk fee) | -12% |
| SL naik ke titik impas setelah naik | +20% |
| TP1: jual 50% | +40% |
| TP2: jual 50% sisa | +100% |
| Trailing stop setelah naik 30% | 15% dari puncak |
| Keluar kalau dev jual ≥50% / tekanan jual tinggi saat profit | aktif |
| Tidak bergerak +5% dalam 4 menit → keluar | aktif |
| Maksimal ditahan | 20 menit |

**Risiko.**
- Ukuran posisi dihitung supaya kalau SL kena, rugi ≈ 2% equity (biaya
  pulang-pergi ikut dihitung), dan maksimal 10% equity / 0.1 SOL.
- Maksimal 3 posisi bersamaan, tidak beli ulang token yang sama dalam 30 menit.
- 4x rugi beruntun → istirahat 30 menit.
- Rugi harian 15% → tidak buka posisi baru sampai besok.
- Drawdown 35% dari puncak → **kill switch**: semua posisi dijual, agent
  berhenti sampai kamu kirim `/resume yakin`.

**Belajar.** Setiap token yang lolos filter dicatat sebagai sinyal, *dibeli
atau tidak*, lalu harganya diikuti 15 menit: menang kalau menyentuh +30%
sebelum -SL. Setiap 30 menit (setelah ≥40 sampel) agent:
- menggeser bobot komponen skor ke arah yang membedakan pemenang (maks ±50%)
- menggeser `min_score` ke ambang dengan ekspektasi terbaik (maks 5 poin per langkah, batas 55–85)

Setiap perubahan dilaporkan ke Telegram. Matikan dengan `/set auto_tune false`.

> Perlu jujur: "SL ketat" di pump.fun tidak bisa dijamin. Harga bisa
> loncat melewati SL dalam satu transaksi (dev dump, rug). Di simulasi, SL
> -12% terealisasi sekitar -16% setelah fee & gap; di live bisa lebih buruk.

---

## Instalasi

Butuh Python 3.11+ dan server yang nyala 24 jam (VPS kecil cukup).

```bash
cd pumpfun_agent
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

### Data market: gratis, tanpa akun

- **Token baru & migrasi**: stream gratis PumpPortal, tanpa API key.
- **Trade (harga, volume, wallet)**: dibaca langsung dari blockchain. Agent
  berlangganan log program pump.fun lewat websocket RPC publik Solana
  (`logsSubscribe`) dan men-decode event `TradeEvent`. RPC dicoba bergiliran
  kalau satu putus (`SOLANA_WS_URLS`).

> ⚠️ Jangan pakai `subscribeTokenTrade` PumpPortal: biayanya 0.01 SOL per
> 10.000 pesan, dipotong dari wallet API key (±0.9 SOL/hari di volume normal).
> Free tier RPC yang menghitung websocket per MB (mis. Helius) juga habis dalam
> hitungan menit karena volume pump.fun besar.

### Siapkan Telegram

1. Chat [@BotFather](https://t.me/BotFather) → `/newbot` → salin token ke `TELEGRAM_BOT_TOKEN`.
2. Chat [@userinfobot](https://t.me/userinfobot) → salin angka id ke `TELEGRAM_CHAT_ID`.
3. Kirim `/start` ke bot kamu sekali supaya bot boleh mengirimimu pesan.

Bot hanya merespon chat id tersebut; orang lain yang menemukan bot kamu diabaikan.

### Jalankan (paper trading)

```bash
python -m pfagent check   # cek konfigurasi
python -m pfagent run
```

Agar tetap jalan setelah logout, pakai `tmux`, `screen`, atau systemd:

```ini
# /etc/systemd/system/pfagent.service
[Unit]
Description=pump.fun agent
After=network-online.target

[Service]
WorkingDirectory=/home/kamu/Moving/pumpfun_agent
ExecStart=/home/kamu/Moving/pumpfun_agent/.venv/bin/python -m pfagent run
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Posisi, saldo paper, parameter, dan state risiko disimpan di
`data/agent.db`, jadi restart tidak menghilangkan apa pun.

---

## Perintah Telegram

| Perintah | Fungsi |
| --- | --- |
| `/status` | kondisi agent, equity, mode, feed |
| `/posisi` | posisi terbuka, PnL berjalan, posisi SL |
| `/trades` | 10 trade terakhir |
| `/pnl` | ringkasan 24 jam, 7 hari, sepanjang waktu |
| `/narrative` | narrative paling panas |
| `/kandidat` | token yang sedang dipertimbangkan + alasan penolakan terbanyak |
| `/belajar` | win rate per rentang skor, bobot komponen saat ini |
| `/params` | semua parameter |
| `/set nama nilai` | ubah parameter live, mis. `/set stop_loss_pct 10` |
| `/pause` · `/resume` | jeda / lanjut buka posisi baru |
| `/close MINT` · `/close all` | jual sekarang |
| `/report` | laporan harian sekarang |

Notifikasi otomatis: setiap beli, TP sebagian, tutup posisi (dengan alasan
& PnL), rem darurat, perubahan strategi dari learner, dan laporan harian
jam 21:00 WIB.

---

## Rekam & replay (backtest)

Isi `AGENT_RECORD_PATH=data/feed.jsonl` saat paper trading. Semua event market
disimpan, lalu kamu bisa menguji parameter lain di data yang sama:

```bash
python -m pfagent replay data/feed.jsonl --balance 1 --verbose
```

---

## Pindah ke live

Jangan pindah sebelum ini terpenuhi:

1. **Minimal 2 minggu paper trading** dengan ≥100 trade tertutup.
2. `/pnl` sepanjang waktu positif **dan** profit factor > 1.3. Kalau profit
   tipis di paper, di live hampir pasti rugi.
3. `/belajar` menunjukkan skor tinggi memang punya ekspektasi lebih bagus
   dari skor rendah (kalau tidak, skornya belum punya edge).

Lalu:

1. Buat **wallet baru** khusus agent. Jangan pakai wallet utama. Isi kecil
   dulu (mis. 0.5 SOL).
2. Daftar RPC privat (Helius / Triton / QuickNode); RPC publik ditolak.
3. Di `.env`:
   ```
   AGENT_MODE=live
   WALLET_PRIVATE_KEY=...base58...
   SOLANA_RPC_URL=https://...
   LIVE_MAX_POSITION_SOL=0.05
   LIVE_TRADING_CONFIRM=SAYA_PAHAM_RISIKONYA
   ```
4. `python -m pfagent check` lalu `run`.

Cara kerja live: PumpPortal (`/api/trade-local`) membuat transaksi,
transaksi **ditandatangani di mesinmu** (private key tidak pernah dikirim ke
mana pun), dikirim lewat RPC kamu, lalu jumlah SOL & token sebenarnya dibaca
dari transaksi on-chain. PumpPortal memungut fee 0.5% per trade; pump.fun
juga memungut fee-nya sendiri. `LIVE_MAX_POSITION_SOL` adalah batas keras yang
tidak bisa dilewati lewat `/set`. Riwayat paper dan live disimpan terpisah.

Simpan `.env` dengan izin `chmod 600 .env`. Siapa pun yang bisa membaca file
itu bisa menguras wallet agent.

---

## Struktur kode

```
pfagent/
  config.py      Settings (.env) & Params (bisa /set)
  feed.py        websocket PumpPortal + reconnect + rekam
  market.py      state per token & fitur momentum
  narrative.py   deteksi narrative dari nama/simbol & aliran uang
  strategy.py    skor entry, filter keras, exit manager
  risk.py        ukuran posisi, cooldown, batas harian, kill switch
  broker.py      PaperBroker (simulasi bonding curve) & LiveBroker
  learner.py     catat sinyal, ikuti hasil, auto-tune
  engine.py      orkestrasi semua di atas
  reports.py     teks laporan
  telegram_ui.py bot Telegram
tests/           test offline (simulator bonding curve, RPC tiruan)
```

```bash
pip install -r requirements-dev.txt
python -m pytest -q tests
```

Semua test berjalan offline: tidak butuh jaringan, Telegram, atau wallet.

---

## Ide pengembangan berikutnya

- Penilaian narrative pakai LLM (baca deskripsi & tweet token, nilai kualitas meme).
- Cek wallet dev: berapa token yang pernah dia buat & berapa yang rug.
- Deteksi bundle/sniper di blok pertama.
- Kirim lewat Jito bundle untuk eksekusi live yang lebih cepat.
