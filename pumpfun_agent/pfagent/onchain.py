"""
Feed trade on-chain gratis: baca event TradeEvent pump.fun langsung dari log
transaksi lewat websocket RPC Solana (logsSubscribe), tanpa API key berbayar.

Setiap buy/sell di bonding curve pump.fun menulis log
    "Program data: <base64 TradeEvent>"
yang berisi mint, jumlah SOL & token, buy/sell, wallet trader, dan reserve
virtual curve sesudah trade. Event diubah ke format pesan yang sama dengan
PumpPortal, jadi engine tidak perlu tahu sumber datanya.

Catatan: hanya trade di bonding curve pump.fun yang terbaca. Setelah token
migrasi ke PumpSwap, trade-nya tidak lewat program ini lagi.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import logging
import struct
import time
from typing import Awaitable, Callable

log = logging.getLogger(__name__)

PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
TRADE_EVENT_DISC = hashlib.sha256(b"event:TradeEvent").digest()[:8]
DEFAULT_WS_URLS = ["wss://api.mainnet-beta.solana.com", "wss://solana-rpc.publicnode.com"]
LAMPORTS = 1_000_000_000
TOKEN_UNIT = 1_000_000          # token pump.fun pakai 6 desimal
TOTAL_SUPPLY = 1_000_000_000.0
_MIN_LEN = 8 + 32 + 8 + 8 + 1 + 32 + 8 + 8 + 8

Handler = Callable[[dict, float], Awaitable[None]]


def _b58(raw: bytes) -> str:
    from solders.pubkey import Pubkey
    return str(Pubkey.from_bytes(raw))


def decode_trade_event(data: bytes, signature: str = "") -> dict | None:
    """Ubah bytes TradeEvent jadi pesan ala PumpPortal. None kalau bukan TradeEvent."""
    if len(data) < _MIN_LEN or data[:8] != TRADE_EVENT_DISC:
        return None
    off = 8
    mint = _b58(data[off:off + 32]); off += 32
    sol_raw, tok_raw = struct.unpack_from("<QQ", data, off); off += 16
    is_buy = data[off] != 0; off += 1
    user = _b58(data[off:off + 32]); off += 32
    off += 8  # timestamp
    v_sol_raw, v_tok_raw = struct.unpack_from("<QQ", data, off)
    v_sol = v_sol_raw / LAMPORTS
    v_tok = v_tok_raw / TOKEN_UNIT
    if v_tok <= 0:
        return None
    return {
        "txType": "buy" if is_buy else "sell",
        "mint": mint,
        "traderPublicKey": user,
        "solAmount": sol_raw / LAMPORTS,
        "tokenAmount": tok_raw / TOKEN_UNIT,
        "vSolInBondingCurve": v_sol,
        "vTokensInBondingCurve": v_tok,
        "marketCapSol": v_sol / v_tok * TOTAL_SUPPLY,
        "pool": "pump",
        "signature": signature,
    }


def trades_from_logs(logs: list[str], signature: str = "") -> list[dict]:
    out = []
    for line in logs or ():
        if not line.startswith("Program data: "):
            continue
        try:
            raw = base64.b64decode(line[14:], validate=False)
        except (binascii.Error, ValueError):
            continue
        msg = decode_trade_event(raw, signature)
        if msg:
            out.append(msg)
    return out


class OnchainTradeFeed:
    """logsSubscribe ke program pump.fun; hanya meneruskan trade untuk mint yang dipantau."""

    def __init__(self, urls: list[str], handler: Handler, record_path: str = ""):
        self.urls = [u for u in urls if u] or list(DEFAULT_WS_URLS)
        self.handler = handler
        self.watched: set[str] = set()
        self.connected = False
        self.current_url = ""
        self.last_message_at = 0.0
        self.last_trade_at = 0.0
        self.reconnects = 0
        self.stats = {"notifikasi": 0, "trade": 0, "dipakai": 0, "MB": 0.0}
        self._stop = asyncio.Event()
        self._ws = None
        self._record_file = open(record_path, "a", encoding="utf-8", buffering=1) if record_path else None

    # antarmuka yang sama dengan PumpPortalFeed, tapi tanpa panggilan jaringan
    async def subscribe_trades(self, mints: list[str]) -> None:
        self.watched.update(mints)

    async def unsubscribe_trades(self, mints: list[str]) -> None:
        self.watched.difference_update(mints)

    async def _process(self, raw: str | bytes) -> None:
        now = time.time()
        self.last_message_at = now
        self.stats["MB"] += len(raw) / 1_000_000
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            return
        value = (((msg.get("params") or {}).get("result") or {}).get("value")) if isinstance(msg, dict) else None
        if not value:
            if isinstance(msg, dict) and "error" in msg:
                log.warning("RPC menolak logsSubscribe: %s", msg["error"])
            return
        self.stats["notifikasi"] += 1
        if value.get("err") is not None:
            return  # transaksi gagal: tidak ada trade yang benar-benar terjadi
        for trade in trades_from_logs(value.get("logs") or [], value.get("signature", "")):
            self.stats["trade"] += 1
            self.last_trade_at = now
            if trade["mint"] not in self.watched:
                continue
            self.stats["dipakai"] += 1
            if self._record_file:
                self._record_file.write(json.dumps({"t": now, "m": trade}) + "\n")
            try:
                await self.handler(trade, now)
            except Exception:
                log.exception("handler error")

    async def run(self) -> None:
        import websockets

        backoff = 1.0
        idx = 0
        while not self._stop.is_set():
            url = self.urls[idx % len(self.urls)]
            self.current_url = url.split("?")[0]  # jangan log api key kalau ada
            try:
                async with websockets.connect(url, ping_interval=20, ping_timeout=20,
                                              max_size=2**22, open_timeout=15) as ws:
                    self._ws = ws
                    await ws.send(json.dumps({
                        "jsonrpc": "2.0", "id": 1, "method": "logsSubscribe",
                        "params": [{"mentions": [PUMP_PROGRAM]}, {"commitment": "processed"}],
                    }))
                    self.connected = True
                    backoff = 1.0
                    log.info("feed on-chain tersambung: %s", self.current_url)
                    connected_at = time.time()
                    while True:
                        raw = await asyncio.wait_for(ws.recv(), timeout=60)
                        await self._process(raw)
                        # tersambung tapi tidak ada trade sama sekali → pindah RPC
                        if time.time() - max(self.last_trade_at, connected_at) > 90:
                            raise RuntimeError("tidak ada trade pump.fun >90 detik")
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("feed on-chain putus (%s): %s", self.current_url, exc)
            finally:
                self._ws = None
                self.connected = False
            if self._stop.is_set():
                break
            self.reconnects += 1
            idx += 1  # coba RPC berikutnya
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)

    def stop(self) -> None:
        self._stop.set()
        if self._record_file:
            self._record_file.close()
            self._record_file = None
