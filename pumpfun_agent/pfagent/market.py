"""
Pelacak market: menyimpan state tiap token dari stream PumpPortal dan
menghitung fitur momentum yang dipakai strategi.

Format pesan PumpPortal (yang kita pakai, semua opsional & dibaca defensif):
  create : mint, name, symbol, uri, traderPublicKey, initialBuy, solAmount,
           vSolInBondingCurve, vTokensInBondingCurve, marketCapSol
  buy/sell: mint, txType, traderPublicKey, solAmount, tokenAmount, newTokenBalance,
           vSolInBondingCurve, vTokensInBondingCurve, marketCapSol, pool
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

TOTAL_SUPPLY = 1_000_000_000.0  # supply standar token pump.fun (unit UI)


def _f(msg: dict, key: str, default: float = 0.0) -> float:
    try:
        value = msg.get(key)
        return float(value) if value is not None else default
    except (TypeError, ValueError):
        return default


@dataclass
class Trade:
    ts: float
    side: str  # "buy" | "sell"
    sol: float
    tokens: float
    trader: str
    price: float
    mcap_sol: float


@dataclass
class Features:
    age_sec: float = 0.0
    mcap_sol: float = 0.0
    price: float = 0.0
    buy_vol_1m: float = 0.0
    sell_vol_1m: float = 0.0
    buy_vol_2m: float = 0.0
    buy_vol_5m: float = 0.0
    sell_vol_5m: float = 0.0
    n_trades_1m: int = 0
    n_trades_5m: int = 0
    unique_buyers_5m: int = 0
    buy_ratio_1m: float = 0.5
    mcap_change_1m_pct: float = 0.0
    mcap_change_5m_pct: float = 0.0
    trade_accel: float = 1.0          # laju trade 1m dibanding rata-rata per menit 5m
    top_buyer_share_5m: float = 0.0   # porsi volume beli dari 1 wallet terbesar
    dev_sold_pct: float = 0.0
    top10_holder_pct: float = 0.0
    drawdown_from_ath_pct: float = 0.0
    has_socials: bool = False
    migrated: bool = False

    def as_dict(self) -> dict:
        return dict(self.__dict__)


@dataclass
class TokenState:
    mint: str
    name: str = ""
    symbol: str = ""
    uri: str = ""
    creator: str = ""
    created_at: float = 0.0
    dev_tokens: float = 0.0
    dev_sold_tokens: float = 0.0
    v_sol: float = 0.0
    v_tokens: float = 0.0
    last_price: float = 0.0
    last_mcap_sol: float = 0.0
    ath_mcap_sol: float = 0.0
    last_trade_at: float = 0.0
    migrated: bool = False
    has_socials: bool = False
    metadata_checked: bool = False
    description: str = ""
    trades: deque = field(default_factory=lambda: deque(maxlen=4000))
    balances: dict = field(default_factory=dict)

    def spot_price(self) -> float:
        if self.v_sol > 0 and self.v_tokens > 0:
            return self.v_sol / self.v_tokens
        return self.last_price


class MarketTracker:
    """Menyimpan semua token yang sedang dipantau."""

    def __init__(self, max_tokens: int = 400):
        self.tokens: dict[str, TokenState] = {}
        self.max_tokens = max_tokens

    # ---------- ingest ----------

    def on_create(self, msg: dict, now: float) -> TokenState | None:
        mint = msg.get("mint")
        if not mint:
            return None
        tok = self.tokens.get(mint) or TokenState(mint=mint)
        tok.name = str(msg.get("name") or "")[:64]
        tok.symbol = str(msg.get("symbol") or "")[:24]
        tok.uri = str(msg.get("uri") or "")
        tok.creator = str(msg.get("traderPublicKey") or "")
        tok.created_at = now
        tok.dev_tokens = _f(msg, "initialBuy")
        tok.v_sol = _f(msg, "vSolInBondingCurve")
        tok.v_tokens = _f(msg, "vTokensInBondingCurve")
        tok.last_mcap_sol = _f(msg, "marketCapSol")
        tok.ath_mcap_sol = tok.last_mcap_sol
        tok.last_price = tok.spot_price()
        tok.last_trade_at = now
        if tok.creator and tok.dev_tokens > 0:
            tok.balances[tok.creator] = tok.dev_tokens
        self.tokens[mint] = tok
        return tok

    def on_trade(self, msg: dict, now: float) -> TokenState | None:
        mint = msg.get("mint")
        side = msg.get("txType")
        if not mint or side not in ("buy", "sell"):
            return None
        tok = self.tokens.get(mint)
        if tok is None:
            # token yang kita lihat di tengah jalan (mis. setelah restart)
            tok = TokenState(mint=mint, created_at=now)
            self.tokens[mint] = tok

        sol = _f(msg, "solAmount")
        tokens = _f(msg, "tokenAmount")
        trader = str(msg.get("traderPublicKey") or "")

        v_sol = _f(msg, "vSolInBondingCurve")
        v_tok = _f(msg, "vTokensInBondingCurve")
        if v_sol > 0 and v_tok > 0:
            tok.v_sol, tok.v_tokens = v_sol, v_tok
            price = v_sol / v_tok
        elif tokens > 0:
            # setelah migrasi ke AMM, reserve curve tidak lagi dikirim
            tok.v_sol = tok.v_tokens = 0.0
            price = sol / tokens
        else:
            price = tok.last_price

        mcap = _f(msg, "marketCapSol") or price * TOTAL_SUPPLY
        pool = str(msg.get("pool") or "pump")
        if pool not in ("pump", ""):
            tok.migrated = True

        tok.last_price = price
        tok.last_mcap_sol = mcap
        tok.ath_mcap_sol = max(tok.ath_mcap_sol, mcap)
        tok.last_trade_at = now
        tok.trades.append(Trade(now, side, sol, tokens, trader, price, mcap))

        if "newTokenBalance" in msg:
            tok.balances[trader] = max(_f(msg, "newTokenBalance"), 0.0)
        else:
            delta = tokens if side == "buy" else -tokens
            tok.balances[trader] = max(tok.balances.get(trader, 0.0) + delta, 0.0)

        if trader and trader == tok.creator and side == "sell":
            tok.dev_sold_tokens += tokens
        return tok

    def on_migration(self, msg: dict) -> None:
        tok = self.tokens.get(msg.get("mint", ""))
        if tok:
            tok.migrated = True

    # ---------- fitur ----------

    def features(self, mint: str, now: float) -> Features | None:
        tok = self.tokens.get(mint)
        if tok is None:
            return None
        f = Features(
            age_sec=max(now - tok.created_at, 0.0),
            mcap_sol=tok.last_mcap_sol,
            price=tok.last_price,
            has_socials=tok.has_socials,
            migrated=tok.migrated,
        )

        mcap_1m_ago = mcap_5m_ago = None
        buyer_vol: dict[str, float] = {}
        buyers = set()
        for t in reversed(tok.trades):
            age = now - t.ts
            if age > 300:
                mcap_5m_ago = t.mcap_sol
                break
            mcap_5m_ago = t.mcap_sol
            f.n_trades_5m += 1
            if t.side == "buy":
                f.buy_vol_5m += t.sol
                buyers.add(t.trader)
                buyer_vol[t.trader] = buyer_vol.get(t.trader, 0.0) + t.sol
                if age <= 120:
                    f.buy_vol_2m += t.sol
            else:
                f.sell_vol_5m += t.sol
            if age <= 60:
                f.n_trades_1m += 1
                mcap_1m_ago = t.mcap_sol
                if t.side == "buy":
                    f.buy_vol_1m += t.sol
                else:
                    f.sell_vol_1m += t.sol

        f.unique_buyers_5m = len(buyers)
        total_1m = f.buy_vol_1m + f.sell_vol_1m
        f.buy_ratio_1m = f.buy_vol_1m / total_1m if total_1m > 0 else 0.5
        if mcap_1m_ago:
            f.mcap_change_1m_pct = (tok.last_mcap_sol / mcap_1m_ago - 1) * 100
        if mcap_5m_ago:
            f.mcap_change_5m_pct = (tok.last_mcap_sol / mcap_5m_ago - 1) * 100

        window_min = min(max(f.age_sec, 60.0), 300.0) / 60.0
        avg_per_min = f.n_trades_5m / window_min if window_min else 0
        f.trade_accel = f.n_trades_1m / avg_per_min if avg_per_min > 0 else 1.0

        if f.buy_vol_5m > 0 and buyer_vol:
            f.top_buyer_share_5m = max(buyer_vol.values()) / f.buy_vol_5m
        if tok.dev_tokens > 0:
            f.dev_sold_pct = min(tok.dev_sold_tokens / tok.dev_tokens * 100, 100.0)
        if tok.ath_mcap_sol > 0:
            f.drawdown_from_ath_pct = (1 - tok.last_mcap_sol / tok.ath_mcap_sol) * 100

        # Holder terbesar selain bonding curve (curve tidak pernah muncul sebagai trader)
        top = sorted(tok.balances.values(), reverse=True)[:10]
        f.top10_holder_pct = sum(top) / TOTAL_SUPPLY * 100
        return f

    # ---------- housekeeping ----------

    def prune(self, now: float, keep: set[str], max_age_sec: float, idle_sec: float = 600) -> list[str]:
        """Buang token tua/sepi supaya memori & subscription tetap kecil."""
        removed = []
        for mint, tok in list(self.tokens.items()):
            if mint in keep:
                continue
            too_old = now - tok.created_at > max_age_sec
            idle = now - tok.last_trade_at > idle_sec
            if too_old or idle:
                removed.append(mint)
        # kalau masih terlalu banyak, buang yang paling sepi
        remaining = [m for m in self.tokens if m not in removed and m not in keep]
        overflow = len(remaining) - self.max_tokens
        if overflow > 0:
            remaining.sort(key=lambda m: self.tokens[m].last_trade_at)
            removed.extend(remaining[:overflow])
        for mint in removed:
            self.tokens.pop(mint, None)
        return removed
