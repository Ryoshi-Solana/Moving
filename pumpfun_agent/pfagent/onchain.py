"""
Feed trade on-chain gratis: baca event CreateEvent dan TradeEvent pump.fun
langsung dari log transaksi lewat websocket RPC Solana (logsSubscribe), tanpa API
key berbayar. CreateEvent menjadi fallback untuk deteksi token baru saat PumpPortal
tidak tersedia; TradeEvent menyediakan harga/volume untuk token yang dipantau.

Catatan: hanya event bonding curve pump.fun yang terbaca. Setelah token migrasi
ke PumpSwap, trade-nya tidak lewat program ini lagi.
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
from collections import OrderedDict
from typing import Awaitable, Callable

log = logging.getLogger(__name__)

PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
TRADE_EVENT_DISC = hashlib.sha256(b"event:TradeEvent").digest()[:8]
CREATE_EVENT_DISC = hashlib.sha256(b"event:CreateEvent").digest()[:8]
DEFAULT_WS_URLS = ["wss://api.mainnet-beta.solana.com", "wss://solana-rpc.publicnode.com"]
LAMPORTS = 1_000_000_000
TOKEN_UNIT = 1_000_000
TOTAL_SUPPLY = 1_000_000_000.0
SYSTEM_PROGRAM = "11111111111111111111111111111111"
WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112"
SOL_QUOTE_MINTS = {SYSTEM_PROGRAM, WRAPPED_SOL_MINT}
_MIN_TRADE_LEN = 8 + 32 + 8 + 8 + 1 + 32 + 8 + 8 + 8

Handler = Callable[[dict, float], Awaitable[None]]


def _b58(raw: bytes) -> str:
    from solders.pubkey import Pubkey
    return str(Pubkey.from_bytes(raw))


def _read_string(data: bytes, offset: int) -> tuple[str, int]:
    if offset + 4 > len(data):
        raise ValueError("string length truncated")
    length = struct.unpack_from("<I", data, offset)[0]
    offset += 4
    if length > 10_000 or offset + length > len(data):
        raise ValueError("string content truncated")
    return data[offset:offset + length].decode("utf-8"), offset + length


def decode_create_event(data: bytes, signature: str = "") -> dict | None:
    """Decode Pump.fun CreateEvent into the common PumpPortal message shape."""
    if len(data) < 8 or data[:8] != CREATE_EVENT_DISC:
        return None
    try:
        off = 8
        name, off = _read_string(data, off)
        symbol, off = _read_string(data, off)
        uri, off = _read_string(data, off)
        if off + 32 * 4 + 8 * 5 > len(data):
            return None
        mint = _b58(data[off:off + 32]); off += 32
        off += 32  # bonding curve
        user = _b58(data[off:off + 32]); off += 32
        creator = _b58(data[off:off + 32]); off += 32
        timestamp = struct.unpack_from("<q", data, off)[0]; off += 8
        virtual_token_raw, virtual_sol_raw, _real_token_raw, _supply_raw = struct.unpack_from("<QQQQ", data, off)
        off += 32

        # Current IDL appends tokenProgram, two bools, then quoteMint. Older
        # event layouts may end earlier; those are treated as native SOL.
        if off + 32 + 1 + 1 + 32 <= len(data):
            off += 32 + 2
            quote_mint = _b58(data[off:off + 32])
            if quote_mint not in SOL_QUOTE_MINTS:
                return None

        virtual_tokens = virtual_token_raw / TOKEN_UNIT
        virtual_sol = virtual_sol_raw / LAMPORTS
        if virtual_tokens <= 0 or virtual_sol <= 0:
            return None
        return {
            "txType": "create",
            "mint": mint,
            "name": name[:64],
            "symbol": symbol[:24],
            "uri": uri,
            "traderPublicKey": user,
            "creator": creator,
            "createdAt": float(timestamp) if timestamp > 0 else 0.0,
            "initialBuy": 0.0,
            "vSolInBondingCurve": virtual_sol,
            "vTokensInBondingCurve": virtual_tokens,
            "marketCapSol": virtual_sol / virtual_tokens * TOTAL_SUPPLY,
            "signature": signature,
            "pool": "pump",
        }
    except (ValueError, struct.error, UnicodeDecodeError, IndexError):
        return None


def decode_trade_event(data: bytes, signature: str = "") -> dict | None:
    """Ubah bytes TradeEvent jadi pesan ala PumpPortal. None kalau bukan TradeEvent."""
    if len(data) < _MIN_TRADE_LEN or data[:8] != TRADE_EVENT_DISC:
        return None
    off = 8
    mint = _b58(data[off:off + 32]); off += 32
    sol_raw, tok_raw = struct.unpack_from("<QQ", data, off); off += 16
    is_buy = data[off] != 0; off += 1
    user = _b58(data[off:off + 32]); off += 32
    off += 8
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


def events_from_logs(logs: list[str], signature: str = "") -> list[dict]:
    """Decode create/trade events in their original transaction-log order."""
    out = []
    for line in logs or ():
        if not line.startswith("Program data: "):
            continue
        try:
            raw = base64.b64decode(line[14:], validate=False)
        except (binascii.Error, ValueError):
            continue
        event = decode_create_event(raw, signature)
        if event:
            out.append(event)
            continue
        event = decode_trade_event(raw, signature)
        if event:
            out.append(event)
    return out


def trades_from_logs(logs: list[str], signature: str = "") -> list[dict]:
    """Compatibility helper: return only trade events."""
    return [event for event in events_from_logs(logs, signature)
            if event.get("txType") in ("buy", "sell")]


class OnchainTradeFeed:
    """logsSubscribe ke program pump.fun; meneruskan create dan trade token."""

    def __init__(self, urls: list[str], handler: Handler, record_path: str = ""):
        self.urls = [u for u in urls if u] or list(DEFAULT_WS_URLS)
        self.handler = handler
        self.watched: set[str] = set()
        # Semua RPC dipakai BERSAMAAN (RPC publik rutin memutus koneksi tiap 1–4 menit);
        # event yang sama dari dua RPC dibuang lewat signature transaksi.
        self._live: dict[str, bool] = {}
        self.url_msgs: dict[str, int] = {}      # jumlah pesan per RPC (untuk tahu RPC mana yang berguna)
        self._seen: "OrderedDict[str, None]" = OrderedDict()
        self.last_message_at = 0.0
        self.last_trade_at = 0.0
        self.reconnects = 0
        self.stats = {"notifikasi": 0, "trade": 0, "create": 0, "dipakai": 0, "MB": 0.0}
        self.create_fallback = None  # callable: true only while PumpPortal is disconnected
        self._stop = asyncio.Event()
        self._record_file = open(record_path, "a", encoding="utf-8", buffering=1) if record_path else None

    @property
    def connected(self) -> bool:
        return any(self._live.values())

    @property
    def current_url(self) -> str:
        return ",".join(u for u, ok in self._live.items() if ok) or "putus"

    def _is_duplicate(self, signature: str) -> bool:
        if not signature:
            return False
        if signature in self._seen:
            return True
        self._seen[signature] = None
        if len(self._seen) > 200_000:
            for _ in range(20_000):
                self._seen.popitem(last=False)
        return False

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
        except (json.JSONDecodeError, TypeError):
            return
        value = (((msg.get("params") or {}).get("result") or {}).get("value")) if isinstance(msg, dict) else None
        if not value:
            if isinstance(msg, dict) and "error" in msg:
                log.warning("RPC menolak logsSubscribe: %s", msg["error"])
            return
        if self._is_duplicate(value.get("signature", "")):
            return
        self.stats["notifikasi"] += 1
        if value.get("err") is not None:
            return
        events = events_from_logs(value.get("logs") or [], value.get("signature", ""))
        for event in events:
            if event["txType"] == "create":
                self.stats["create"] += 1
                if self.create_fallback is not None and not self.create_fallback():
                    continue
                if self._record_file:
                    self._record_file.write(json.dumps({"t": now, "m": event}) + "\n")
                try:
                    await self.handler(event, now)
                except Exception:
                    log.exception("handler error")
                continue
            self.stats["trade"] += 1
            self.last_trade_at = now
            if event["mint"] not in self.watched:
                continue
            self.stats["dipakai"] += 1
            if self._record_file:
                self._record_file.write(json.dumps({"t": now, "m": event}) + "\n")
            try:
                await self.handler(event, now)
            except Exception:
                log.exception("handler error")

    async def run(self) -> None:
        await asyncio.gather(*(self._worker(url) for url in self.urls))

    async def _worker(self, url: str) -> None:
        import websockets

        name = url.split("?")[0]  # jangan tulis api key ke log
        self._live[name] = False
        self.url_msgs.setdefault(name, 0)
        backoff = 1.0
        while not self._stop.is_set():
            try:
                async with websockets.connect(url, ping_interval=20, ping_timeout=20,
                                              max_size=2**22, open_timeout=15) as ws:
                    await ws.send(json.dumps({
                        "jsonrpc": "2.0", "id": 1, "method": "logsSubscribe",
                        "params": [{"mentions": [PUMP_PROGRAM]}, {"commitment": "processed"}],
                    }))
                    self._live[name] = True
                    backoff = 1.0
                    log.info("feed on-chain tersambung: %s", name)
                    while True:
                        # RPC kadang diam tanpa menutup koneksi → anggap putus
                        raw = await asyncio.wait_for(ws.recv(), timeout=60)
                        self.url_msgs[name] += 1
                        await self._process(raw)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.info("feed on-chain putus (%s): %r", name, exc)
            finally:
                self._live[name] = False
            if self._stop.is_set():
                break
            self.reconnects += 1
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)

    def stop(self) -> None:
        self._stop.set()
        if self._record_file:
            self._record_file.close()
            self._record_file = None
