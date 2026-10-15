"""
Koneksi realtime ke PumpPortal (wss://pumpportal.fun/api/data).

Satu koneksi saja (PumpPortal membatasi koneksi per IP). Langganan:
  - subscribeNewToken   : semua token baru
  - subscribeMigration  : token yang lulus bonding curve
  - subscribeTokenTrade : trade untuk mint yang sedang kita pantau
Auto-reconnect dengan backoff, dan semua langganan dipasang ulang.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Awaitable, Callable

log = logging.getLogger(__name__)

Handler = Callable[[dict, float], Awaitable[None]]


class PumpPortalFeed:
    def __init__(self, url: str, handler: Handler, record_path: str = ""):
        self.url = url
        self.handler = handler
        self.record_path = record_path
        self.trade_subs: set[str] = set()
        self._ws = None
        self._stop = asyncio.Event()
        self._record_file = open(record_path, "a", encoding="utf-8", buffering=1) if record_path else None
        self.connected = False
        self.last_message_at = 0.0
        self.reconnects = 0
        self.msg_types: dict[str, int] = {}
        self._pending_subs: list[str] = []
        self._unknown_logged = 0
        self.trade_access_denied = False

    async def _send(self, payload: dict) -> None:
        if self._ws is not None:
            try:
                await self._ws.send(json.dumps(payload))
            except Exception as exc:  # koneksi putus; akan dipasang ulang saat reconnect
                log.debug("send gagal: %s", exc)

    async def subscribe_trades(self, mints: list[str]) -> None:
        # Tidak langsung dikirim: dikumpulkan lalu dikirim sekaligus oleh flush_subscriptions,
        # karena PumpPortal tidak suka satu pesan subscribe per token.
        new = [m for m in mints if m not in self.trade_subs]
        if not new:
            return
        self.trade_subs.update(new)
        self._pending_subs.extend(new)

    async def flush_subscriptions(self) -> None:
        if not self._pending_subs or self._ws is None or self.trade_access_denied:
            return
        keys, self._pending_subs = self._pending_subs, []
        for i in range(0, len(keys), 100):
            await self._send({"method": "subscribeTokenTrade", "keys": keys[i:i + 100]})

    async def unsubscribe_trades(self, mints: list[str]) -> None:
        gone = [m for m in mints if m in self.trade_subs]
        if not gone:
            return
        self.trade_subs.difference_update(gone)
        await self._send({"method": "unsubscribeTokenTrade", "keys": gone})

    async def run(self) -> None:
        import websockets

        backoff = 1.0
        while not self._stop.is_set():
            try:
                async with websockets.connect(self.url, ping_interval=20, ping_timeout=20,
                                              max_size=2**22) as ws:
                    self._ws = ws
                    self.connected = True
                    backoff = 1.0
                    log.info("feed tersambung")
                    await ws.send(json.dumps({"method": "subscribeNewToken"}))
                    await ws.send(json.dumps({"method": "subscribeMigration"}))
                    self._pending_subs = list(self.trade_subs)
                    await self.flush_subscriptions()
                    async for raw in ws:
                        now = time.time()
                        self.last_message_at = now
                        try:
                            msg = json.loads(raw)
                        except json.JSONDecodeError:
                            continue
                        if not isinstance(msg, dict):
                            continue
                        text = str(msg.get("message") or "")
                        if "API key" in text and "subscribeTokenTrade" in text:
                            if not self.trade_access_denied:
                                log.error("PumpPortal menolak data trade: %s", text)
                            self.trade_access_denied = True
                            continue
                        kind = str(msg.get("txType") or ("message" if "message" in msg else "lain"))
                        self.msg_types[kind] = self.msg_types.get(kind, 0) + 1
                        if kind not in ("create", "buy", "sell") and self._unknown_logged < 20:
                            self._unknown_logged += 1
                            log.info("pesan feed lain: %s", str(raw)[:300])
                        if self._record_file:
                            self._record_file.write(json.dumps({"t": now, "m": msg}) + "\n")
                        try:
                            await self.handler(msg, now)
                        except Exception:
                            log.exception("handler error")
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("feed putus: %s (reconnect %.0fs)", exc, backoff)
            finally:
                self._ws = None
                self.connected = False
            if self._stop.is_set():
                break
            self.reconnects += 1
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)

    def stop(self) -> None:
        self._stop.set()
        if self._record_file:
            self._record_file.flush()
            self._record_file.close()
            self._record_file = None
