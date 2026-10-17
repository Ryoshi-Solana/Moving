"""
Konfigurasi agent.

Ada dua lapis:
  - Settings      : dibaca sekali dari environment (token, wallet, mode). Tidak bisa
                    diubah dari Telegram.
  - Params        : parameter strategi & risiko. Bisa diubah live lewat /set dan
                    disimpan ke database supaya tahan restart.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field, fields, asdict

LIVE_CONFIRM_PHRASE = "SAYA_PAHAM_RISIKONYA"


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _env_float(name: str, default: float) -> float:
    raw = _env(name)
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


@dataclass
class Settings:
    mode: str = "paper"  # "paper" | "live"
    telegram_token: str = ""
    telegram_chat_id: int = 0
    db_path: str = "data/agent.db"
    record_path: str = ""  # kalau diisi, semua event feed disimpan (jsonl) untuk replay

    ws_url: str = "wss://pumpportal.fun/api/data"
    # websocket RPC Solana untuk trade on-chain (gratis); dipisah koma, dicoba bergiliran
    solana_ws_urls: str = "wss://api.mainnet-beta.solana.com,wss://solana-rpc.publicnode.com"
    trade_api_url: str = "https://pumpportal.fun/api/trade-local"
    rpc_url: str = "https://api.mainnet-beta.solana.com"

    wallet_private_key: str = ""  # base58, HANYA untuk mode live
    live_confirm: str = ""
    # Batas atas keras untuk mode live. /set tidak bisa melewati angka ini.
    live_max_position_sol: float = 0.05

    paper_start_balance_sol: float = 1.0
    tz_offset_hours: float = 7.0  # WIB, dipakai untuk reset harian & jam laporan
    daily_report_hour: int = 21
    fetch_metadata: bool = True

    @classmethod
    def from_env(cls) -> "Settings":
        chat = _env("TELEGRAM_CHAT_ID", "0")
        return cls(
            mode=_env("AGENT_MODE", "paper").lower(),
            telegram_token=_env("TELEGRAM_BOT_TOKEN"),
            telegram_chat_id=int(chat) if chat.lstrip("-").isdigit() else 0,
            db_path=_env("AGENT_DB_PATH", "data/agent.db"),
            record_path=_env("AGENT_RECORD_PATH"),
            ws_url=_env("PUMPPORTAL_WS_URL", cls.ws_url),
            solana_ws_urls=_env("SOLANA_WS_URLS", cls.solana_ws_urls),
            trade_api_url=_env("PUMPPORTAL_TRADE_URL", cls.trade_api_url),
            rpc_url=_env("SOLANA_RPC_URL", cls.rpc_url),
            wallet_private_key=_env("WALLET_PRIVATE_KEY"),
            live_confirm=_env("LIVE_TRADING_CONFIRM"),
            live_max_position_sol=_env_float("LIVE_MAX_POSITION_SOL", 0.05),
            paper_start_balance_sol=_env_float("PAPER_START_BALANCE_SOL", 1.0),
            tz_offset_hours=_env_float("TZ_OFFSET_HOURS", 7.0),
            daily_report_hour=int(_env_float("DAILY_REPORT_HOUR", 21)),
            fetch_metadata=_env("FETCH_METADATA", "true").lower() != "false",
        )

    def ws_url_list(self) -> list[str]:
        return [u.strip() for u in self.solana_ws_urls.split(",") if u.strip()]

    def validate(self) -> list[str]:
        """Kembalikan daftar error. Kosong = aman dijalankan."""
        errors = []
        if self.mode not in ("paper", "live"):
            errors.append(f"AGENT_MODE harus 'paper' atau 'live', bukan '{self.mode}'")
        if self.mode == "live":
            if not self.wallet_private_key:
                errors.append("Mode live butuh WALLET_PRIVATE_KEY")
            if self.live_confirm != LIVE_CONFIRM_PHRASE:
                errors.append(
                    f"Mode live butuh LIVE_TRADING_CONFIRM={LIVE_CONFIRM_PHRASE} "
                    "(sengaja dibuat repot supaya tidak live tanpa sengaja)"
                )
            if "api.mainnet-beta.solana.com" in self.rpc_url:
                errors.append("Mode live butuh RPC privat (Helius/Triton/QuickNode); RPC publik terlalu lambat & di-rate-limit")
        return errors


@dataclass
class Params:
    # --- Ukuran posisi & batas risiko ---
    risk_per_trade_pct: float = 2.0      # % equity yang hilang kalau SL kena
    max_position_pct: float = 10.0       # ukuran posisi maks sebagai % equity
    max_position_sol: float = 0.1
    min_position_sol: float = 0.01
    fixed_position_sol: float = 0.0      # >0 = setiap entry pakai ukuran tetap ini (abaikan sizing berbasis risiko)
    max_open_positions: int = 3
    reserve_sol: float = 0.02            # selalu disisakan untuk fee transaksi

    # --- Exit ---
    stop_loss_pct: float = 12.0          # SL keras dari harga masuk
    breakeven_after_pct: float = 20.0    # setelah naik segini, SL naik ke titik impas
    trailing_activate_pct: float = 30.0
    trailing_stop_pct: float = 15.0      # jarak trailing dari puncak setelah aktif
    tp1_pct: float = 40.0
    tp1_sell_fraction: float = 0.5
    tp2_pct: float = 100.0
    tp2_sell_fraction: float = 0.5       # dari sisa posisi
    max_hold_minutes: float = 20.0
    stale_minutes: float = 4.0           # kalau setelah N menit belum naik X%, keluar
    stale_min_gain_pct: float = 5.0
    exit_on_dev_sell: bool = True
    exit_sell_pressure_ratio: float = 0.25  # buy_ratio_1m di bawah ini + sedang profit → keluar

    # --- Rem darurat ---
    daily_loss_limit_pct: float = 15.0
    max_consecutive_losses: int = 4
    loss_cooldown_minutes: float = 30.0
    max_drawdown_pct: float = 35.0       # dari puncak equity → agent berhenti total
    reentry_cooldown_minutes: float = 30.0

    # --- Filter entry ---
    min_score: float = 65.0
    min_age_sec: float = 45.0
    max_age_minutes: float = 90.0
    min_mcap_sol: float = 28.0
    max_mcap_sol: float = 300.0
    min_unique_buyers_5m: int = 12
    min_buy_volume_sol_2m: float = 2.0
    max_top_buyer_share: float = 0.35
    max_dev_sold_pct: float = 50.0
    max_drawdown_from_ath_pct: float = 35.0
    max_top10_holder_pct: float = 45.0

    # --- Eksekusi & biaya ---
    slippage_pct: float = 15.0
    priority_fee_sol: float = 0.0005
    pump_fee_pct: float = 1.25
    platform_fee_pct: float = 0.5        # fee PumpPortal local API
    paper_latency_slippage_pct: float = 2.0  # simulasi harga sudah bergerak sebelum tx masuk

    # --- Belajar ---
    auto_tune: bool = True
    learn_min_samples: int = 40
    learn_horizon_minutes: float = 15.0
    learn_win_pct: float = 30.0          # sinyal dianggap "menang" kalau sentuh +X% sebelum -SL

    @classmethod
    def keys(cls) -> list[str]:
        return [f.name for f in fields(cls)]

    def to_dict(self) -> dict:
        return asdict(self)

    def set(self, key: str, raw: str) -> object:
        """Ubah satu parameter dari string. Lempar ValueError kalau tidak valid."""
        if key not in self.keys():
            raise ValueError(f"parameter '{key}' tidak dikenal")
        current = getattr(self, key)
        if isinstance(current, bool):
            low = raw.strip().lower()
            if low not in ("true", "false", "1", "0", "on", "off", "ya", "tidak"):
                raise ValueError("pakai true/false")
            value: object = low in ("true", "1", "on", "ya")
        elif isinstance(current, int):
            value = int(float(raw))
        else:
            value = float(raw)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value < 0:
            raise ValueError("nilai tidak boleh negatif")
        if key.endswith("_fraction") and not (0 < float(value) <= 1):
            raise ValueError("fraction harus di antara 0 dan 1")
        if key == "stop_loss_pct" and not (1 <= float(value) <= 50):
            raise ValueError("stop_loss_pct harus 1–50")
        setattr(self, key, value)
        return value

    def update_from(self, data: dict) -> None:
        for key, value in data.items():
            if key in self.keys():
                try:
                    self.set(key, str(value))
                except ValueError:
                    pass
