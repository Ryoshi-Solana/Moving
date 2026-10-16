"""
Cara pakai:
  python -m pfagent run                 # jalankan agent (mode dari AGENT_MODE, default paper)
  python -m pfagent check               # cek konfigurasi tanpa menjalankan apa pun
  python -m pfagent replay rekaman.jsonl [--balance 1.0] [--verbose]
                                         # uji strategi di data rekaman (AGENT_RECORD_PATH)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import signal
import sys
import time

from .broker import LiveBroker, PaperBroker
from .config import Params, Settings
from .engine import Agent
from .store import Store

log = logging.getLogger("pfagent")


def _load_dotenv() -> None:
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass


def load_params(store: Store) -> Params:
    params = Params()
    params.update_from(store.get("params") or {})
    return params


async def fetch_metadata_factory():
    import httpx
    client = httpx.AsyncClient(timeout=4, follow_redirects=True)

    async def fetch(uri: str):
        if not uri.startswith("http"):
            return None
        resp = await client.get(uri)
        if resp.status_code != 200 or len(resp.content) > 50_000:
            return None
        data = resp.json()
        return data if isinstance(data, dict) else None

    return fetch, client


async def run(settings: Settings) -> None:
    from .feed import PumpPortalFeed
    from .onchain import OnchainTradeFeed
    from .telegram_ui import TelegramUI

    store = Store(settings.db_path)
    params = load_params(store)
    if settings.mode == "live":
        params.max_position_sol = min(params.max_position_sol, settings.live_max_position_sol)
        broker = LiveBroker(settings, params)
    else:
        broker = PaperBroker(params, settings.paper_start_balance_sol, cash=store.get("paper_cash"))

    tg = TelegramUI(settings)
    fetch, http_client = (await fetch_metadata_factory()) if settings.fetch_metadata else (None, None)
    agent = Agent(settings, params, store, broker, notify=tg.send, fetch_metadata=fetch)
    feed = PumpPortalFeed(settings.ws_url, agent.on_message, settings.record_path)
    trades = OnchainTradeFeed(settings.ws_url_list(), agent.on_message, settings.record_path)
    agent.feed = trades  # engine mendaftarkan mint yang dipantau ke feed on-chain

    await agent.start()
    try:
        await tg.start(agent, feed)
    except Exception as exc:
        # token salah dll: agent tetap jalan, laporan hanya ke log
        log.error("Telegram gagal start (%s) — cek TELEGRAM_BOT_TOKEN. Agent jalan tanpa Telegram.", exc)
        tg.enabled = False
        tg.app = None
    await tg.send(
        f"🤖 <b>Agent mulai</b> · mode <b>{settings.mode.upper()}</b>\n"
        f"Equity {agent.equity():.4f} SOL · posisi terbuka {len(agent.positions)}\n"
        "Ketik /help untuk daftar perintah."
    )

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass

    async def maintenance_loop():
        last_feed_warn = 0.0
        last_trade_warn = 0.0
        last_stats = time.time()
        trades_ok_announced = False
        while not stop.is_set():
            now = time.time()
            try:
                await agent.maintenance(now)
            except Exception:
                log.exception("maintenance error")
            # feed mati lama = buta terhadap harga; beri tahu
            last_data = feed.last_message_at or agent.started_at
            if now - last_data > 120 and now - last_feed_warn > 900:
                last_feed_warn = now
                await agent.notify("⚠️ Tidak ada token baru dari PumpPortal >2 menit.")
            last_trade = trades.last_trade_at or agent.started_at
            if now - last_trade > 120 and now - last_trade_warn > 900:
                last_trade_warn = now
                await agent.notify("⚠️ Tidak ada data trade on-chain >2 menit. SL tidak bisa bereaksi tanpa data! "
                                   "Agent mencoba RPC lain otomatis.")
            if agent.counters["trades_seen"] > 0 and not trades_ok_announced:
                trades_ok_announced = True
                await agent.notify("✅ Data trade on-chain (gratis) masuk. Agent mulai menilai token & paper trading.")
            if now - last_stats >= 300:
                last_stats = now
                c = agent.counters
                log.info("stats: token_baru=%d trade=%d kandidat=%d entry=%d exit=%d dipantau=%d "
                         "posisi=%d equity=%.4f pumpportal=%s %s onchain=%s %s reconnect=%d/%d tolak_teratas=%s",
                         c["tokens_seen"], c["trades_seen"], c["candidates"], c["entries"], c["exits"],
                         len(agent.market.tokens), len(agent.positions), agent.equity(),
                         "ok" if feed.connected else "putus", feed.msg_types,
                         trades.current_url if trades.connected else "putus",
                         {k: round(v, 1) for k, v in trades.stats.items()},
                         feed.reconnects, trades.reconnects, agent.rejections.most_common(3))
            await asyncio.sleep(5)

    tasks = [asyncio.create_task(feed.run()), asyncio.create_task(trades.run()),
             asyncio.create_task(maintenance_loop())]
    await stop.wait()
    log.info("berhenti…")
    feed.stop()
    trades.stop()
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    agent.save_state()
    await tg.send("⏹ Agent dimatikan. Posisi terbuka tetap ada dan akan dijaga lagi saat agent hidup.")
    await tg.stop()
    if http_client:
        await http_client.aclose()
    if isinstance(broker, LiveBroker):
        await broker.close()
    store.close()


async def replay(path: str, balance: float, verbose: bool, db_path: str = ":memory:") -> dict:
    """Putar ulang rekaman feed dengan paper broker dan waktu simulasi."""
    settings = Settings(mode="paper", paper_start_balance_sol=balance, fetch_metadata=False)
    store = Store(db_path)
    params = load_params(store) if db_path != ":memory:" else Params()
    broker = PaperBroker(params, balance)

    async def notify(text: str) -> None:
        if verbose:
            print(re.sub(r"<[^>]+>", "", text), "\n")

    agent = Agent(settings, params, store, broker, notify=notify)
    started = False
    next_tick = 0.0
    now = 0.0
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            try:
                rec = json.loads(line)
                now, msg = float(rec["t"]), rec["m"]
            except (ValueError, KeyError, TypeError):
                continue
            if not started:
                await agent.start(now)
                next_tick = now + 5
                started = True
            while now >= next_tick:
                await agent.maintenance(next_tick)
                next_tick += 5
            await agent.on_message(msg, now)
    if not started:
        raise SystemExit("rekaman kosong")
    await agent.close_all("AKHIR REPLAY", now)
    from .reports import pnl_summary
    summary = pnl_summary(agent, 0)
    summary["final_equity"] = agent.equity()
    summary["start_balance"] = balance
    summary["learner"] = agent.learner.analyze()
    store.close()
    return summary


def main(argv: list[str] | None = None) -> int:
    _load_dotenv()
    logging.basicConfig(format="%(asctime)s %(levelname)s %(name)s: %(message)s",
                        level=os.environ.get("LOG_LEVEL", "INFO"), stream=sys.stdout)
    logging.getLogger("httpx").setLevel(logging.WARNING)

    parser = argparse.ArgumentParser(prog="pfagent")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("run")
    sub.add_parser("check")
    rp = sub.add_parser("replay")
    rp.add_argument("path")
    rp.add_argument("--balance", type=float, default=1.0)
    rp.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    if args.cmd == "replay":
        s = asyncio.run(replay(args.path, args.balance, args.verbose))
        print(f"Trade: {s['n']} · win rate {s['win_rate']:.0%} · PnL {s['pnl_sol']:+.4f} SOL")
        print(f"Equity akhir: {s['final_equity']:.4f} SOL (awal {s['start_balance']:.4f})")
        lr = s["learner"]
        if lr["samples"]:
            print(f"Sinyal dievaluasi: {lr['samples']} · ekspektasi {lr['expectancy_pct']:+.1f}%/sinyal")
        return 0

    settings = Settings.from_env()
    errors = settings.validate()
    if args.cmd == "check":
        print(f"mode: {settings.mode}")
        print(f"telegram: {'OK' if settings.telegram_token and settings.telegram_chat_id else 'BELUM DIISI'}")
        print(f"RPC websocket trade: {', '.join(u.split('?')[0] for u in settings.ws_url_list())}")
        print(f"database: {settings.db_path}")
        for e in errors:
            print(f"ERROR: {e}")
        return 1 if errors else 0
    if errors:
        for e in errors:
            print(f"ERROR: {e}", file=sys.stderr)
        return 1
    asyncio.run(run(settings))
    return 0


if __name__ == "__main__":
    sys.exit(main())
