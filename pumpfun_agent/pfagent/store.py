"""Penyimpanan SQLite: posisi, fill, sinyal (untuk belajar), equity, dan key-value."""

from __future__ import annotations

import json
import os
import sqlite3
from dataclasses import dataclass, field, asdict

SCHEMA = """
CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint TEXT NOT NULL,
    symbol TEXT, name TEXT, mode TEXT NOT NULL,
    status TEXT NOT NULL,
    opened_at REAL NOT NULL, closed_at REAL,
    entry_price REAL NOT NULL,
    tokens_bought REAL NOT NULL, tokens_held REAL NOT NULL,
    sol_in REAL NOT NULL, sol_out REAL NOT NULL DEFAULT 0,
    peak_price REAL NOT NULL, stop_price REAL NOT NULL DEFAULT 0,
    tp1_done INTEGER NOT NULL DEFAULT 0, tp2_done INTEGER NOT NULL DEFAULT 0,
    score REAL, narrative TEXT, features TEXT,
    exit_reason TEXT, pnl_sol REAL, pnl_pct REAL
);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE TABLE IF NOT EXISTS fills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id INTEGER NOT NULL,
    ts REAL NOT NULL, side TEXT NOT NULL,
    sol REAL NOT NULL, tokens REAL NOT NULL, price REAL NOT NULL,
    fee_sol REAL NOT NULL DEFAULT 0, signature TEXT, reason TEXT
);
CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint TEXT NOT NULL, ts REAL NOT NULL,
    score REAL NOT NULL, components TEXT NOT NULL, features TEXT NOT NULL,
    entry_price REAL NOT NULL, bought INTEGER NOT NULL DEFAULT 0,
    max_gain_pct REAL NOT NULL DEFAULT 0, min_gain_pct REAL NOT NULL DEFAULT 0,
    outcome TEXT, resolved_at REAL
);
CREATE INDEX IF NOT EXISTS idx_signals_open ON signals(outcome);
CREATE TABLE IF NOT EXISTS equity (
    ts REAL NOT NULL, equity_sol REAL NOT NULL, cash_sol REAL NOT NULL
);
"""


@dataclass
class Position:
    mint: str
    symbol: str
    name: str
    mode: str
    opened_at: float
    entry_price: float
    tokens_bought: float
    tokens_held: float
    sol_in: float
    peak_price: float
    stop_price: float = 0.0
    sol_out: float = 0.0
    tp1_done: bool = False
    tp2_done: bool = False
    score: float = 0.0
    narrative: str = ""
    features: dict = field(default_factory=dict)
    status: str = "open"
    closed_at: float | None = None
    exit_reason: str = ""
    pnl_sol: float | None = None
    pnl_pct: float | None = None
    entry_spot: float = 0.0   # harga pasar saat masuk (acuan SL/TP); entry_price = biaya efektif termasuk fee
    id: int | None = None

    def unrealized_value(self, price: float) -> float:
        return self.tokens_held * price


