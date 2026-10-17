import asyncio
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pfagent.broker import PaperBroker, curve_buy_tokens, curve_sell_sol  # noqa: E402
from pfagent.config import LIVE_CONFIRM_PHRASE, Params, Settings  # noqa: E402
from pfagent.engine import Agent  # noqa: E402
from pfagent.market import Features, MarketTracker, TokenState  # noqa: E402
from pfagent.narrative import NarrativeTracker, keywords  # noqa: E402
from pfagent.reports import (candidates_text, daily_report, learn_text, narratives_text,  # noqa: E402
                             params_text, pnl_text, positions_text, status_text, trades_text)
from pfagent.risk import RiskManager  # noqa: E402
from pfagent.store import Store  # noqa: E402
from pfagent.strategy import PositionView, evaluate_exit  # noqa: E402
from sim import SimToken, pump_then, wallet  # noqa: E402


def run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------- config

def test_params_set_validation():
    p = Params()
    assert p.set("stop_loss_pct", "10") == 10.0
    assert p.set("max_open_positions", "2") == 2
    assert p.set("auto_tune", "off") is False
    for key, raw in [("stop_loss_pct", "80"), ("tp1_sell_fraction", "2"), ("nope", "1"), ("min_score", "-1")]:
        with pytest.raises(ValueError):
            p.set(key, raw)


def test_live_mode_requires_explicit_confirmation():
    s = Settings(mode="live", wallet_private_key="x")
    errs = s.validate()
    assert any("LIVE_TRADING_CONFIRM" in e for e in errs)
    assert any("RPC" in e for e in errs)
    s = Settings(mode="live", wallet_private_key="x", live_confirm=LIVE_CONFIRM_PHRASE, rpc_url="https://my.rpc")
    assert s.validate() == []


# ---------------------------------------------------------------- broker

def test_paper_round_trip_costs_money():
    p = Params()
    broker = PaperBroker(p, 1.0)
    tok = TokenState(mint="m", v_sol=40.0, v_tokens=800_000_000.0)
    buy = run(broker.buy(tok, 0.1))
    sell = run(broker.sell(tok, buy.tokens))
    loss_pct = (1 - sell.sol / buy.sol) * 100
    # fee 2x1.75% + latensi 2x2% + priority fee → rugi ~8-9% kalau harga diam
    assert 6 < loss_pct < 12
    assert broker.cash == pytest.approx(1.0 - buy.sol + sell.sol)


def test_curve_math_is_symmetric():
    tokens = curve_buy_tokens(30, 1_073_000_000, 1.0)
    v_sol, v_tok = 31.0, 1_073_000_000 - tokens
    assert curve_sell_sol(v_sol, v_tok, tokens) == pytest.approx(1.0)


# ---------------------------------------------------------------- risk

def test_position_size_respects_risk_and_caps():
    p = Params(risk_per_trade_pct=2, stop_loss_pct=12, max_position_pct=10, max_position_sol=0.1)
    r = RiskManager(p)
    size = r.position_size(equity=1.0, cash=1.0)
    # 2% risk / (12% SL + biaya ~7.5%) ≈ 0.10, dibatasi 10% equity = 0.1
    assert size == pytest.approx(0.1)
    p.risk_per_trade_pct = 1
    assert r.position_size(1.0, 1.0) < 0.06
    assert r.position_size(0.05, 0.05) == 0.0  # di bawah minimum


def test_consecutive_losses_trigger_cooldown():
    p = Params(max_consecutive_losses=3, loss_cooldown_minutes=10)
    r = RiskManager(p)
    msgs = [r.on_position_closed(f"m{i}", -0.01, 100.0) for i in range(3)]
    assert msgs[-1] is not None
    ok, why = r.can_open("new", 200.0, set(), 1.0)
    assert not ok and "cooldown" in why
    assert r.can_open("new", 100.0 + 601, set(), 1.0)[0]


def test_daily_loss_and_drawdown_stops():
    p = Params(daily_loss_limit_pct=10, max_drawdown_pct=30)
    r = RiskManager(p)
    r.roll_day("2026-01-01", 1.0)
    r.on_equity(1.0)
    assert r.on_equity(0.89) is not None
    assert not r.can_open("x", 0, set(), 1.0)[0]
    r.roll_day("2026-01-02", 0.89)
    assert r.can_open("x", 0, set(), 1.0)[0]
    assert r.on_equity(0.69) is not None and r.state.halted
    r.resume(0.69)
    assert r.can_open("x", 0, set(), 1.0)[0]


