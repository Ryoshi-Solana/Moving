"""Decoder TradeEvent pump.fun dan feed on-chain — offline, tanpa RPC."""

import asyncio
import base64
import json
import os
import struct
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from solders.keypair import Keypair  # noqa: E402
from solders.pubkey import Pubkey  # noqa: E402

from pfagent.feed import PumpPortalFeed  # noqa: E402
from pfagent.onchain import (CREATE_EVENT_DISC, SYSTEM_PROGRAM, TRADE_EVENT_DISC, OnchainTradeFeed,  # noqa: E402
                             decode_create_event, decode_trade_event, events_from_logs, trades_from_logs)

MINT = Keypair().pubkey()
USER = Keypair().pubkey()


def trade_event(is_buy=True, sol=0.5, tokens=15_000_000.0, v_sol=35.0, v_tok=920_000_000.0, extra=b""):
    data = TRADE_EVENT_DISC + bytes(MINT)
    data += struct.pack("<QQ", int(sol * 1e9), int(tokens * 1e6))
    data += bytes([1 if is_buy else 0]) + bytes(USER)
    data += struct.pack("<q", 1_760_000_000)
    data += struct.pack("<QQQQ", int(v_sol * 1e9), int(v_tok * 1e6), 0, 0)
    return data + extra


def _borsh_string(value):
    raw = value.encode()
    return struct.pack("<I", len(raw)) + raw


def create_event():
    creator = Keypair().pubkey()
    data = CREATE_EVENT_DISC
    data += _borsh_string("Wolf Token") + _borsh_string("WOLF") + _borsh_string("https://example.com/meta.json")
    data += bytes(MINT) + bytes(Keypair().pubkey()) + bytes(USER) + bytes(creator)
    data += struct.pack("<qQQQQ", 1_760_000_000, 1_000_000_000_000_000,
                        30_000_000_000, 793_100_000_000_000, 1_000_000_000_000_000)
    data += bytes(Keypair().pubkey()) + b"\x00\x00"
    data += bytes(Pubkey.from_string(SYSTEM_PROGRAM))
    data += struct.pack("<QQ", 0, 0) + b"\x00"
    return data


def test_decode_create_event_matches_pumpportal_format():
    msg = decode_create_event(create_event(), "SIG_CREATE")
    assert msg is not None
    assert msg["txType"] == "create"
    assert msg["mint"] == str(MINT)
    assert msg["name"] == "Wolf Token"
    assert msg["symbol"] == "WOLF"
    assert msg["traderPublicKey"] == str(USER)
    assert msg["createdAt"] == 1_760_000_000
    assert msg["vSolInBondingCurve"] == pytest.approx(30.0)
    assert msg["vTokensInBondingCurve"] == pytest.approx(1_000_000_000.0)
    assert decode_create_event(b"\x00" * 200) is None


def test_events_from_logs_preserves_create_before_trade_order():
    logs = [
        "Program data: " + base64.b64encode(create_event()).decode(),
        "Program data: " + base64.b64encode(trade_event()).decode(),
    ]
    events = events_from_logs(logs, "SIG")
    assert [e["txType"] for e in events] == ["create", "buy"]


def test_decode_trade_event_matches_pumpportal_format():
    msg = decode_trade_event(trade_event(), "SIG")
    assert msg["txType"] == "buy"
    assert msg["mint"] == str(MINT) and msg["traderPublicKey"] == str(USER)
    assert msg["solAmount"] == pytest.approx(0.5)
    assert msg["tokenAmount"] == pytest.approx(15_000_000.0)
    assert msg["vSolInBondingCurve"] == pytest.approx(35.0)
    assert msg["marketCapSol"] == pytest.approx(35.0 / 920_000_000.0 * 1e9)
    # versi program yang lebih baru menambah field di belakang → tetap terbaca
    assert decode_trade_event(trade_event(is_buy=False, extra=b"\x00" * 120))["txType"] == "sell"


def test_non_trade_data_is_ignored():
    assert decode_trade_event(b"\x00" * 200) is None
    assert decode_trade_event(trade_event()[:50]) is None


def test_trades_from_logs_reads_program_data_lines():
    logs = [
        "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]",
        "Program log: Instruction: Buy",
        "Program data: " + base64.b64encode(trade_event()).decode(),
        "Program data: !!!bukan-base64",
        "Program data: " + base64.b64encode(b"\x01" * 64).decode(),
    ]
    trades = trades_from_logs(logs, "SIG")
    assert len(trades) == 1 and trades[0]["signature"] == "SIG"
    assert base64.b64encode(TRADE_EVENT_DISC).decode().startswith("vdt/007m")


def _notification(logs, err=None):
    return json.dumps({"jsonrpc": "2.0", "method": "logsNotification", "params": {"result": {
        "context": {"slot": 1}, "value": {"signature": "SIG", "err": err, "logs": logs}}}})


def test_onchain_feed_only_forwards_watched_mints():
    got = []

    async def handler(msg, now):
        got.append(msg)

    async def scenario():
        feed = OnchainTradeFeed(["wss://x"], handler)
        line = "Program data: " + base64.b64encode(trade_event()).decode()
        await feed._process(_notification([line]))            # belum dipantau
        await feed.subscribe_trades([str(MINT)])
        await feed._process(_notification([line]))            # dipantau
        await feed._process(_notification([line], err={"x": 1}))  # tx gagal
        await feed.unsubscribe_trades([str(MINT)])
        await feed._process(_notification([line]))
        return feed

    feed = asyncio.run(scenario())
    assert len(got) == 1 and got[0]["mint"] == str(MINT)
    assert feed.stats["trade"] == 3 and feed.stats["dipakai"] == 1


def test_onchain_create_fallback_only_runs_when_enabled():
    got = []

    async def handler(msg, now):
        got.append(msg)

    async def scenario():
        feed = OnchainTradeFeed(["wss://x"], handler)
        line = "Program data: " + base64.b64encode(create_event()).decode()
        feed.create_fallback = lambda: False
        await feed._process(_notification([line]))
        feed.create_fallback = lambda: True
        await feed._process(_notification([line]))
        return feed

    feed = asyncio.run(scenario())
    assert len(got) == 1 and got[0]["txType"] == "create"
    assert feed.stats["create"] == 2


def test_pumpportal_feed_refuses_paid_api_key():
    with pytest.raises(ValueError):
        PumpPortalFeed("wss://pumpportal.fun/api/data?api-key=abc", handler=None)
    PumpPortalFeed("wss://pumpportal.fun/api/data", handler=None)
