"""Simulator bonding curve sederhana untuk menghasilkan pesan ala PumpPortal."""

from __future__ import annotations

import itertools

INITIAL_V_SOL = 30.0
INITIAL_V_TOKENS = 1_073_000_191.0
SUPPLY = 1_000_000_000.0

_wallets = itertools.count()


def wallet() -> str:
    return f"W{next(_wallets):040d}"


class SimToken:
    def __init__(self, mint: str, name: str, symbol: str, dev: str | None = None, dev_buy_sol: float = 1.0):
        self.mint, self.name, self.symbol = mint, name, symbol
        self.dev = dev or wallet()
        self.v_sol, self.v_tok = INITIAL_V_SOL, INITIAL_V_TOKENS
        self.balances: dict[str, float] = {}
        self.dev_buy_sol = dev_buy_sol

    def _fields(self) -> dict:
        price = self.v_sol / self.v_tok
        return {
            "vSolInBondingCurve": self.v_sol,
            "vTokensInBondingCurve": self.v_tok,
            "marketCapSol": price * SUPPLY,
            "pool": "pump",
        }

    def create(self) -> dict:
        tokens = self._apply_buy(self.dev_buy_sol)
        self.balances[self.dev] = tokens
        return {"txType": "create", "mint": self.mint, "name": self.name, "symbol": self.symbol,
                "uri": "", "traderPublicKey": self.dev, "initialBuy": tokens,
                "solAmount": self.dev_buy_sol, **self._fields()}

    def _apply_buy(self, sol: float) -> float:
        k = self.v_sol * self.v_tok
        new_tok = k / (self.v_sol + sol)
        out = self.v_tok - new_tok
        self.v_sol += sol
        self.v_tok = new_tok
        return out

    def buy(self, trader: str, sol: float) -> dict:
        tokens = self._apply_buy(sol)
        self.balances[trader] = self.balances.get(trader, 0.0) + tokens
        return {"txType": "buy", "mint": self.mint, "traderPublicKey": trader, "solAmount": sol,
                "tokenAmount": tokens, "newTokenBalance": self.balances[trader], **self._fields()}

    def sell(self, trader: str, tokens: float) -> dict:
        tokens = min(tokens, self.balances.get(trader, 0.0))
        k = self.v_sol * self.v_tok
        new_sol = k / (self.v_tok + tokens)
        sol = self.v_sol - new_sol
        self.v_sol, self.v_tok = new_sol, self.v_tok + tokens
        self.balances[trader] = self.balances.get(trader, 0.0) - tokens
        return {"txType": "sell", "mint": self.mint, "traderPublicKey": trader, "solAmount": sol,
                "tokenAmount": tokens, "newTokenBalance": self.balances[trader], **self._fields()}


def pump_then(phase: str, t0: float = 1_000_000.0, mint: str = "MintPump1111111111111111111111111111111111",
              name: str = "Cat Wizard", symbol: str = "CATWIZ"):
    """
    Hasilkan list (t, msg): token diluncurkan, dipompa banyak wallet, lalu
    phase = "dump" (dev & whale buang) atau "moon" (terus naik).
    """
    tok = SimToken(mint, name, symbol)
    events = [(t0, tok.create())]
    t = t0
    buyers = [wallet() for _ in range(60)]
    # akumulasi organik: banyak wallet, ukuran kecil-menengah
    for i in range(35 if phase == "dump" else 90):
        t += 2
        events.append((t, tok.buy(buyers[i % len(buyers)], 0.25 + (i % 5) * 0.05)))
        if i % 9 == 4:
            events.append((t + 0.5, tok.sell(buyers[(i + 7) % len(buyers)], tok.balances.get(buyers[(i + 7) % len(buyers)], 0) * 0.3)))
    if phase == "dump":
        for b in buyers[:30]:
            t += 1
            events.append((t, tok.sell(b, tok.balances.get(b, 0.0))))
        t += 1
        events.append((t, tok.sell(tok.dev, tok.balances[tok.dev])))
        for _ in range(30):
            t += 10
            events.append((t, tok.buy(wallet(), 0.01)))
    else:
        for i in range(250):
            t += 2
            events.append((t, tok.buy(wallet(), 0.6 + (i % 4) * 0.1)))
        # setelah puncak, profit taking besar
        for b in buyers:
            t += 1
            events.append((t, tok.sell(b, tok.balances.get(b, 0.0))))
        for _ in range(60):
            t += 5
            events.append((t, tok.buy(wallet(), 0.02)))
    return events
