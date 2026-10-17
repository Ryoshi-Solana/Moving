"""
Learner: agent belajar dari market, bukan cuma dari trade yang ia ambil.

Setiap token yang lolos filter dicatat sebagai "sinyal" (lengkap dengan skor &
komponennya), DIBELI ATAU TIDAK. Lalu harganya diikuti selama beberapa menit:
  - menang : menyentuh +learn_win_pct% lebih dulu
  - kalah  : menyentuh -stop_loss_pct% lebih dulu
  - datar  : tidak keduanya sampai horizon habis

Dari situ learner bisa:
  - menunjukkan win rate per rentang skor (apakah skor tinggi memang lebih bagus?)
  - menyesuaikan bobot komponen (komponen yang membedakan menang vs kalah dinaikkan)
  - menyesuaikan min_score ke ambang dengan ekspektasi terbaik
Semua penyesuaian dibatasi supaya agent tidak "belajar" hal ekstrem dari sampel kecil.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from .config import Params
from .store import Store
from .strategy import DEFAULT_WEIGHTS

SCORE_THRESHOLDS = [50, 55, 60, 65, 70, 75, 80, 85]
# Learner hanya boleh membuat agent LEBIH selektif dari default, tidak lebih longgar.
MIN_SCORE_FLOOR, MIN_SCORE_CEIL = 65.0, 85.0
MIN_THRESHOLD_SAMPLES = 20


@dataclass
class OpenSignal:
    id: int
    mint: str
    ts: float
    entry: float
    max_gain: float = 0.0
    min_gain: float = 0.0


class Learner:
    def __init__(self, store: Store, params: Params):
        self.store = store
        self.p = params
        self.open: dict[int, OpenSignal] = {}
        self.last_signal_at: dict[str, float] = {}
        self.weights: dict[str, float] = dict(DEFAULT_WEIGHTS)
        saved = store.get("learner_weights")
        if saved:
            self.weights.update({k: float(v) for k, v in saved.items() if k in DEFAULT_WEIGHTS})
        # data awal yang sedikit pernah bisa menurunkan min_score di bawah default
        if self.p.min_score < MIN_SCORE_FLOOR:
            self.p.min_score = MIN_SCORE_FLOOR
        for row in store.open_signals():
            self.open[row["id"]] = OpenSignal(row["id"], row["mint"], row["ts"], row["entry_price"],
                                              row["max_gain_pct"], row["min_gain_pct"])

    # ---------- pencatatan ----------

    def record(self, mint: str, now: float, score: float, comps: dict, features: dict,
               price: float, bought: bool) -> int | None:
        last = self.last_signal_at.get(mint)
        if last and now - last < 600:  # satu sinyal per token per 10 menit
            return None
        if price <= 0:
            return None
        self.last_signal_at[mint] = now
        sid = self.store.add_signal(mint, now, score, comps, features, price, bought)
        self.open[sid] = OpenSignal(sid, mint, now, price)
        return sid

    def mark_bought(self, sid: int | None) -> None:
        if sid is not None:
            self.store.mark_signal_bought(sid)

    def on_price(self, mint: str, price: float, now: float) -> None:
        if price <= 0:
            return
        for sig in list(self.open.values()):
            if sig.mint != mint:
                continue
            gain = (price / sig.entry - 1) * 100
            sig.max_gain = max(sig.max_gain, gain)
            sig.min_gain = min(sig.min_gain, gain)
            if sig.max_gain >= self.p.learn_win_pct:
                self._resolve(sig, "win", now)
            elif sig.min_gain <= -self.p.stop_loss_pct:
                self._resolve(sig, "loss", now)

    def tick(self, now: float) -> None:
        horizon = self.p.learn_horizon_minutes * 60
        for sig in list(self.open.values()):
            if now - sig.ts >= horizon:
                self._resolve(sig, "flat", now)
        cutoff = now - 3600
        self.last_signal_at = {m: t for m, t in self.last_signal_at.items() if t > cutoff}

    def _resolve(self, sig: OpenSignal, outcome: str, now: float) -> None:
        self.store.update_signal(sig.id, sig.max_gain, sig.min_gain, outcome, now)
        self.open.pop(sig.id, None)

    # ---------- analisis ----------

    def round_trip_cost_pct(self) -> float:
        """Fee pump.fun + PumpPortal + slippage, beli dan jual."""
        p = self.p
        return 2 * (p.pump_fee_pct + p.platform_fee_pct + p.paper_latency_slippage_pct)

    def _payoff(self, outcome: str) -> float:
        """Perkiraan hasil BERSIH satu sinyal kalau diambil (setelah biaya)."""
        cost = self.round_trip_cost_pct()
        if outcome == "win":
            return self.p.learn_win_pct - cost
        if outcome == "loss":
            return -self.p.stop_loss_pct - cost
        return -cost

    def analyze(self) -> dict:
        rows = self.store.resolved_signals()
        result: dict = {"samples": len(rows), "buckets": [], "components": {}, "weights": self.weights}
        if not rows:
            return result
        wins = sum(1 for r in rows if r["outcome"] == "win")
        losses = sum(1 for r in rows if r["outcome"] == "loss")
        result["win_rate"] = wins / len(rows)
        result["loss_rate"] = losses / len(rows)
        result["expectancy_pct"] = sum(self._payoff(r["outcome"]) for r in rows) / len(rows)

        for lo in SCORE_THRESHOLDS:
            sel = [r for r in rows if lo <= r["score"] < lo + 5] if lo < 85 else [r for r in rows if r["score"] >= 85]
            if not sel:
                continue
            result["buckets"].append({
                "range": f"{lo}-{lo + 5}" if lo < 85 else "85+",
                "n": len(sel),
                "win_rate": sum(1 for r in sel if r["outcome"] == "win") / len(sel),
                "expectancy_pct": sum(self._payoff(r["outcome"]) for r in sel) / len(sel),
            })

        win_rows = [json.loads(r["components"]) for r in rows if r["outcome"] == "win"]
        loss_rows = [json.loads(r["components"]) for r in rows if r["outcome"] != "win"]
        for key in DEFAULT_WEIGHTS:
            mw = sum(c.get(key, 0) for c in win_rows) / len(win_rows) if win_rows else 0.0
            ml = sum(c.get(key, 0) for c in loss_rows) / len(loss_rows) if loss_rows else 0.0
            result["components"][key] = {"mean_win": round(mw, 3), "mean_other": round(ml, 3), "edge": round(mw - ml, 3)}
        return result

    def tune(self) -> list[str]:
        """Sesuaikan bobot & min_score. Kembalikan daftar perubahan (untuk dilaporkan)."""
        if not self.p.auto_tune:
            return []
        analysis = self.analyze()
        if analysis["samples"] < self.p.learn_min_samples:
            return []
        rows = self.store.resolved_signals()
        changes = []

        # 1. Bobot komponen: geser maksimal ±50% dari bobot awal
        if analysis["components"]:
            for key, base in DEFAULT_WEIGHTS.items():
                edge = analysis["components"][key]["edge"]
                target = base * max(0.5, min(1.5, 1 + 2 * edge))
                new = round(0.7 * self.weights[key] + 0.3 * target, 2)  # gerak pelan
                if abs(new - self.weights[key]) >= 0.25:
                    changes.append(f"bobot {key}: {self.weights[key]:.1f} → {new:.1f}")
                self.weights[key] = new
            self.store.put("learner_weights", self.weights)

        # 2. min_score: ambang dengan ekspektasi bersih terbaik (butuh cukup sampel di atasnya)
        best_t, best_e = None, None
        for t in SCORE_THRESHOLDS:
            sel = [r for r in rows if r["score"] >= t]
            if len(sel) < MIN_THRESHOLD_SAMPLES:
                continue
            e = sum(self._payoff(r["outcome"]) for r in sel) / len(sel)
            if best_e is None or e > best_e:
                best_t, best_e = t, e
        if best_t is not None:
            target = max(MIN_SCORE_FLOOR, min(MIN_SCORE_CEIL, float(best_t)))
            if best_e <= 0:
                # belum ada ambang yang untung setelah biaya → paling selektif
                target = MIN_SCORE_CEIL
            # geser maksimal 5 poin per tuning
            step = max(-5.0, min(5.0, target - self.p.min_score))
            if abs(step) >= 1:
                old = self.p.min_score
                self.p.min_score = round(old + step, 1)
                changes.append(f"min_score: {old:.0f} → {self.p.min_score:.0f} "
                               f"(ekspektasi bersih {best_e:+.1f}% di skor ≥{best_t})")
        return changes
