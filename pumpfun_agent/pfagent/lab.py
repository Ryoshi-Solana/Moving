"""
Lab strategi (mode bayangan): menguji banyak cara MASUK sekaligus pada setiap
sinyal, tanpa uang (paper) dan tanpa memengaruhi trading.

Kenapa: dua musim paper trading menunjukkan "beli saat momentum meledak" rugi
setelah biaya — mayoritas trade jatuh -12% dalam detik-detik pertama. Lab ini
mencari aturan entry yang benar-benar untung di data sebelum dipakai trading.

Untuk setiap sinyal, tiap aturan entry disimulasikan:
  langsung    : masuk di harga sinyal (pembanding = strategi lama)
  tunda30/60/120 : tunggu N detik; masuk hanya kalau harga belum turun >5%
  pullback15/25  : tunggu harga turun X% dari puncak setelah sinyal (maks 5 menit)
Setelah masuk, harga diikuti 15 menit terhadap grid SL × TP. Hasil disimpan
per sinyal; analisis memotong biaya pulang-pergi, membandingkan filter
(skor, umur, kenaikan vertikal, dll) dan mengecek konsistensi di paruh
pertama vs paruh kedua data supaya tidak tertipu kebetulan.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Callable

from .store import Store

# v2: SL/TP dicatat di harga SAAT tersentuh (bukan dijepit di level SL/TP). Di pump.fun
# harga sering melompat melewati SL (-30% s/d -65%); v1 mengabaikan itu sehingga hasil
# lab terlalu optimis. Data v1 tidak dipakai lagi dalam analisis.
LAB_VERSION = 2

ENTRY_RULES: dict[str, dict] = {
    "langsung": {"kind": "now"},
    "tunda30": {"kind": "delay", "sec": 30, "max_drop": 5},
    "tunda60": {"kind": "delay", "sec": 60, "max_drop": 5},
    "tunda120": {"kind": "delay", "sec": 120, "max_drop": 5},
    "pullback15": {"kind": "pullback", "pct": 15, "window": 300},
    "pullback25": {"kind": "pullback", "pct": 25, "window": 300},
    "lanjut60": {"kind": "confirm", "sec": 60, "min_gain": 10},  # 60 dtk kemudian harga sudah naik ≥10%
}
EXIT_SL = (10, 15, 20, 30)
EXIT_TP = (25, 50, 100)
HOLD_SEC = 900

# filter dievaluasi saat analisis dari fitur yang tersimpan bersama sinyal
FILTERS: dict[str, Callable[[float, dict], bool]] = {
    "semua": lambda s, f: True,
    "skor≥65": lambda s, f: s >= 65,
    "skor≥75": lambda s, f: s >= 75,
    "tdk-vertikal": lambda s, f: f.get("mcap_change_1m_pct", 0) < 50,
    "umur≥3m": lambda s, f: f.get("age_sec", 0) >= 180,
    "mcap≥80": lambda s, f: f.get("mcap_sol", 0) >= 80,
    "buyers≥40": lambda s, f: f.get("unique_buyers_5m", 0) >= 40,
    "tdk-vertikal+umur≥3m": lambda s, f: f.get("mcap_change_1m_pct", 0) < 50 and f.get("age_sec", 0) >= 180,
    "buyratio≥0.8": lambda s, f: f.get("buy_ratio_1m", 0) >= 0.8,
    "naik1m<30": lambda s, f: f.get("mcap_change_1m_pct", 0) < 30,
    "skor≥65+buyratio≥0.8": lambda s, f: s >= 65 and f.get("buy_ratio_1m", 0) >= 0.8,
    "umur≥3m+buyers≥40": lambda s, f: f.get("age_sec", 0) >= 180 and f.get("unique_buyers_5m", 0) >= 40,
}


def cell(sl: float, tp: float) -> str:
    return f"{sl:g}/{tp:g}"


@dataclass
class _Entry:
    rule: str
    state: str = "waiting"   # waiting | open | done | skip
    price: float = 0.0
    t: float = 0.0
    last_gain: float = 0.0
    cells: dict = field(default_factory=lambda: {cell(s, t): None for s in EXIT_SL for t in EXIT_TP})

    def open(self, price: float, now: float) -> None:
        self.state, self.price, self.t = "open", price, now

    def update(self, price: float, now: float) -> None:
        gain = (price / self.price - 1) * 100
        self.last_gain = gain
        for s in EXIT_SL:
            for t in EXIT_TP:
                k = cell(s, t)
                if self.cells[k] is None and (gain <= -s or gain >= t):
                    # keluar di harga yang benar-benar ada saat level tersentuh (termasuk gap)
                    self.cells[k] = round(gain, 2)
        if now - self.t >= HOLD_SEC or all(v is not None for v in self.cells.values()):
            self.finish()

    def finish(self) -> None:
        for s in EXIT_SL:
            for t in EXIT_TP:
                k = cell(s, t)
                if self.cells[k] is None:
                    self.cells[k] = round(max(-s, min(t, self.last_gain)), 2)
        self.state = "done"


@dataclass
class _Signal:
    sid: int
    mint: str
    t0: float
    p0: float
    high: float
    last_price: float
    entries: dict


class StrategyLab:
    def __init__(self, store: Store):
        self.store = store
        self.by_mint: dict[str, list[_Signal]] = {}

    @property
    def mints(self) -> set[str]:
        return set(self.by_mint)

    def add(self, sid: int | None, mint: str, now: float, price: float) -> None:
        if sid is None or price <= 0:
            return
        entries = {name: _Entry(name) for name in ENTRY_RULES}
        entries["langsung"].open(price, now)
        self.by_mint.setdefault(mint, []).append(_Signal(sid, mint, now, price, price, price, entries))

    def on_price(self, mint: str, price: float, now: float) -> None:
        sigs = self.by_mint.get(mint)
        if not sigs or price <= 0:
            return
        for sig in sigs:
            sig.high = max(sig.high, price)
            sig.last_price = price
            for e in sig.entries.values():
                if e.state == "open":
                    e.update(price, now)
                elif e.state == "waiting":
                    self._try_enter(sig, e, price, now)

    def _try_enter(self, sig: _Signal, e: _Entry, price: float, now: float) -> None:
        rule = ENTRY_RULES[e.rule]
        if rule["kind"] == "confirm":
            if now - sig.t0 >= rule["sec"]:
                if price >= sig.p0 * (1 + rule["min_gain"] / 100):
                    e.open(price, now)
                else:
                    e.state = "skip"
        elif rule["kind"] == "delay":
            if now - sig.t0 >= rule["sec"]:
                if price >= sig.p0 * (1 - rule["max_drop"] / 100):
                    e.open(price, now)
                else:
                    e.state = "skip"
        elif rule["kind"] == "pullback":
            if now - sig.t0 > rule["window"]:
                e.state = "skip"
            elif price <= sig.high * (1 - rule["pct"] / 100):
                e.open(price, now)

    def tick(self, now: float) -> None:
        for mint in list(self.by_mint):
            keep = []
            for sig in self.by_mint[mint]:
                for e in sig.entries.values():
                    if e.state == "waiting":
                        rule = ENTRY_RULES[e.rule]
                        limit = rule.get("sec", 0) + 60 if rule["kind"] in ("delay", "confirm") else rule.get("window", 0)
                        if now - sig.t0 > limit:
                            e.state = "skip"  # tidak ada trade = token mati, tidak bisa masuk
                    elif e.state == "open" and now - e.t >= HOLD_SEC:
                        e.finish()
                if all(e.state in ("done", "skip") for e in sig.entries.values()):
                    result = {
                        name: {"in": e.state == "done", "cells": e.cells if e.state == "done" else None}
                        for name, e in sig.entries.items()
                    }
                    result["_v"] = LAB_VERSION
                    self.store.update_signal_lab(sig.sid, result)
                else:
                    keep.append(sig)
            if keep:
                self.by_mint[mint] = keep
            else:
                del self.by_mint[mint]

    # ------------------------------------------------------------ analisis

    def fetch(self, limit: int = 20000) -> list[tuple]:
        """Ambil data mentah (cepat, di thread utama karena koneksi sqlite)."""
        return [(r["ts"], r["score"], r["features"], r["lab"]) for r in self.store.lab_signals(limit)]

    async def analyze_async(self, cost_pct: float) -> dict:
        import asyncio
        rows = self.fetch()
        return await asyncio.to_thread(analyze_rows, rows, cost_pct)

    def analyze(self, cost_pct: float, min_n: int = 50) -> dict:
        return analyze_rows(self.fetch(), cost_pct, min_n)


def analyze_rows(rows: list[tuple], cost_pct: float, min_n: int = 50) -> dict:
    """Perhitungan berat; aman dijalankan di thread terpisah."""
    rows = sorted(rows, key=lambda r: r[0])
    parsed = []
    for _ts, score, features, lab in rows:
        try:
            res = json.loads(lab)
            if res.pop("_v", 1) != LAB_VERSION:
                continue  # data lama dengan SL/TP dijepit — terlalu optimis
            parsed.append((score, json.loads(features or "{}"), res))
        except (TypeError, ValueError, AttributeError):
            continue
    half = len(parsed) // 2
    # akumulasi: (rule, filter, cell) -> [n, sum, n1, sum1, n2, sum2]
    acc: dict[tuple, list] = {}
    for i, (sc, feats, lab) in enumerate(parsed):
        fnames = [name for name, fn in FILTERS.items() if fn(sc, feats)]
        second = i >= half
        for rule, res in lab.items():
            if not res.get("in") or not res.get("cells"):
                continue
            for ck, val in res["cells"].items():
                net = float(val) - cost_pct
                for fname in fnames:
                    a = acc.setdefault((rule, fname, ck), [0, 0.0, 0, 0.0, 0, 0.0])
                    a[0] += 1
                    a[1] += net
                    j = 4 if second else 2
                    a[j] += 1
                    a[j + 1] += net
    results = []
    for (rule, fname, ck), (n, s, n1, s1, n2, s2) in acc.items():
        if n < min_n:
            continue
        m1 = s1 / n1 if n1 else None
        m2 = s2 / n2 if n2 else None
        mean = s / n
        robust = (n >= 100 and m1 is not None and m2 is not None and m1 > 0 and m2 > 0 and mean > 2.0)
        results.append({"rule": rule, "filter": fname, "exit": ck, "n": n, "net_pct": round(mean, 2),
                        "half1": round(m1, 2) if m1 is not None else None,
                        "half2": round(m2, 2) if m2 is not None else None, "robust": robust})
    results.sort(key=lambda r: r["net_pct"], reverse=True)
    baseline = [r for r in results if r["rule"] == "langsung" and r["filter"] == "semua"]
    return {"signals": len(parsed), "results": results,
            "baseline_best": baseline[0] if baseline else None,
            "robust": [r for r in results if r["robust"]]}