class Store:
    def __init__(self, path: str):
        if path != ":memory:":
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self.conn = sqlite3.connect(path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript(SCHEMA)
        self._migrate()
        self.conn.commit()

    def _migrate(self) -> None:
        """Tambah kolom baru ke database lama tanpa menghapus data."""
        wanted = {
            "positions": {"entry_spot": "REAL NOT NULL DEFAULT 0"},
            "signals": {"grid": "TEXT", "lab": "TEXT"},
        }
        for table, cols in wanted.items():
            have = {r["name"] for r in self.conn.execute(f"PRAGMA table_info({table})")}
            for col, ddl in cols.items():
                if col not in have:
                    self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")

    # ---------- kv ----------
    def get(self, key: str, default=None):
        row = self.conn.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    def put(self, key: str, value) -> None:
        self.conn.execute(
            "INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value)),
        )
        self.conn.commit()

    # ---------- positions ----------
    def save_position(self, pos: Position) -> Position:
        data = asdict(pos)
        data["features"] = json.dumps(pos.features)
        data["tp1_done"] = int(pos.tp1_done)
        data["tp2_done"] = int(pos.tp2_done)
        pid = data.pop("id")
        cols = list(data)
        if pid is None:
            cur = self.conn.execute(
                f"INSERT INTO positions({','.join(cols)}) VALUES({','.join('?' * len(cols))})",
                [data[c] for c in cols],
            )
            pos.id = cur.lastrowid
        else:
            self.conn.execute(
                f"UPDATE positions SET {','.join(c + '=?' for c in cols)} WHERE id=?",
                [data[c] for c in cols] + [pid],
            )
        self.conn.commit()
        return pos

    def _row_to_position(self, row) -> Position:
        d = dict(row)
        d["features"] = json.loads(d["features"] or "{}")
        d["tp1_done"] = bool(d["tp1_done"])
        d["tp2_done"] = bool(d["tp2_done"])
        return Position(**d)

    def open_positions(self, mode: str) -> list[Position]:
        rows = self.conn.execute(
            "SELECT * FROM positions WHERE status='open' AND mode=? ORDER BY opened_at", (mode,)
        ).fetchall()
        return [self._row_to_position(r) for r in rows]

    def closed_positions(self, mode: str, since: float = 0, limit: int = 1000) -> list[Position]:
        rows = self.conn.execute(
            "SELECT * FROM positions WHERE status='closed' AND mode=? AND closed_at>=? "
            "ORDER BY closed_at DESC LIMIT ?",
            (mode, since, limit),
        ).fetchall()
        return [self._row_to_position(r) for r in rows]

    def add_fill(self, position_id: int, ts: float, side: str, sol: float, tokens: float,
                 price: float, fee_sol: float, signature: str, reason: str) -> None:
        self.conn.execute(
            "INSERT INTO fills(position_id, ts, side, sol, tokens, price, fee_sol, signature, reason) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (position_id, ts, side, sol, tokens, price, fee_sol, signature, reason),
        )
        self.conn.commit()

    # ---------- signals ----------
    def add_signal(self, mint: str, ts: float, score: float, comps: dict, features: dict,
                   entry_price: float, bought: bool) -> int:
        cur = self.conn.execute(
            "INSERT INTO signals(mint, ts, score, components, features, entry_price, bought) "
            "VALUES(?,?,?,?,?,?,?)",
            (mint, ts, score, json.dumps(comps), json.dumps(features), entry_price, int(bought)),
        )
        self.conn.commit()
        return cur.lastrowid

    def open_signals(self) -> list[sqlite3.Row]:
        return self.conn.execute("SELECT * FROM signals WHERE outcome IS NULL").fetchall()

    def update_signal(self, sid: int, max_gain: float, min_gain: float,
                      outcome: str | None = None, resolved_at: float | None = None) -> None:
        self.conn.execute(
            "UPDATE signals SET max_gain_pct=?, min_gain_pct=?, outcome=?, resolved_at=? WHERE id=?",
            (max_gain, min_gain, outcome, resolved_at, sid),
        )
        self.conn.commit()

    def update_signal_grid(self, sid: int, grid: dict) -> None:
        self.conn.execute("UPDATE signals SET grid=? WHERE id=?", (json.dumps(grid), sid))
        self.conn.commit()

    def update_signal_lab(self, sid: int, lab: dict) -> None:
        self.conn.execute("UPDATE signals SET lab=? WHERE id=?", (json.dumps(lab), sid))
        self.conn.commit()

    def lab_signals(self, limit: int = 40000) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT ts, score, features, lab FROM signals WHERE lab IS NOT NULL ORDER BY ts DESC LIMIT ?",
            (limit,),
        ).fetchall()

    def grid_signals(self, min_score: float, limit: int = 3000) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT score, grid FROM signals WHERE grid IS NOT NULL AND score>=? ORDER BY ts DESC LIMIT ?",
            (min_score, limit),
        ).fetchall()

    def mark_signal_bought(self, sid: int) -> None:
        self.conn.execute("UPDATE signals SET bought=1 WHERE id=?", (sid,))
        self.conn.commit()

    def resolved_signals(self, limit: int = 2000) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT * FROM signals WHERE outcome IS NOT NULL ORDER BY ts DESC LIMIT ?", (limit,)
        ).fetchall()

    # ---------- equity ----------
    def add_equity(self, ts: float, equity: float, cash: float) -> None:
        self.conn.execute("INSERT INTO equity(ts, equity_sol, cash_sol) VALUES(?,?,?)", (ts, equity, cash))
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()
