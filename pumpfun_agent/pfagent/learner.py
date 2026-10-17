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
Selain itu, setiap sinyal diuji sekaligus dengan banyak kombinasi SL/TP (grid):
harga diikuti sampai horizon, dan untuk tiap kombinasi dicatat mana yang kena
duluan. Dari situ learner tahu SL/TP mana yang paling untung SETELAH biaya
untuk sinyal-sinyal yang memang akan dibeli (skor ≥ min_score).

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

GRID_SL = (8, 12, 16, 20, 25)
GRID_TP = (20, 30, 50, 75, 100)
GRID_MIN_SAMPLES = 60
SL_BOUNDS, TP_BOUNDS = (8.0, 25.0), (20.0, 100.0)


def grid_key(sl: float, tp: float) -> str:
    return f"{sl:g}/{tp:g}"


@dataclass
class OpenSignal:
    id: int
    mint: str
    ts: float
    entry: float
    max_gain: float = 0.0
    min_gain: float = 0.0
    last_gain: float = 0.0
    main_done: bool = False
    grid: dict | None = None  # "sl/tp" -> hasil kotor % (None = belum kena)

    def __post_init__(self):
        if self.grid is None:
            self.grid = {grid_key(sl, tp): None for sl in GRID_SL for tp in GRID_TP}


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
            sig.last_gain = gain
            for sl in GRID_SL:
                for tp in GRID_TP:
                    k = grid_key(sl, tp)
                    if sig.grid[k] is None:
                        if gain <= -sl:
                            sig.grid[k] = -float(sl)
                        elif gain >= tp:
                            sig.grid[k] = float(tp)
            if not sig.main_done:
                if sig.max_gain >= self.p.learn_win_pct:
                    self._resolve_main(sig, "win", now)
                elif sig.min_gain <= -self.p.stop_loss_pct:
                    self._resolve_main(sig, "loss", now)
            if all(v is not None for v in sig.grid.values()):
                self._finish(sig, now)

    def tick(self, now: float) -> None:
        horizon = self.p.learn_horizon_minutes * 60
        for sig in list(self.open.values()):
            if now - sig.ts >= horizon:
                self._finish(sig, now)
        cutoff = now - 3600
        self.last_signal_at = {m: t for m, t in self.last_signal_at.items() if t > cutoff}

    def _resolve_main(self, sig: OpenSignal, outcome: str, now: float) -> None:
        sig.main_done = True
        self.store.update_signal(sig.id, sig.max_gain, sig.min_gain, outcome, now)

    def _finish(self, sig: OpenSignal, now: float) -> None:
        """Horizon habis (atau semua kombinasi grid sudah kena): simpan semuanya."""
        if not sig.main_done:
            self._resolve_main(sig, "flat", now)
        for sl in GRID_SL:
            for tp in GRID_TP:
                k = grid_key(sl, tp)
                if sig.grid[k] is None:  # tidak kena SL maupun TP → keluar di harga terakhir
                    sig.grid[k] = round(max(-sl, min(tp, sig.last_gain)), 2)
        self.store.update_signal_grid(sig.id, sig.grid)
        self.open.pop(sig.id, None)

    def grid_analysis(self, min_score: float | None = None) -> dict:
        """Rata-rata hasil BERSIH per kombinasi SL/TP untuk sinyal dengan skor ≥ min_score."""
        min_score = self.p.min_score if min_score is None else min_score
        rows = self.store.grid_signals(min_score)
        cost = self.round_trip_cost_pct()
        sums: dict[str, float] = {}
        n = 0
        for r in rows:
            try:
                g = json.loads(r["grid"])
            except (TypeError, ValueError):
                continue
            n += 1
            for k, v in g.items():
                sums[k] = sums.get(k, 0.0) + float(v) - cost
        cells = sorted(({"key": k, "sl": float(k.split("/")[0]), "tp": float(k.split("/")[1]),
                         "net_pct": s / n} for k, s in sums.items()), key=lambda c: c["net_pct"], reverse=True)
        current = grid_key(min(GRID_SL, key=lambda x: abs(x - self.p.stop_loss_pct)),
                           min(GRID_TP, key=lambda x: abs(x - self.p.tp1_pct)))
        return {"samples": n, "min_score": min_score, "cells": cells,
                "current": next((c for c in cells if c["key"] == current), None)}

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

        # 3. SL/TP: geser pelan ke kombinasi grid terbaik untuk sinyal yang akan dibeli
        grid = self.grid_analysis()
        if grid["samples"] >= GRID_MIN_SAMPLES and grid["cells"] and grid["cells"][0]["net_pct"] > 0:
            best = grid["cells"][0]
            new_sl = max(SL_BOUNDS[0], min(SL_BOUNDS[1],
                         self.p.stop_loss_pct + max(-4.0, min(4.0, best["sl"] - self.p.stop_loss_pct))))
            new_tp = max(TP_BOUNDS[0], min(TP_BOUNDS[1],
                         self.p.tp1_pct + max(-20.0, min(20.0, best["tp"] - self.p.tp1_pct))))
            if abs(new_sl - self.p.stop_loss_pct) >= 1 or abs(new_tp - self.p.tp1_pct) >= 1:
                changes.append(f"SL {self.p.stop_loss_pct:.0f}% → {new_sl:.0f}%, TP1 {self.p.tp1_pct:.0f}% → "
                               f"{new_tp:.0f}% (terbaik: SL {best['sl']:g}/TP {best['tp']:g} = "
                               f"{best['net_pct']:+.1f}% bersih, n={grid['samples']})")
                self.p.stop_loss_pct = round(new_sl, 1)
                self.p.tp1_pct = round(new_tp, 1)
                self.p.tp2_pct = max(self.p.tp2_pct, round(self.p.tp1_pct * 2, 1))
        return changes
