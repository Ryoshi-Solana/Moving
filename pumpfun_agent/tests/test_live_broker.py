"""Jalur LiveBroker diuji dengan PumpPortal & RPC tiruan — tidak ada jaringan, tidak ada uang."""

import asyncio
import json
import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from solders.hash import Hash  # noqa: E402
from solders.keypair import Keypair  # noqa: E402
from solders.message import MessageV0  # noqa: E402
from solders.signature import Signature  # noqa: E402
from solders.transaction import VersionedTransaction  # noqa: E402

from pfagent.broker import LiveBroker, OrderError  # noqa: E402
from pfagent.config import Params, Settings  # noqa: E402
from pfagent.market import TokenState  # noqa: E402

MINT = "Mint111111111111111111111111111111111111111"


def make_broker(tx_err=None, token_after=1_000_000.0, sol_change=-0.0521):
    kp = Keypair()
    pub = str(kp.pubkey())
    settings = Settings(mode="live", wallet_private_key=str(kp), rpc_url="https://rpc.test",
                        trade_api_url="https://pp.test/api/trade-local", live_max_position_sol=0.05)
    broker = LiveBroker(settings, Params())
    seen = {"trade_requests": [], "sent": []}

    msg = MessageV0.try_compile(kp.pubkey(), [], [], Hash.default())
    unsigned = VersionedTransaction.populate(msg, [Signature.default()])

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "pp.test":
            seen["trade_requests"].append(dict(httpx.QueryParams(request.content.decode())))
            return httpx.Response(200, content=bytes(unsigned))
        body = json.loads(request.content)
        method = body["method"]
        if method == "sendTransaction":
            raw = body["params"][0]
            seen["sent"].append(raw)
            return httpx.Response(200, json={"result": "SIG123"})
        if method == "getSignatureStatuses":
            return httpx.Response(200, json={"result": {"value": [
                {"err": tx_err, "confirmationStatus": "confirmed"}]}})
        if method == "getTransaction":
            return httpx.Response(200, json={"result": {"meta": {
                "fee": 5000,
                "preBalances": [1_000_000_000], "postBalances": [int(1_000_000_000 + sol_change * 1e9)],
                "preTokenBalances": [],
                "postTokenBalances": [{"mint": MINT, "owner": pub,
                                       "uiTokenAmount": {"uiAmountString": str(token_after)}}],
            }}})
        if method == "getTokenAccountsByOwner":
            return httpx.Response(200, json={"result": {"value": [{"account": {"data": {"parsed": {"info": {
                "tokenAmount": {"uiAmountString": "1000000"}}}}}}]}})
        if method == "getBalance":
            return httpx.Response(200, json={"result": {"value": 2_500_000_000}})
        return httpx.Response(400)

    broker.http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return broker, seen, kp


def test_live_buy_signs_locally_and_reads_real_amounts():
    broker, seen, kp = make_broker()
    fill = asyncio.run(broker.buy(TokenState(mint=MINT), 0.2))
    # ukuran dipotong ke batas keras live
    assert seen["trade_requests"][0]["amount"] == "0.05"
    assert seen["trade_requests"][0]["action"] == "buy"
    assert "privateKey" not in seen["trade_requests"][0]
    import base64
    tx = VersionedTransaction.from_bytes(base64.b64decode(seen["sent"][0]))
    assert tx.signatures[0] != Signature.default()
    assert tx.verify_with_results() == [True]
    assert fill.tokens == pytest.approx(1_000_000.0)
    assert fill.sol == pytest.approx(0.0521)
    assert fill.signature == "SIG123"
    assert asyncio.run(broker.cash_balance()) == pytest.approx(2.5)


def test_live_sell_full_uses_percentage():
    broker, seen, _ = make_broker(token_after=0.0, sol_change=0.07)
    fill = asyncio.run(broker.sell(TokenState(mint=MINT), 1_000_000.0))
    assert seen["trade_requests"][0]["amount"] == "100%"
    assert fill.sol == pytest.approx(0.07)


def test_live_failed_tx_raises():
    broker, _, _ = make_broker(tx_err={"InstructionError": [0, "Custom"]})
    with pytest.raises(OrderError):
        asyncio.run(broker.buy(TokenState(mint=MINT), 0.01))
