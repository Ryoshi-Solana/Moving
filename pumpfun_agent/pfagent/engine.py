"""
Otak agent: menerima event market, memutuskan entry/exit, menjaga risiko,
mencatat semuanya, dan mengirim laporan.

Engine tidak tahu apa-apa soal websocket/Telegram secara langsung:
  - event masuk lewat  on_message(msg, now)
  - waktu berjalan lewat maintenance(now)   (dipanggil tiap ~5 detik)
  - pesan keluar lewat notify(text)
Karena itu engine yang sama bisa dipakai untuk live, paper, replay, dan test.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable, Protocol

from .broker import Fill, OrderError
from .config import Params, Settings
from .lab import StrategyLab
from .learner import Learner
from .market import Features, MarketTracker, TokenState
from .narrative import NarrativeTracker
from .reports import esc, pumpfun_link
from .risk import RiskManager
from .store import Position, Store
from .strategy import PositionView, components, evaluate_exit, hard_filters, score

log = logging.getLogger(__name__)

Notifier = Callable[[str], Awaitable[None]]
MetadataFetcher = Callable[[str], Awaitable[dict | None]]


class Broker(Protocol):
    mode: str
    async def cash_balance(self) -> float: ...
    async def buy(self, tok: TokenState, sol_amount: float) -> Fill: ...
    async def sell(self, tok: TokenState, tokens: float) -> Fill: ...


class Subscriber(Protocol):
    async def subscribe_trades(self, mints: list[str]) -> None: ...
    async def unsubscribe_trades(self, mints: list[str]) -> None: ...


class _NullFeed:
    async def subscribe_trades(self, mints): pass
    async def unsubscribe_trades(self, mints): pass


async def _noop_notify(text: str) -> None:
    pass


def short(mint: str) -> str:
    return f"{mint[:4]}…{mint[-4:]}" if len(mint) > 10 else mint


class Agent:
    EVAL_INTERVAL = 2.0          # detik antar evaluasi entry per token
    EQUITY_INTERVAL = 60.0
    TUNE_INTERVAL = 30 * 60.0

    def __init__(self, settings: Settings, params: Params, store: Store, broker: Broker,
                 notify: Notifier | None = None, feed: Subscriber | None = None,
                 fetch_metadata: MetadataFetcher | None = None):
        self.s = settings
        self.p = params
        self.store = store
        self.broker = broker
        self.mode = broker.mode
        self.notify_fn = notify or _noop_notify
        self.feed: Subscriber = feed or _NullFeed()
        self.fetch_metadata = fetch_metadata

        self.market = MarketTracker()
        self.narrative = NarrativeTracker()
        self.learner = Learner(store, params)
        self.lab = StrategyLab(store)
        self._last_lab_log_at = 0.0
        self.risk = RiskManager.from_dict(params, store.get(f"risk_{self.mode}"))
        self.positions: dict[str, Position] = {p.mint: p for p in store.open_positions(self.mode)}

        self.cash = 0.0
        self.started_at = 0.0
        self._busy: set[str] = set()
        self._sell_retry_at: dict[str, float] = {}
        self._last_eval: dict[str, float] = {}
        self._last_equity_at = 0.0
        self._last_tune_at = 0.0
        self._last_report_day = store.get(f"last_report_day_{self.mode}", "")
        self._bg_tasks: set[asyncio.Task] = set()
        # Paper: order instan & deterministik → jalankan langsung.
        # Live: konfirmasi tx bisa puluhan detik → jalankan di background supaya
        # feed (dan SL posisi lain) tidak ikut berhenti.
        self.inline_orders = self.mode == "paper"
        self.counters: Counter = Counter()
        self.rejections: Counter = Counter()
        self.last_candidates: list[dict] = []

    # ------------------------------------------------------------ util

    async def notify(self, text: str) -> None:
        try:
            await self.notify_fn(text)
        except Exception:
            log.exception("gagal kirim notifikasi")

    def local_dt(self, ts: float) -> datetime:
        return datetime.fromtimestamp(ts, tz=timezone.utc) + timedelta(hours=self.s.tz_offset_hours)

    def _spawn(self, coro) -> None:
        task = asyncio.ensure_future(coro)
        self._bg_tasks.add(task)
        task.add_done_callback(self._bg_tasks.discard)

    async def _dispatch(self, mint: str, coro) -> None:
        self._busy.add(mint)
        if self.inline_orders:
            await coro
        else:
            self._spawn(coro)

    def save_state(self) -> None:
        self.store.put(f"risk_{self.mode}", self.risk.to_dict())
        self.store.put("params", self.p.to_dict())
        if self.mode == "paper" and isinstance(getattr(self.broker, "cash", None), float):
            self.store.put("paper_cash", self.broker.cash)

    def position_value(self, pos: Position) -> float:
        tok = self.market.tokens.get(pos.mint)
        price = tok.spot_price() if tok else pos.entry_price
        exit_cost = (self.p.pump_fee_pct + self.p.platform_fee_pct) / 100
        return pos.tokens_held * price * (1 - exit_cost)

    def equity(self) -> float:
        return self.cash + sum(self.position_value(p) for p in self.positions.values())

    async def refresh_cash(self) -> None:
        try:
            self.cash = await self.broker.cash_balance()
        except Exception as exc:
            log.warning("gagal baca saldo: %s", exc)

    # ------------------------------------------------------------ musim (reset paper)

    @property
    def season_start(self) -> float:
        return float(self.store.get(f"season_start_{self.mode}", 0.0))

    @property
    def season_no(self) -> int:
        return int(self.store.get(f"season_no_{self.mode}", 1))

    async def reset_paper(self, now: float, reason: str = "") -> int:
        """Mulai musim baru: tutup posisi, saldo paper kembali ke modal awal, rem darurat di-reset.
        Riwayat trade & data learner tetap disimpan."""
        if self.mode != "paper":
            raise RuntimeError("reset hanya untuk paper trading")
        closed = await self.close_all("RESET MUSIM", now)
        old_equity = self.equity()
        self.broker.cash = float(self.s.paper_start_balance_sol)
        await self.refresh_cash()
        from .risk import RiskState
        self.risk.state = RiskState()
        eq = self.equity()
        self.risk.roll_day(self.local_dt(now).strftime("%Y-%m-%d"), eq)
        self.risk.on_equity(eq)
        # musim yang belum punya trade tutup diulang saja, bukan menambah nomor
        has_trades = bool(self.store.closed_positions(self.mode, since=self.season_start, limit=1)) or closed > 0
        season = self.season_no + 1 if (has_trades or self.season_start == 0) else self.season_no
        # sedikit setelah `now` supaya posisi yang ditutup saat reset masuk musim lama
        self.store.put(f"season_start_{self.mode}", now + 0.001)
        self.store.put(f"season_no_{self.mode}", season)
        self.save_state()
        log.info("PUMPY reset paper → musim %d (equity lama %.4f, %d posisi ditutup) %s",
                 season, old_equity, closed, reason)
        await self.notify(
            f"🔄 <b>PUMPY · reset paper trading → musim {season}</b>\n"
            f"Equity musim lalu: {old_equity:.4f} SOL · posisi ditutup: {closed}\n"
            f"Modal baru: <b>{eq:.4f} SOL</b>"
            + (f" · entry tetap {self.p.fixed_position_sol:g} SOL" if self.p.fixed_position_sol > 0 else "")
            + f"\nmin_score {self.p.min_score:.0f} · data learner tetap dipakai"
        )
        return season

    async def start(self, now: float | None = None) -> None:
        now = now or time.time()
        self.started_at = now
        await self.refresh_cash()
        eq = self.equity()
        self.risk.roll_day(self.local_dt(now).strftime("%Y-%m-%d"), eq)
        self.risk.on_equity(eq)
        for pos in self.positions.values():
            # posisi dari sesi sebelumnya: harga diperbarui begitu ada trade masuk,
            # sementara itu exit berbasis waktu tetap berjalan
            if pos.mint not in self.market.tokens:
                self.market.tokens[pos.mint] = TokenState(
                    mint=pos.mint, symbol=pos.symbol, name=pos.name, created_at=pos.opened_at,
                    last_price=pos.entry_price, last_trade_at=now,
                )
        if self.positions:
            await self.feed.subscribe_trades(list(self.positions))
        self.save_state()

    # ------------------------------------------------------------ event

    async def on_message(self, msg: dict, now: float) -> None:
        tx = msg.get("txType")
        if tx == "create":
            await self._on_create(msg, now)
        elif tx in ("buy", "sell"):
            await self._on_trade(msg, now)
        elif tx in ("migrate", "migration") or msg.get("method") == "migration":
            self.market.on_migration(msg)

    async def _on_create(self, msg: dict, now: float) -> None:
        tok = self.market.on_create(msg, now)
        if tok is None:
            return
        self.counters["tokens_seen"] += 1
        self.narrative.on_launch(tok.mint, tok.name, tok.symbol, now)
        await self.feed.subscribe_trades([tok.mint])

    async def _on_trade(self, msg: dict, now: float) -> None:
        tok = self.market.on_trade(msg, now)
        if tok is None:
            return
        self.counters["trades_seen"] += 1
        if msg.get("txType") == "buy":
            self.narrative.on_buy(tok.mint, float(msg.get("solAmount") or 0), now)
        self.learner.on_price(tok.mint, tok.spot_price(), now)
        self.lab.on_price(tok.mint, tok.spot_price(), now)

        if tok.mint in self.positions:
            await self._manage_position(tok.mint, now)
            return
        last = self._last_eval.get(tok.mint, 0.0)
        if now - last >= self.EVAL_INTERVAL:
            self._last_eval[tok.mint] = now
            await self._evaluate_entry(tok, now)

    # ------------------------------------------------------------ entry

    async def _evaluate_entry(self, tok: TokenState, now: float) -> None:
        f = self.market.features(tok.mint, now)
        if f is None:
            return
        reasons = hard_filters(f, self.p)
        if reasons:
            self.rejections[reasons[0]] += 1
            return

        if self.fetch_metadata and not tok.metadata_checked:
            tok.metadata_checked = True
            self._spawn(self._load_metadata(tok))

        heat, kw = self.narrative.token_score(tok.mint, now)
        comps = components(f, heat)
        sc = score(comps, self.learner.weights)
        self.counters["candidates"] += 1

        ok, why = self.risk.can_open(tok.mint, now, set(self.positions) | self._busy, self.cash)
        if not self.p.trading_enabled:
            ok, why = False, "trading dimatikan (mode lab)"
        will_buy = ok and sc >= self.p.min_score
        sid = self.learner.record(tok.mint, now, sc, comps, f.as_dict(), tok.spot_price(), will_buy)
        self.lab.add(sid, tok.mint, now, tok.spot_price())

        self.last_candidates.insert(0, {
            "mint": tok.mint, "symbol": tok.symbol, "score": sc, "narrative": kw,
            "mcap": f.mcap_sol, "ts": now, "action": "BELI" if will_buy else (why or "skor kurang"),
        })
        del self.last_candidates[15:]

        if not will_buy:
            if sc < self.p.min_score:
                self.rejections["skor di bawah min_score"] += 1
            return
        await self._dispatch(tok.mint, self._open(tok, f, sc, comps, kw, now, sid))

    async def _load_metadata(self, tok: TokenState) -> None:
        try:
            meta = await self.fetch_metadata(tok.uri) if tok.uri else None
        except Exception:
            meta = None
        if not meta:
            return
        tok.has_socials = any(str(meta.get(k) or "").startswith("http") for k in ("twitter", "telegram", "website"))
        tok.description = str(meta.get("description") or "")[:280]
        self.narrative.add_description(tok.mint, tok.description)

    async def _open(self, tok: TokenState, f: Features, sc: float, comps: dict, kw: str, now: float,
                    sid: int | None = None) -> bool:
        size = self.risk.position_size(self.equity(), self.cash, sc)
        if size <= 0:
            self._busy.discard(tok.mint)
            self.rejections["ukuran posisi terlalu kecil"] += 1
            return False
        self._busy.add(tok.mint)
        spot = tok.spot_price()  # harga pasar saat keputusan beli = acuan SL/TP
        try:
            fill = await self.broker.buy(tok, size)
        except OrderError as exc:
            await self.notify(f"⚠️ Gagal beli <b>{esc(tok.symbol)}</b>: {esc(exc)}")
            return False
        except Exception as exc:
            log.exception("buy error")
            await self.notify(f"⚠️ Error beli <b>{esc(tok.symbol)}</b>: {esc(exc)}")
            return False
        finally:
            self._busy.discard(tok.mint)

        pos = Position(
            mint=tok.mint, symbol=tok.symbol, name=tok.name, mode=self.mode, opened_at=now,
            entry_price=fill.price, tokens_bought=fill.tokens, tokens_held=fill.tokens,
            sol_in=fill.sol, peak_price=spot or fill.price, score=sc, narrative=kw,
            features={**f.as_dict(), "components": comps}, entry_spot=spot or fill.price,
        )
        self.store.save_position(pos)
        self.store.add_fill(pos.id, now, "buy", fill.sol, fill.tokens, fill.price, fill.fee_sol, fill.signature, "entry")
        self.positions[tok.mint] = pos
        self.learner.mark_bought(sid)
        await self.refresh_cash()
        self.save_state()
        self.counters["entries"] += 1

        top = sorted(comps.items(), key=lambda kv: kv[1], reverse=True)[:3]
        why = ", ".join(f"{k} {v:.2f}" for k, v in top)
        await self.notify(
            f"🟢 <b>BELI {esc(tok.symbol)}</b> ({self.mode})\n"
            f"Ukuran: {fill.sol:.4f} SOL · skor {sc:.0f}\n"
            f"MCap: {f.mcap_sol:.0f} SOL · umur {f.age_sec / 60:.1f}m\n"
            f"Pembeli 5m: {f.unique_buyers_5m} · buy vol 2m: {f.buy_vol_2m:.1f} SOL · buy ratio {f.buy_ratio_1m:.0%}\n"
            f"Narrative: {kw or '-'} · alasan: {why}\n"
            f"SL -{self.p.stop_loss_pct:.0f}% · TP1 +{self.p.tp1_pct:.0f}%\n"
            f"<code>{tok.mint}</code>\n"
            f"{pumpfun_link(tok.mint)}"
        )
        return True

    # ------------------------------------------------------------ exit

    async def _manage_position(self, mint: str, now: float) -> None:
        if mint in self._busy or now < self._sell_retry_at.get(mint, 0):
            return
        pos = self.positions.get(mint)
        tok = self.market.tokens.get(mint)
        if pos is None or tok is None:
            return
        price = tok.spot_price()
        if price <= 0:
            return
        if not tok.trades:
            # posisi hasil restart & belum ada trade baru: harga belum diketahui,
            # jadi hanya batas waktu yang boleh memicu exit
            if (now - pos.opened_at) / 60 >= self.p.max_hold_minutes:
                await self._dispatch(mint, self._sell(pos, tok, 1.0, "WAKTU HABIS (tidak ada trade)", now))
            return
        pos.peak_price = max(pos.peak_price, price)
        f = self.market.features(mint, now)
        # SL/TP diukur dari harga pasar saat masuk, bukan dari biaya efektif (yang sudah termasuk fee):
        # kalau tidak, SL -12% sebenarnya cuma ±-8.7% dari harga pasar dan habis oleh noise biasa.
        ref = pos.entry_spot or pos.entry_price
        view = PositionView(ref, pos.opened_at, pos.peak_price, pos.tp1_done, pos.tp2_done, pos.stop_price)
        decision = evaluate_exit(view, price, f, now, self.p)
        if decision is None:
            return
        if decision.new_stop_price is not None:
            pos.stop_price = decision.new_stop_price
        if "tp1" in decision.mark:
            pos.tp1_done = True
        if "tp2" in decision.mark:
            pos.tp2_done = True
        self.store.save_position(pos)
        if decision.fraction > 0:
            await self._dispatch(mint, self._sell(pos, tok, decision.fraction, decision.reason, now))

    async def _sell(self, pos: Position, tok: TokenState, fraction: float, reason: str, now: float) -> None:
        tokens = pos.tokens_held * fraction
        full = fraction >= 0.999 or (pos.tokens_held - tokens) < pos.tokens_bought * 0.05
        if full:
            tokens = pos.tokens_held
        self._busy.add(pos.mint)
        try:
            fill = await self.broker.sell(tok, tokens)
        except Exception as exc:
            self._sell_retry_at[pos.mint] = now + 5
            self.counters["sell_errors"] += 1
            log.warning("sell %s gagal: %s", pos.symbol, exc)
            if self.counters["sell_errors"] % 5 == 1:
                await self.notify(f"⚠️ Gagal jual <b>{esc(pos.symbol)}</b> ({reason}): {esc(exc)} — dicoba lagi")
            return
        finally:
            self._busy.discard(pos.mint)

        pos.tokens_held = 0.0 if full else max(pos.tokens_held - fill.tokens, 0.0)
        pos.sol_out += fill.sol
        self.store.add_fill(pos.id, now, "sell", fill.sol, fill.tokens, fill.price, fill.fee_sol, fill.signature, reason)
        await self.refresh_cash()

        if pos.tokens_held <= 0:
            await self._close(pos, reason, now)
        else:
            self.store.save_position(pos)
            gain = (fill.price / pos.entry_price - 1) * 100
            await self.notify(
                f"🟡 <b>{reason}</b> {esc(pos.symbol)}\n"
                f"Jual {fraction:.0%} → {fill.sol:.4f} SOL ({gain:+.1f}%)\n"
                f"Sisa posisi jalan dengan SL di {((pos.stop_price or pos.entry_price) / pos.entry_price - 1) * 100:+.0f}%"
            )
        self.save_state()

    async def _close(self, pos: Position, reason: str, now: float) -> None:
        pos.status = "closed"
        pos.closed_at = now
        pos.exit_reason = reason
        pos.pnl_sol = pos.sol_out - pos.sol_in
        pos.pnl_pct = pos.pnl_sol / pos.sol_in * 100 if pos.sol_in else 0.0
        self.store.save_position(pos)
        self.positions.pop(pos.mint, None)
        self.counters["exits"] += 1
        risk_msg = self.risk.on_position_closed(pos.mint, pos.pnl_sol, now)
        # jurnal satu baris per trade → bisa dianalisis dari log server
        feat = pos.features or {}
        log.info("PUMPY_TRADE %s", json.dumps({
            "mode": self.mode, "symbol": pos.symbol, "mint": pos.mint,
            "opened_at": round(pos.opened_at), "held_min": round((now - pos.opened_at) / 60, 2),
            "exit": pos.exit_reason, "pnl_sol": round(pos.pnl_sol, 5), "pnl_pct": round(pos.pnl_pct, 2),
            "peak_pct": round((pos.peak_price / (pos.entry_spot or pos.entry_price) - 1) * 100, 1)
            if pos.entry_price else None,
            "sl": self.p.stop_loss_pct, "tp1_pct": self.p.tp1_pct,
            "score": round(pos.score, 1), "narrative": pos.narrative, "tp1": pos.tp1_done,
            "sol_in": round(pos.sol_in, 4),
            "f": {k: (round(v, 3) if isinstance(v, float) else v) for k, v in feat.items() if k != "components"},
            "c": {k: round(v, 3) for k, v in (feat.get("components") or {}).items()},
        }, ensure_ascii=False))
        icon = "✅" if pos.pnl_sol >= 0 else "🔴"
        held = (now - pos.opened_at) / 60
        await self.notify(
            f"{icon} <b>TUTUP {esc(pos.symbol)}</b> — {reason}\n"
            f"PnL: {pos.pnl_sol:+.4f} SOL ({pos.pnl_pct:+.1f}%) · ditahan {held:.1f}m\n"
            f"Equity: {self.equity():.4f} SOL"
        )
        if risk_msg:
            await self.notify(f"🛑 {risk_msg}")

    async def close_position(self, mint: str, reason: str = "MANUAL", now: float | None = None) -> bool:
        pos = self.positions.get(mint)
        tok = self.market.tokens.get(mint)
        if pos is None:
            return False
        if tok is None:
            tok = TokenState(mint=mint, last_price=pos.entry_price)
            self.market.tokens[mint] = tok
        self._sell_retry_at.pop(mint, None)
        await self._sell(pos, tok, 1.0, reason, now or time.time())
        return mint not in self.positions

    # ------------------------------------------------------------ waktu

    async def maintenance(self, now: float) -> None:
        for mint in list(self.positions):
            await self._manage_position(mint, now)

        self.learner.tick(now)
        self.lab.tick(now)
        self.narrative.maintenance(now)
        self.risk.prune(now)

        keep = set(self.positions) | {s.mint for s in self.learner.open.values()} | self.lab.mints
        removed = self.market.prune(now, keep, max_age_sec=self.p.max_age_minutes * 60 + 600)
        if removed:
            await self.feed.unsubscribe_trades(removed)
            for mint in removed:
                self.narrative.forget(mint)
                self._last_eval.pop(mint, None)

        if now - self._last_equity_at >= self.EQUITY_INTERVAL:
            self._last_equity_at = now
            if self.mode == "live":
                await self.refresh_cash()
            eq = self.equity()
            self.store.add_equity(now, eq, self.cash)
            day = self.local_dt(now).strftime("%Y-%m-%d")
            self.risk.roll_day(day, eq)
            halt = self.risk.on_equity(eq)
            if halt:
                await self.notify(f"🛑 <b>REM DARURAT</b>: {halt}")
                if self.risk.state.halted:
                    await self.close_all("KILL SWITCH", now)
            await self._maybe_daily_report(now)
            self.save_state()

        if now - self._last_lab_log_at >= 3600:
            self._last_lab_log_at = now
            try:
                a = await self.lab.analyze_async(self.learner.round_trip_cost_pct())
                log.info("PUMPY_LAB %s", json.dumps({
                    "signals": a["signals"], "baseline": a["baseline_best"],
                    "top": a["results"][:12], "robust": a["robust"][:12],
                }, ensure_ascii=False))
            except Exception:
                log.exception("lab analyze error")

        if now - self._last_tune_at >= self.TUNE_INTERVAL:
            self._last_tune_at = now
            changes = self.learner.tune()
            if changes:
                self.save_state()
                await self.notify("🧠 <b>Agent menyesuaikan strategi</b>\n" + "\n".join(f"• {c}" for c in changes))

    async def close_all(self, reason: str, now: float | None = None) -> int:
        closed = 0
        for mint in list(self.positions):
            if await self.close_position(mint, reason, now):
                closed += 1
        return closed

    async def _maybe_daily_report(self, now: float) -> None:
        local = self.local_dt(now)
        day = local.strftime("%Y-%m-%d")
        if local.hour >= self.s.daily_report_hour and self._last_report_day != day:
            self._last_report_day = day
            self.store.put(f"last_report_day_{self.mode}", day)
            from .reports import daily_report
            await self.notify(daily_report(self, now))