def test_reentry_and_max_positions():
    p = Params(max_open_positions=1, reentry_cooldown_minutes=30)
    r = RiskManager(p)
    assert not r.can_open("a", 0, {"b"}, 1.0)[0]
    r.on_position_closed("a", 0.01, 0)
    assert not r.can_open("a", 60, set(), 1.0)[0]
    assert r.can_open("a", 1801, set(), 1.0)[0]


# ---------------------------------------------------------------- exits

def _pos(**kw):
    base = dict(entry_price=1.0, opened_at=0.0, peak_price=1.0)
    base.update(kw)
    return PositionView(**base)


def test_stop_loss_hits():
    p = Params(stop_loss_pct=12)
    d = evaluate_exit(_pos(), 0.87, None, 10, p)
    assert d and d.fraction == 1.0 and "STOP LOSS" in d.reason
    assert evaluate_exit(_pos(), 0.9, None, 10, p) is None


def test_tp1_partial_then_breakeven_stop():
    p = Params(tp1_pct=40, tp1_sell_fraction=0.5)
    d = evaluate_exit(_pos(peak_price=1.45), 1.45, None, 10, p)
    assert d.fraction == 0.5 and d.mark == ["tp1"] and d.new_stop_price == 1.0
    d2 = evaluate_exit(_pos(peak_price=1.45, tp1_done=True, stop_price=1.0), 0.99, None, 20, p)
    assert d2.fraction == 1.0 and "BREAKEVEN" in d2.reason


def test_trailing_stop():
    p = Params(trailing_activate_pct=30, trailing_stop_pct=15, tp1_pct=500)
    assert evaluate_exit(_pos(peak_price=2.0), 1.65, None, 10, p).reason.startswith("TRAILING")
    assert evaluate_exit(_pos(peak_price=2.0), 1.65, None, 10, p).fraction == 1.0


def test_time_based_exits():
    p = Params(stale_minutes=4, stale_min_gain_pct=5, max_hold_minutes=20)
    assert "TIDAK BERGERAK" in evaluate_exit(_pos(peak_price=1.02), 1.01, None, 5 * 60, p).reason
    assert "WAKTU HABIS" in evaluate_exit(_pos(peak_price=1.2, stop_price=1.0), 1.1, None, 21 * 60, p).reason


def test_dev_dump_exit():
    p = Params()
    f = Features(dev_sold_pct=80)
    assert "DEV" in evaluate_exit(_pos(), 1.05, f, 10, p).reason


# ---------------------------------------------------------------- market & narrative

def test_market_features_from_sim():
    m = MarketTracker()
    tok = SimToken("M1", "Frog King", "FROG")
    t = 0.0
    m.on_create(tok.create(), t)
    for i in range(30):
        t += 3
        m.on_trade(tok.buy(wallet(), 0.3), t)
    f = m.features("M1", t)
    assert f.unique_buyers_5m == 30
    assert f.buy_ratio_1m == 1.0
    assert f.mcap_change_1m_pct > 0
    assert f.buy_vol_2m == pytest.approx(0.3 * 40 if False else f.buy_vol_2m)
    assert 0 < f.top10_holder_pct < 100


def test_narrative_heat_rises_with_theme():
    n = NarrativeTracker()
    assert "wizard" in keywords("CatWizard") and "cat" in keywords("CatWizard")
    now = 10_000.0
    for i in range(8):
        n.on_launch(f"m{i}", f"Wizard {i}", "WIZ", now - i * 60)
        n.on_buy(f"m{i}", 3.0, now - i * 60)
    n.on_launch("other", "Random Thing", "RND", now)
    n.on_buy("other", 0.5, now)
    heat, kw = n.token_score("m0", now)
    assert kw in ("wizard", "wiz") and heat > 0.5
    assert n.token_score("other", now)[0] < heat
    assert n.top(now)[0]["keyword"] in ("wizard", "wiz")


# ---------------------------------------------------------------- engine end-to-end

