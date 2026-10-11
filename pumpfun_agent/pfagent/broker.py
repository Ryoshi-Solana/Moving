"""
Eksekusi order.

PaperBroker : simulasi pakai matematika bonding curve (x*y=k) + fee + slippage
              latensi, supaya hasil paper tidak terlalu optimis.
LiveBroker  : PumpPortal Local Transaction API → tx ditandatangani lokal
              (private key tidak pernah dikirim ke mana pun) → dikirim ke RPC
              kamu sendiri → jumlah sebenarnya dibaca dari transaksi on-chain.
"""

from __future__ import annotations

import asyncio
import base64
import logging
from dataclasses import dataclass

from .config import Params, Settings
from .market import TokenState

log = logging.getLogger(__name__)
LAMPORTS = 1_000_000_000


@dataclass
class Fill:
    tokens: float      # token diterima (buy) atau dijual (sell)
    sol: float         # SOL keluar (buy, termasuk fee) atau masuk bersih (sell)
    price: float       # harga efektif SOL/token
    fee_sol: float
    signature: str = ""


class OrderError(Exception):
    pass


def curve_buy_tokens(v_sol: float, v_tokens: float, sol_in: float) -> float:
    k = v_sol * v_tokens
    return v_tokens - k / (v_sol + sol_in)


def curve_sell_sol(v_sol: float, v_tokens: float, tokens_in: float) -> float:
    k = v_sol * v_tokens
    return v_sol - k / (v_tokens + tokens_in)


class PaperBroker:
    mode = "paper"

    def __init__(self, params: Params, start_balance: float, cash: float | None = None):
        self.p = params
        self.cash = start_balance if cash is None else cash

    async def cash_balance(self) -> float:
        return self.cash

    def _fee_pct(self) -> float:
        return (self.p.pump_fee_pct + self.p.platform_fee_pct) / 100

    async def buy(self, tok: TokenState, sol_amount: float) -> Fill:
        total_cost = sol_amount + self.p.priority_fee_sol
        if total_cost > self.cash + 1e-12:
            raise OrderError("saldo paper tidak cukup")
        fee = sol_amount * self._fee_pct()
        net = sol_amount - fee
        if tok.v_sol > 0 and tok.v_tokens > 0:
            tokens = curve_buy_tokens(tok.v_sol, tok.v_tokens, net)
        elif tok.last_price > 0:
            tokens = net / tok.last_price
        else:
            raise OrderError("harga belum diketahui")
        tokens *= 1 - self.p.paper_latency_slippage_pct / 100
        if tokens <= 0:
            raise OrderError("hasil token 0")
        self.cash -= total_cost
        return Fill(tokens, total_cost, total_cost / tokens, fee + self.p.priority_fee_sol, "paper")

    async def sell(self, tok: TokenState, tokens: float) -> Fill:
        if tokens <= 0:
            raise OrderError("jumlah token 0")
        if tok.v_sol > 0 and tok.v_tokens > 0:
            gross = curve_sell_sol(tok.v_sol, tok.v_tokens, tokens)
        else:
            gross = tokens * tok.last_price
        gross *= 1 - self.p.paper_latency_slippage_pct / 100
        fee = gross * self._fee_pct() + self.p.priority_fee_sol
        net = max(gross - fee, 0.0)
        self.cash += net
        return Fill(tokens, net, net / tokens, fee, "paper")


