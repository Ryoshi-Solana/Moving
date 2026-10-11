"""
Pelacak narrative.

Ide dasarnya: di pump.fun narrative kelihatan dari dua hal
  1. supply  — berapa banyak token baru yang diluncurkan dengan tema yang sama
  2. demand  — berapa banyak SOL yang masuk ke token-token bertema itu

Setiap nama/simbol token dipecah jadi kata kunci. Untuk tiap kata kunci kita
hitung peluncuran & volume beli dalam jendela pendek (30 menit) dibanding
baseline (3 jam). Narrative "panas" = yang sedang naik, bukan yang sekadar besar.
"""

from __future__ import annotations

import math
import re
from collections import defaultdict, deque

STOPWORDS = {
    "the", "and", "for", "you", "coin", "token", "inu", "sol", "solana", "pump",
    "fun", "official", "of", "on", "in", "to", "a", "is", "it", "my", "with",
    "this", "that", "new", "first", "real", "just", "not", "are", "was", "be",
}

SHORT_WINDOW = 30 * 60
LONG_WINDOW = 3 * 60 * 60


def keywords(*texts: str) -> set[str]:
    words: set[str] = set()
    for text in texts:
        if not text:
            continue
        # pecah camelCase dulu: "TrumpCat" → "Trump Cat"
        text = re.sub(r"([a-z])([A-Z])", r"\1 \2", text)
        for w in re.findall(r"[a-zA-Z0-9]+", text.lower()):
            if len(w) >= 3 and w not in STOPWORDS and not w.isdigit():
                words.add(w)
    return words


class NarrativeTracker:
    def __init__(self):
        self.launches: dict[str, deque] = defaultdict(deque)  # kw -> timestamps
        self.volume: dict[str, deque] = defaultdict(deque)    # kw -> (ts, sol)
        self.token_kws: dict[str, set[str]] = {}
        self._all_launches: deque = deque()
        self._all_volume: deque = deque()
        self._total_cache: tuple[int, float] = (-1, 0.0)

    def on_launch(self, mint: str, name: str, symbol: str, now: float, description: str = "") -> None:
        kws = keywords(name, symbol)
        self.token_kws[mint] = kws
        for kw in kws:
            self.launches[kw].append(now)
        self._all_launches.append(now)

    def add_description(self, mint: str, description: str) -> None:
        extra = keywords(description) - self.token_kws.get(mint, set())
        # deskripsi cuma menambah konteks, tidak dihitung sebagai peluncuran baru
        self.token_kws.setdefault(mint, set()).update(list(extra)[:5])

    def on_buy(self, mint: str, sol: float, now: float) -> None:
        for kw in self.token_kws.get(mint, ()):
            self.volume[kw].append((now, sol))
        self._all_volume.append((now, sol))

    def forget(self, mint: str) -> None:
        self.token_kws.pop(mint, None)

    def _trim(self, now: float) -> None:
        cutoff = now - LONG_WINDOW
        for dq in (self._all_launches,):
            while dq and dq[0] < cutoff:
                dq.popleft()
        while self._all_volume and self._all_volume[0][0] < cutoff:
            self._all_volume.popleft()
        for kw in list(self.launches):
            dq = self.launches[kw]
            while dq and dq[0] < cutoff:
                dq.popleft()
            if not dq and not self.volume.get(kw):
                del self.launches[kw]
        for kw in list(self.volume):
            dq = self.volume[kw]
            while dq and dq[0][0] < cutoff:
                dq.popleft()
            if not dq:
                del self.volume[kw]

    def _total_short_volume(self, now: float) -> float:
        bucket = int(now // 5)
        if self._total_cache[0] != bucket:
            total = sum(s for t, s in self._all_volume if now - t <= SHORT_WINDOW)
            self._total_cache = (bucket, total)
        return self._total_cache[1]

    def heat(self, kw: str, now: float) -> float:
        """Skor 0..1 seberapa panas satu kata kunci sekarang."""
        launches = self.launches.get(kw, ())
        vols = self.volume.get(kw, ())
        short_l = sum(1 for t in launches if now - t <= SHORT_WINDOW)
        long_l = len(launches)
        short_v = sum(s for t, s in vols if now - t <= SHORT_WINDOW)
        total_short_v = self._total_short_volume(now)

        if short_l < 2 and short_v < 1:
            return 0.0
        # akselerasi peluncuran: laju 30m vs laju 3 jam (baseline +1 supaya stabil)
        expected = (long_l / (LONG_WINDOW / SHORT_WINDOW)) + 1
        accel = short_l / expected
        accel_score = min(math.log1p(accel) / math.log1p(4), 1.0)
        # porsi volume: berapa % dari seluruh uang beli 30m masuk ke tema ini
        share = short_v / total_short_v if total_short_v > 0 else 0.0
        share_score = min(share / 0.10, 1.0)  # 10% volume pasar = maksimal
        breadth = min(short_l / 5, 1.0)       # minimal beberapa token = narrative, bukan 1 coin
        return round(0.4 * accel_score + 0.4 * share_score + 0.2 * breadth, 4)

    def token_score(self, mint: str, now: float) -> tuple[float, str]:
        kws = self.token_kws.get(mint, set())
        best, best_kw = 0.0, ""
        for kw in kws:
            h = self.heat(kw, now)
            if h > best:
                best, best_kw = h, kw
        return best, best_kw

    def top(self, now: float, n: int = 10) -> list[dict]:
        self._trim(now)
        rows = []
        for kw in set(self.launches) | set(self.volume):
            h = self.heat(kw, now)
            if h <= 0:
                continue
            rows.append({
                "keyword": kw,
                "heat": h,
                "launches_30m": sum(1 for t in self.launches.get(kw, ()) if now - t <= SHORT_WINDOW),
                "buy_sol_30m": round(sum(s for t, s in self.volume.get(kw, ()) if now - t <= SHORT_WINDOW), 2),
            })
        rows.sort(key=lambda r: r["heat"], reverse=True)
        return rows[:n]

    def maintenance(self, now: float) -> None:
        self._trim(now)