def _agent(tmp_path, **param_overrides):
    params = Params(min_score=45, fetch_metadata=False) if False else Params(min_score=45)
    for k, v in param_overrides.items():
        setattr(params, k, v)
    settings = Settings(mode="paper", paper_start_balance_sol=1.0, fetch_metadata=False)
    store = Store(str(tmp_path / "t.db"))
    sent = []

    async def notify(text):
        sent.append(text)

    agent = Agent(settings, params, store, PaperBroker(params, 1.0), notify=notify)
    return agent, sent


async def _play(agent, events):
    await agent.start(events[0][0])
    next_tick = events[0][0] + 5
    for t, msg in events:
        while t >= next_tick:
            await agent.maintenance(next_tick)
            next_tick += 5
        await agent.on_message(msg, t)
    return events[-1][0]


def test_engine_buys_momentum_and_stops_out_on_dump(tmp_path):
    agent, sent = _agent(tmp_path)
    run(_play(agent, pump_then("dump")))
    closed = agent.store.closed_positions("paper")
    assert agent.counters["entries"] >= 1, sent
    assert closed, "posisi harus ditutup setelah dump"
    assert any("BELI" in s for s in sent)
    assert any("TUTUP" in s for s in sent)
    # dump terjadi tak lama setelah entry → harus keluar rugi, tapi tidak habis
    assert all(p.pnl_sol < 0 for p in closed)
    assert all(p.pnl_pct > -60 for p in closed)
    assert agent.equity() > 0.9
    assert agent.risk.state.last_exit


def test_engine_takes_profit_on_moon(tmp_path):
    agent, sent = _agent(tmp_path, stale_minutes=10)
    end = run(_play(agent, pump_then("moon")))
    run(agent.close_all("END", end))
    closed = agent.store.closed_positions("paper")
    assert closed
    assert any("TP1" in s for s in sent), sent
    assert sum(p.pnl_sol for p in closed) > 0
    assert agent.equity() > 1.0


def test_engine_respects_pause(tmp_path):
    agent, sent = _agent(tmp_path)
    agent.risk.state.paused = True
    run(_play(agent, pump_then("moon")))
    assert agent.counters["entries"] == 0
    assert agent.counters["candidates"] > 0  # tetap belajar walau tidak trading


def test_positions_survive_restart(tmp_path):
    agent, _ = _agent(tmp_path, stale_minutes=10, tp1_pct=1000, trailing_activate_pct=1000, max_hold_minutes=1000)
    events = pump_then("moon")[:150]
    run(_play(agent, events))
    assert agent.positions
    agent.save_state()
    path = agent.store.conn.execute("PRAGMA database_list").fetchone()[2]
    agent.store.close()
    store2 = Store(path)
    agent2 = Agent(Settings(mode="paper"), Params(), store2,
                   PaperBroker(Params(), 1.0, cash=store2.get("paper_cash")))
    assert set(agent2.positions) == set(agent.positions)
    assert agent2.risk.state.day


def test_reports_render(tmp_path):
    agent, _ = _agent(tmp_path)
    end = run(_play(agent, pump_then("dump")))
    for text in (status_text(agent, end, True), positions_text(agent, end), trades_text(agent),
                 pnl_text(agent, end), narratives_text(agent, end), candidates_text(agent),
                 learn_text(agent), params_text(agent), daily_report(agent, end)):
        assert isinstance(text, str) and text


def test_html_in_token_name_is_escaped(tmp_path):
    agent, sent = _agent(tmp_path)
    events = pump_then("dump", name="<b>evil", symbol="<i>X")
    run(_play(agent, events))
    assert all("<i>X" not in s for s in sent)


def test_learner_records_and_resolves_signals(tmp_path):
    agent, _ = _agent(tmp_path)
    end = run(_play(agent, pump_then("moon")))
    run(agent.maintenance(end + 3600))
    a = agent.learner.analyze()
    assert a["samples"] >= 1
    assert a["buckets"]


def test_learner_tunes_after_enough_samples(tmp_path):
    agent, _ = _agent(tmp_path, learn_min_samples=20)
    store = agent.store
    # skor tinggi menang, skor rendah kalah → min_score harus naik
    for i in range(60):
        sc = 50 + (i % 7) * 5
        comps = {k: (0.9 if sc >= 70 else 0.2) for k in agent.learner.weights}
        sid = store.add_signal(f"m{i}", i, sc, comps, {}, 1.0, False)
        store.update_signal(sid, 40 if sc >= 70 else 0, -20 if sc < 70 else 0, "win" if sc >= 70 else "loss", i + 1)
    before = agent.p.min_score
    changes = agent.learner.tune()
    assert changes
    assert agent.p.min_score > before
    assert agent.p.min_score - before <= 5  # bergerak pelan


