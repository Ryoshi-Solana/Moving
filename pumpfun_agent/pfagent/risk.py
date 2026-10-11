"""
Manajemen risiko: ukuran posisi, batas harian, cooldown setelah kalah beruntun,
dan kill switch drawdown. Semua state disimpan ke DB supaya tahan restart.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict

from .config import Params


@dataclass
class RiskState:
    day: str = ""
    day_start_equity: float = 0.0
    day_realized_pnl: float = 0.0
    peak_equity: float = 0.0
    consecutive_losses: int = 0
    cooldown_until: float = 0.0
    paused: bool = False
    halted: bool = False          # kill switch; butuh /resume manual
    halt_reason: str = ""
    day_stopped: bool = False     # batas rugi harian; otomatis lepas di hari berikutnya
    last_exit: dict | None = None  # mint -> waktu exit terakhir (re-entry cooldown)

    def __post_init__(self):
        if self.last_exit is None:
            self.last_exit = {}


class RiskManager:
    def __init__(self, params: Params, state: RiskState | None = None):
        self.p = params
        self.state = state or RiskState()

    def to_dict(self) -> dict:
        return asdict(self.state)

    @classmethod
    def from_dict(cls, params: Params, data: dict | None) -> "RiskManager":
        state = RiskState(**{k: v for k, v in (data or {}).items() if k in RiskState.__dataclass_fields__})
        return cls(params, state)

    # ---------- siklus harian & equity ----------

    def roll_day(self, day: str, equity: float) -> bool:
        """Panggil berkala. True kalau hari baru dimulai."""
        if self.state.day != day:
            self.state.day = day
            self.state.day_start_equity = equity
            self.state.day_realized_pnl = 0.0
            self.state.day_stopped = False
            return True
        return False

    def on_equity(self, equity: float) -> str | None:
        """Update puncak equity; kembalikan alasan kalau kill switch terpicu."""
        s = self.state
        s.peak_equity = max(s.peak_equity, equity)
        if s.halted:
            return None
        if s.peak_equity > 0:
            dd = (1 - equity / s.peak_equity) * 100
            if dd >= self.p.max_drawdown_pct:
                s.halted = True
                s.halt_reason = f"drawdown {dd:.1f}% dari puncak (batas {self.p.max_drawdown_pct:.0f}%)"
                return s.halt_reason
        if s.day_start_equity > 0 and not s.day_stopped:
            day_loss = (1 - equity / s.day_start_equity) * 100
            if day_loss >= self.p.daily_loss_limit_pct:
                s.day_stopped = True
                return (f"rugi harian {day_loss:.1f}% (batas {self.p.daily_loss_limit_pct:.0f}%) "
                        "→ tidak buka posisi baru sampai besok")
        return None

    def on_position_closed(self, mint: str, pnl_sol: float, now: float) -> str | None:
        s = self.state
        s.day_realized_pnl += pnl_sol
        s.last_exit[mint] = now
        if pnl_sol < 0:
            s.consecutive_losses += 1
            if s.consecutive_losses >= self.p.max_consecutive_losses:
                s.cooldown_until = now + self.p.loss_cooldown_minutes * 60
                s.consecutive_losses = 0
                return (f"{self.p.max_consecutive_losses}x rugi beruntun → istirahat "
                        f"{self.p.loss_cooldown_minutes:.0f} menit")
        else:
            s.consecutive_losses = 0
        return None

    def resume(self, equity: float) -> None:
        s = self.state
        s.paused = False
        s.halted = False
        s.halt_reason = ""
        s.day_stopped = False
        s.cooldown_until = 0.0
        # reset acuan supaya kill switch tidak langsung terpicu lagi
        s.peak_equity = equity
        s.day_start_equity = equity

    # ---------- keputusan ----------

    def can_open(self, mint: str, now: float, open_mints: set[str], cash: float) -> tuple[bool, str]:
        s, p = self.state, self.p
        if s.halted:
            return False, f"kill switch: {s.halt_reason}"
        if s.day_stopped:
            return False, "batas rugi harian tercapai"
        if s.paused:
            return False, "dijeda"
        if now < s.cooldown_until:
            return False, "cooldown setelah rugi beruntun"
        if mint in open_mints:
            return False, "sudah pegang"
        if len(open_mints) >= p.max_open_positions:
            return False, "posisi penuh"
        last = s.last_exit.get(mint)
        if last is not None and now - last < p.reentry_cooldown_minutes * 60:
            return False, "baru saja keluar dari token ini"
        if cash < p.min_position_sol + p.reserve_sol:
            return False, "saldo tidak cukup"
        return True, ""

    def position_size(self, equity: float, cash: float, score: float = 0.0) -> float:
        """
        Ukuran berbasis risiko: kalau SL kena, rugi ≈ risk_per_trade_pct dari equity.
        Biaya pulang-pergi ikut dihitung sebagai bagian dari risiko.
        """
        p = self.p
        round_trip_cost = 2 * (p.pump_fee_pct + p.platform_fee_pct + p.paper_latency_slippage_pct) / 100
        loss_per_sol = p.stop_loss_pct / 100 + round_trip_cost
        size = equity * p.risk_per_trade_pct / 100 / loss_per_sol
        size = min(size, equity * p.max_position_pct / 100, p.max_position_sol)
        size = min(size, cash - p.reserve_sol - p.priority_fee_sol)
        if size < p.min_position_sol:
            return 0.0
        return round(size, 4)

    def prune(self, now: float) -> None:
        horizon = self.p.reentry_cooldown_minutes * 60
        self.state.last_exit = {m: t for m, t in self.state.last_exit.items() if now - t < horizon}
