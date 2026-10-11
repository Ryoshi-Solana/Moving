"""
Strategi: kapan beli (skor momentum) dan kapan jual (exit manager).

Skor entry = jumlah komponen 0..1 dikali bobot. Bobot awal di DEFAULT_WEIGHTS,
lalu disesuaikan oleh Learner berdasarkan hasil sinyal-sinyal sebelumnya.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from .config import Params
from .market import Features

DEFAULT_WEIGHTS = {
    "buy_pressure": 20.0,
    "volume": 20.0,
    "buyers": 15.0,
    "price_momentum": 15.0,
    "acceleration": 10.0,
    "narrative": 15.0,
    "distribution": 5.0,
}


def components(f: Features, narrative_heat: float) -> dict[str, float]:
    """Setiap komponen dinormalisasi ke 0..1."""
    def clamp(x: float) -> float:
        return max(0.0, min(1.0, x))

    # tekanan beli: 50% → 0, 85%+ → 1
    buy_pressure = clamp((f.buy_ratio_1m - 0.5) / 0.35)
    # volume beli 2 menit, skala log: 1 SOL → ~0.2, 15 SOL → 1
    volume = clamp(math.log1p(f.buy_vol_2m) / math.log1p(15))
    buyers = clamp(f.unique_buyers_5m / 50)
    # momentum harga: kenaikan 1m & 5m, tapi kenaikan ekstrem (>150%) bukan nilai plus
    m1 = clamp(f.mcap_change_1m_pct / 30)
    m5 = clamp(f.mcap_change_5m_pct / 80)
    overheat = 0.5 if f.mcap_change_5m_pct > 150 else 1.0
    price_momentum = clamp((0.6 * m1 + 0.4 * m5) * overheat)
    acceleration = clamp((f.trade_accel - 1.0) / 1.5)
    distribution = clamp(1 - f.top_buyer_share_5m / 0.35) * clamp(1 - f.top10_holder_pct / 60)
    if f.has_socials:
        distribution = clamp(distribution + 0.2)
    return {
        "buy_pressure": buy_pressure,
        "volume": volume,
        "buyers": buyers,
        "price_momentum": price_momentum,
        "acceleration": acceleration,
        "narrative": clamp(narrative_heat),
        "distribution": distribution,
    }


def score(comps: dict[str, float], weights: dict[str, float]) -> float:
    total_w = sum(weights.get(k, 0.0) for k in comps)
    if total_w <= 0:
        return 0.0
    raw = sum(comps[k] * weights.get(k, 0.0) for k in comps)
    return round(raw / total_w * 100, 2)


def hard_filters(f: Features, p: Params) -> list[str]:
    """Alasan menolak token. Kosong = lolos."""
    reasons = []
    if f.migrated:
        reasons.append("sudah migrasi")
    if f.age_sec < p.min_age_sec:
        reasons.append("terlalu baru")
    if f.age_sec > p.max_age_minutes * 60:
        reasons.append("terlalu tua")
    if f.mcap_sol < p.min_mcap_sol:
        reasons.append("mcap terlalu kecil")
    if f.mcap_sol > p.max_mcap_sol:
        reasons.append("mcap terlalu besar")
    if f.unique_buyers_5m < p.min_unique_buyers_5m:
        reasons.append("pembeli unik kurang")
    if f.buy_vol_2m < p.min_buy_volume_sol_2m:
        reasons.append("volume beli kurang")
    if f.top_buyer_share_5m > p.max_top_buyer_share:
        reasons.append("volume didominasi 1 wallet")
    if f.dev_sold_pct > p.max_dev_sold_pct:
        reasons.append("dev sudah jual")
    if f.drawdown_from_ath_pct > p.max_drawdown_from_ath_pct:
        reasons.append("jauh di bawah ATH (falling knife)")
    if f.top10_holder_pct > p.max_top10_holder_pct:
        reasons.append("holder terlalu terpusat")
    if f.buy_ratio_1m < 0.5:
        reasons.append("lebih banyak jual daripada beli")
    return reasons


# ------------------------------------------------------------------ exit

@dataclass
class PositionView:
    """Data posisi yang dibutuhkan exit manager (tanpa ketergantungan ke DB)."""
    entry_price: float
    opened_at: float
    peak_price: float
    tp1_done: bool = False
    tp2_done: bool = False
    stop_price: float = 0.0  # 0 = pakai SL default


@dataclass
class ExitDecision:
    fraction: float           # porsi dari sisa posisi yang dijual (0..1)
    reason: str
    new_stop_price: float | None = None
    mark: list[str] = field(default_factory=list)  # flag tp1/tp2 yang perlu ditandai


def evaluate_exit(pos: PositionView, price: float, f: Features | None, now: float, p: Params) -> ExitDecision | None:
    if price <= 0 or pos.entry_price <= 0:
        return None
    gain = (price / pos.entry_price - 1) * 100
    peak_gain = (max(pos.peak_price, price) / pos.entry_price - 1) * 100
    held_min = (now - pos.opened_at) / 60

    # 1. Stop loss (bisa sudah dinaikkan ke breakeven / trailing)
    stop = pos.stop_price or pos.entry_price * (1 - p.stop_loss_pct / 100)
    if price <= stop:
        label = "STOP LOSS" if stop < pos.entry_price else "TRAILING/BREAKEVEN STOP"
        return ExitDecision(1.0, f"{label} ({gain:+.1f}%)")

    # 2. Trailing stop setelah aktif
    if peak_gain >= p.trailing_activate_pct:
        trail = max(pos.peak_price, price) * (1 - p.trailing_stop_pct / 100)
        if price <= trail:
            return ExitDecision(1.0, f"TRAILING STOP ({gain:+.1f}%, puncak {peak_gain:+.0f}%)")

    # 3. Bahaya: dev dump atau tekanan jual saat sedang profit
    if f is not None:
        if p.exit_on_dev_sell and f.dev_sold_pct >= 50:
            return ExitDecision(1.0, f"DEV JUAL {f.dev_sold_pct:.0f}% ({gain:+.1f}%)")
        if gain > 0 and f.sell_vol_1m > 1.0 and f.buy_ratio_1m < p.exit_sell_pressure_ratio:
            return ExitDecision(1.0, f"TEKANAN JUAL ({gain:+.1f}%)")

    # 4. Take profit bertingkat
    if not pos.tp1_done and gain >= p.tp1_pct:
        # setelah TP1, SL minimal di harga masuk
        return ExitDecision(p.tp1_sell_fraction, f"TP1 +{gain:.0f}%",
                            new_stop_price=max(pos.stop_price, pos.entry_price), mark=["tp1"])
    if pos.tp1_done and not pos.tp2_done and gain >= p.tp2_pct:
        return ExitDecision(p.tp2_sell_fraction, f"TP2 +{gain:.0f}%", mark=["tp2"])

    # 5. Batas waktu
    if held_min >= p.max_hold_minutes:
        return ExitDecision(1.0, f"WAKTU HABIS {held_min:.0f}m ({gain:+.1f}%)")
    if held_min >= p.stale_minutes and peak_gain < p.stale_min_gain_pct:
        return ExitDecision(1.0, f"TIDAK BERGERAK {held_min:.0f}m ({gain:+.1f}%)")

    # 6. Naikkan SL ke breakeven (tidak menjual apa-apa)
    if peak_gain >= p.breakeven_after_pct and pos.stop_price < pos.entry_price:
        return ExitDecision(0.0, "SL → breakeven", new_stop_price=pos.entry_price)
    return None
