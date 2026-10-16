"""
Koneksi ke PumpPortal (wss://pumpportal.fun/api/data) — HANYA stream gratis:
  - subscribeNewToken   : semua token baru
  - subscribeMigration  : token yang lulus bonding curve

Data trade PumpPortal (subscribeTokenTrade) berbayar 0.01 SOL per 10.000 pesan
dan dipotong dari wallet API key, jadi sengaja TIDAK dipakai dan koneksi ini
tidak pernah mengirim API key. Trade diambil gratis dari on-chain (onchain.py).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Awaitable, Callable

log = logging.getLogger(__name__)

Handler = Callable[[dict, float], Awaitable[None]]
FREE_METHODS = ("subscribeNewToken", "subscribeMigration")


class PumpPortalFeed:
    def __init__(self, url: str, handler: Handler, record_path: str = ""):
        if "api-key" in url.lower():
            raise ValueError("URL PumpPortal tidak boleh berisi api-key (stream berbayar)")
        self.url = url
        self.handler = handler
        self._stop = asyncio.Event()
        self._record_file = open(record_path, "a", encoding="utf-8", buffering=1) if record_path else None
        self.connected = False
        self.last_message_at = 0.0
        self.reconnects = 0
        self.msg_types: dict[str, int] = {}

    async def run(self) -> None:
        import websockets

        backoff = 1.0
        while not self._stop.is_set():
            try:
                async with websockets.connect(self.url, ping_interval=20, ping_timeout=20,
                                              max_size=2**22) as ws:
                    self.connected = True
                    backoff = 1.0
                    log.info("PumpPortal (gratis) tersambung")
                    for method in FREE_METHODS:
                        await ws.send(json.dumps({"method": method}))
                    async for raw in ws:
                        now = time.time()
                        self.last_message_at = now
                        try:
                            msg = json.loads(raw)
                        except json.JSONDecodeError:
                            continue
                        if not isinstance(msg, dict):
                            continue
                        kind = str(msg.get("txType") or ("message" if "message" in msg else "lain"))
                        self.msg_types[kind] = self.msg_types.get(kind, 0) + 1
                        if kind in ("message", "lain"):
                            log.info("PumpPortal: %s", str(raw)[:200])
                            continue
                        if self._record_file:
                            self._record_file.write(json.dumps({"t": now, "m": msg}) + "\n")
                        try:
                            await self.handler(msg, now)
                        except Exception:
                            log.exception("handler error")
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("PumpPortal putus: %s (reconnect %.0fs)", exc, backoff)
            finally:
                self.connected = False
            if self._stop.is_set():
                break
            self.reconnects += 1
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)

    def stop(self) -> None:
        self._stop.set()
        if self._record_file:
            self._record_file.close()
            self._record_file = None
