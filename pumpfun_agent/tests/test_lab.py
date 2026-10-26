"""Lab strategi: aturan entry bayangan, grid exit, dan analisis ketahanan."""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pfagent.lab import ENTRY_RULES, StrategyLab  # noqa: E402
from pfagent.store import Store  # noqa: E402


def _signal(store, lab, mint, t0, score=80, feats=None):
    sid = store.add_signal(mint, t0, score, {}, feats or {"age_sec": 300, "mcap_change_1m_pct": 20}, 1.0, False)
    lab.add(sid, mint, t0, 1.0)
    return sid


def test_dump_then_recovery_rewards_pullback_entry(tmp_path):
    store = Store(str(tmp_path / "l.db"))
    lab = StrategyLab(store)
    _signal(store, lab, "M", 0.0)
    # langsung jatuh -20% dalam 10 detik, lalu naik ke +40% dari harga sinyal
    for t, p in [(5, 0.9), (10, 0.8), (40, 0.85), (70, 1.0), (200, 1.4)]:
        lab.on_price("M", p, t)
    lab.tick(5000)
    row = store.lab_signals()[0]
    import json
    res = json.loads(row["lab"])
    assert res.pop("_v") == 2
    assert set(res) == set(ENTRY_RULES)
    assert res["langsung"]["cells"]["15/50"] == -20.0           # SL 15 tersentuh saat harga sudah -20% (gap)
    assert res["tunda30"]["in"] is False                         # 30 dtk: harga sudah turun >5% → skip
    assert res["pullback15"]["in"] is True                       # masuk di 0.8 setelah turun dari 1.0
    assert res["pullback15"]["cells"]["30/50"] == 75.0           # 0.8 → 1.4: TP 50 tersentuh di +75% (gap naik)
    assert res["tunda60"]["in"] is True                          # di 70 dtk harga 1.0 (tidak turun) → masuk


def test_analysis_flags_only_consistently_profitable_rules(tmp_path):
    store = Store(str(tmp_path / "l.db"))
    lab = StrategyLab(store)
    for i in range(240):
        mint = f"M{i}"
        _signal(store, lab, mint, i * 1000.0)
        t0 = i * 1000.0
        # pola berulang: dump -25% lalu pump ke +60% dari harga sinyal
        for dt, p in [(5, 0.85), (10, 0.75), (100, 1.0), (300, 1.6)]:
            lab.on_price(mint, p, t0 + dt)
        lab.tick(t0 + 5000)
    a = lab.analyze(cost_pct=7.5)
    assert a["signals"] == 240
    robust = {(r["rule"], r["exit"]) for r in a["robust"]}
    assert ("pullback15", "30/100") in robust or ("pullback25", "30/100") in robust
    assert not any(r["rule"] == "langsung" and r["exit"].startswith(("10/", "15/", "20/")) for r in a["robust"])
    assert a["baseline_best"] is not None



def test_confirm_entry_and_old_lab_rows_ignored(tmp_path):
    import json
    store = Store(str(tmp_path / "l.db"))
    lab = StrategyLab(store)
    _signal(store, lab, "A", 0.0)
    for t, p in [(30, 1.05), (61, 1.15), (300, 1.5)]:
        lab.on_price("A", p, t)
    lab.tick(5000)
    res = json.loads(store.lab_signals()[0]["lab"])
    assert res["lanjut60"]["in"] is True                         # 60 dtk: +15% ≥ +10% → masuk
    # baris lab versi lama (tanpa _v) tidak ikut dianalisis
    sid = store.add_signal("OLD", 1.0, 80, {}, {}, 1.0, False)
    store.update_signal_lab(sid, {"langsung": {"in": True, "cells": {"10/25": 25.0}}})
    from pfagent.lab import analyze_rows
    a = analyze_rows(lab.fetch(), 7.5, min_n=1)
    assert a["signals"] == 1