class LiveBroker:
    mode = "live"

    def __init__(self, settings: Settings, params: Params):
        import httpx
        from solders.keypair import Keypair

        self.s = settings
        self.p = params
        self.keypair = Keypair.from_base58_string(settings.wallet_private_key)
        self.pubkey = str(self.keypair.pubkey())
        self.http = httpx.AsyncClient(timeout=20)

    async def _rpc(self, method: str, params: list):
        resp = await self.http.post(self.s.rpc_url, json={
            "jsonrpc": "2.0", "id": 1, "method": method, "params": params,
        })
        resp.raise_for_status()
        data = resp.json()
        if "error" in data:
            raise OrderError(f"RPC {method}: {data['error']}")
        return data.get("result")

    async def cash_balance(self) -> float:
        res = await self._rpc("getBalance", [self.pubkey, {"commitment": "confirmed"}])
        return res["value"] / LAMPORTS

    async def token_balance(self, mint: str) -> float:
        res = await self._rpc("getTokenAccountsByOwner", [
            self.pubkey, {"mint": mint}, {"encoding": "jsonParsed", "commitment": "confirmed"},
        ])
        total = 0.0
        for acc in res.get("value", []):
            info = acc["account"]["data"]["parsed"]["info"]["tokenAmount"]
            total += float(info.get("uiAmountString") or 0)
        return total

    async def _send(self, action: str, mint: str, amount, denominated_in_sol: bool) -> str:
        from solders.transaction import VersionedTransaction

        resp = await self.http.post(self.s.trade_api_url, data={
            "publicKey": self.pubkey,
            "action": action,
            "mint": mint,
            "amount": amount,
            "denominatedInSol": "true" if denominated_in_sol else "false",
            "slippage": self.p.slippage_pct,
            "priorityFee": self.p.priority_fee_sol,
            "pool": "auto",
        })
        if resp.status_code != 200:
            raise OrderError(f"PumpPortal {resp.status_code}: {resp.text[:200]}")
        unsigned = VersionedTransaction.from_bytes(resp.content)
        signed = VersionedTransaction(unsigned.message, [self.keypair])
        encoded = base64.b64encode(bytes(signed)).decode()
        sig = await self._rpc("sendTransaction", [encoded, {
            "encoding": "base64", "skipPreflight": True, "maxRetries": 3,
        }])
        return sig

    async def _confirm(self, sig: str, timeout: float = 45) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while loop.time() < deadline:
            res = await self._rpc("getSignatureStatuses", [[sig], {"searchTransactionHistory": False}])
            status = (res or {}).get("value", [None])[0]
            if status:
                if status.get("err"):
                    raise OrderError(f"tx gagal on-chain: {status['err']}")
                if status.get("confirmationStatus") in ("confirmed", "finalized"):
                    return
            await asyncio.sleep(1.5)
        raise OrderError(f"tx tidak terkonfirmasi dalam {timeout:.0f}s: {sig}")

    async def _deltas(self, sig: str, mint: str) -> tuple[float, float, float]:
        """(perubahan SOL, perubahan token, fee jaringan) dari sudut pandang wallet kita."""
        for _ in range(10):
            tx = await self._rpc("getTransaction", [sig, {
                "encoding": "json", "maxSupportedTransactionVersion": 0, "commitment": "confirmed",
            }])
            if tx:
                break
            await asyncio.sleep(1.5)
        else:
            raise OrderError("transaksi terkonfirmasi tapi detail belum bisa dibaca")
        meta = tx["meta"]
        sol_delta = (meta["postBalances"][0] - meta["preBalances"][0]) / LAMPORTS

        def owned(balances):
            return sum(
                float(b["uiTokenAmount"].get("uiAmountString") or 0)
                for b in balances or []
                if b.get("mint") == mint and b.get("owner") == self.pubkey
            )

        tok_delta = owned(meta.get("postTokenBalances")) - owned(meta.get("preTokenBalances"))
        return sol_delta, tok_delta, meta.get("fee", 0) / LAMPORTS

    async def buy(self, tok: TokenState, sol_amount: float) -> Fill:
        sol_amount = min(sol_amount, self.s.live_max_position_sol)
        sig = await self._send("buy", tok.mint, sol_amount, True)
        await self._confirm(sig)
        sol_delta, tok_delta, fee = await self._deltas(sig, tok.mint)
        if tok_delta <= 0:
            raise OrderError(f"buy terkonfirmasi tapi token tidak bertambah: {sig}")
        spent = -sol_delta
        return Fill(tok_delta, spent, spent / tok_delta, fee, sig)

    async def sell(self, tok: TokenState, tokens: float) -> Fill:
        held = await self.token_balance(tok.mint)
        if held <= 0:
            raise OrderError("tidak ada token di wallet")
        full_exit = tokens >= held * 0.999
        amount = "100%" if full_exit else round(min(tokens, held), 6)
        sig = await self._send("sell", tok.mint, amount, False)
        await self._confirm(sig)
        sol_delta, tok_delta, fee = await self._deltas(sig, tok.mint)
        sold = -tok_delta if tok_delta < 0 else tokens
        return Fill(sold, max(sol_delta, 0.0), max(sol_delta, 0.0) / sold if sold else 0, fee, sig)

    async def close(self) -> None:
        await self.http.aclose()