# ---------------------------------------------------------------- replay

def test_replay_cli(tmp_path):
    from pfagent.__main__ import replay
    path = tmp_path / "rec.jsonl"
    with open(path, "w") as fh:
        for t, msg in pump_then("moon"):
            fh.write(json.dumps({"t": t, "m": msg}) + "\n")
    summary = run(replay(str(path), 1.0, verbose=False))
    assert summary["start_balance"] == 1.0
    assert summary["final_equity"] > 0


def test_live_orders_do_not_block_the_feed(tmp_path):
    """Order live yang lambat jalan di background; event market tetap diproses."""

    class SlowBroker(PaperBroker):
        mode = "live"

        async def buy(self, tok, sol_amount):
            await asyncio.sleep(0.2)
            return await super().buy(tok, sol_amount)

    async def scenario():
        params = Params(min_score=45)
        agent = Agent(Settings(mode="live"), params, Store(str(tmp_path / "l.db")), SlowBroker(params, 1.0))
        events = pump_then("moon")[:80]
        await agent.start(events[0][0])
        for t, msg in events:
            await agent.on_message(msg, t)
        processed_before_fill = agent.counters["trades_seen"]
        assert not agent.positions  # buy masih berjalan, tapi semua event sudah diproses
        await asyncio.sleep(0.3)
        return agent, processed_before_fill

    agent, processed = run(scenario())
    assert processed == 79
    assert len(agent.positions) == 1
    assert agent.counters["entries"] == 1


def test_restored_position_still_gets_time_exit(tmp_path):
    agent, _ = _agent(tmp_path, stale_minutes=10, tp1_pct=1000, trailing_activate_pct=1000)
    events = pump_then("moon")[:150]
    end = run(_play(agent, events))
    assert agent.positions
    agent.save_state()
    path = agent.store.conn.execute("PRAGMA database_list").fetchone()[2]
    agent.store.close()
    store2 = Store(path)
    p2 = Params(max_hold_minutes=20)
    agent2 = Agent(Settings(mode="paper"), p2, store2, PaperBroker(p2, 1.0, cash=store2.get("paper_cash")))
    later = end + 3600
    run(agent2.start(later))
    run(agent2.maintenance(later + 5))  # token sudah mati, tidak ada trade masuk
    assert not agent2.positions
    assert "WAKTU HABIS" in store2.closed_positions("paper")[0].exit_reason


def test_telegram_send_failure_does_not_raise():
    from pfagent.telegram_ui import TelegramUI

    class BrokenBot:
        async def send_message(self, **kw):
            raise RuntimeError("Chat not found")

    class App:
        bot = BrokenBot()

    ui = TelegramUI(Settings(telegram_token="t", telegram_chat_id=123))
    ui.app = App()
    run(ui.send("halo"))  # tidak boleh melempar
    assert ui._send_failures == 1


def test_learner_counts_costs_and_never_loosens_below_default(tmp_path):
    """Sinyal skor rendah yang 'impas' sebelum biaya harus dianggap rugi setelah biaya."""
    agent, _ = _agent(tmp_path, learn_min_samples=20)
    assert agent.p.min_score >= 65  # dijepit ke floor walau di-set lebih rendah
    store = agent.store
    # skor <75: 33% menang (impas sebelum biaya), skor ≥75: 60% menang
    for i in range(240):
        sc = 50 + (i % 8) * 5
        win = (i % 3 == 0) if sc < 75 else (i % 5 < 3)
        sid = store.add_signal(f"m{i}", i, sc, {k: 0.5 for k in agent.learner.weights}, {}, 1.0, False)
        store.update_signal(sid, 40 if win else 0, 0 if win else -20, "win" if win else "loss", i + 1)
    a = agent.learner.analyze()
    low = [b for b in a["buckets"] if b["range"] == "55-60"][0]
    assert low["expectancy_pct"] < 0  # setelah biaya, skor rendah rugi
    for _ in range(4):
        agent.learner.tune()
    assert agent.p.min_score >= 75
