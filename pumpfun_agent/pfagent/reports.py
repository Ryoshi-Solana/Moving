"""Format teks laporan untuk Telegram (HTML)."""

from __future__ import annotations

import html
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .engine import Agent


def pumpfun_link(mint: str, label: str = "Buka di pump.fun") -> str:
    return f'<a href="https://pump.fun/coin/{mint}">🔗 {label}</a>'


def esc(text) -> str:
    return html.escape(str(text or ""), quote=False)


def pnl_summary(agent: "Agent", since: float) -> dict:
    closed = agent.store.closed_positions(agent.mode, since=since)
    wins = [p for p in closed if (p.pnl_sol or 0) > 0]
    losses = [p for p in closed if (p.pnl_sol or 0) <= 0]
    total = sum(p.pnl_sol or 0 for p in closed)
    gross_win = sum(p.pnl_sol for p in wins)
    gross_loss = -sum(p.pnl_sol or 0 for p in losses)
    return {
        "n": len(closed),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": len(wins) / len(closed) if closed else 0.0,
        "pnl_sol": total,
        "avg_win_pct": sum(p.pnl_pct for p in wins) / len(wins) if wins else 0.0,
        "avg_loss_pct": sum(p.pnl_pct or 0 for p in losses) / len(losses) if losses else 0.0,
        "profit_factor": gross_win / gross_loss if gross_loss > 0 else (float("inf") if gross_win > 0 else 0.0),
        "best": max(closed, key=lambda p: p.pnl_pct or 0, default=None),
        "worst": min(closed, key=lambda p: p.pnl_pct or 0, default=None),
    }


def _fmt_summary(s: dict) -> str:
    if s["n"] == 0:
        return "Belum ada trade yang ditutup."
    pf = "∞" if s["profit_factor"] == float("inf") else f"{s['profit_factor']:.2f}"
    lines = [
        f"Trade: {s['n']} (✅ {s['wins']} / 🔴 {s['losses']}) · win rate {s['win_rate']:.0%}",
        f"PnL: <b>{s['pnl_sol']:+.4f} SOL</b> · profit factor {pf}",
        f"Rata-rata menang {s['avg_win_pct']:+.1f}% · rata-rata kalah {s['avg_loss_pct']:+.1f}%",
    ]
    if s["best"]:
        lines.append(f"Terbaik: {esc(s['best'].symbol)} {s['best'].pnl_pct:+.1f}% · "
                     f"terburuk: {esc(s['worst'].symbol)} {s['worst'].pnl_pct:+.1f}%")
    return "\n".join(lines)


def status_text(agent: "Agent", now: float, feed_connected: bool | None = None) -> str:
    r = agent.risk.state
    eq = agent.equity()
    if not agent.p.trading_enabled:
        state = "🧪 mode lab — trading dimatikan, PUMPY hanya belajar"
    elif r.halted:
        state = f"🛑 BERHENTI ({esc(r.halt_reason)}) — /resume untuk lanjut"
    elif r.paused:
        state = "⏸ dijeda"
    elif r.day_stopped:
        state = "🛑 batas rugi harian, lanjut besok"
    elif now < r.cooldown_until:
        state = f"😮‍💨 cooldown {int((r.cooldown_until - now) / 60)}m lagi"
    else:
        state = "▶️ aktif berburu"
    start = agent.s.paper_start_balance_sol if agent.mode == "paper" else None
    perf = f" ({(eq / start - 1) * 100:+.1f}% dari modal awal)" if start else ""
    uptime = (now - agent.started_at) / 3600 if agent.started_at else 0
    lines = [
        f"<b>PUMPY · status</b> · mode <b>{agent.mode.upper()}</b>"
        + (f" · musim {agent.season_no}" if agent.mode == "paper" else ""),
        f"Kondisi: {state}",
        f"Equity: <b>{eq:.4f} SOL</b>{perf}",
        f"Cash: {agent.cash:.4f} SOL · posisi terbuka: {len(agent.positions)}/{agent.p.max_open_positions}",
        f"Hari ini: realized {r.day_realized_pnl:+.4f} SOL · puncak equity {r.peak_equity:.4f}",
        f"Min skor: {agent.p.min_score:.0f} · SL {agent.p.stop_loss_pct:.0f}% · risk/trade {agent.p.risk_per_trade_pct:.1f}%",
        f"Token dipantau: {len(agent.market.tokens)} · token baru dilihat: {agent.counters['tokens_seen']} · "
        f"kandidat: {agent.counters['candidates']}",
        f"Uptime: {uptime:.1f} jam",
    ]
    if feed_connected is not None:
        lines.append(f"Feed: {'🟢 tersambung' if feed_connected else '🔴 terputus'}")
    lines.append(f"Trade diterima: {agent.counters['trades_seen']}")
    return "\n".join(lines)


def positions_text(agent: "Agent", now: float) -> str:
    if not agent.positions:
        return "Tidak ada posisi terbuka."
    lines = ["<b>Posisi terbuka</b>"]
    for pos in agent.positions.values():
        tok = agent.market.tokens.get(pos.mint)
        price = tok.spot_price() if tok else pos.entry_price
        ref = pos.entry_spot or pos.entry_price
        gain = (price / ref - 1) * 100 if ref else 0
        peak = (pos.peak_price / ref - 1) * 100 if ref else 0
        stop = pos.stop_price or ref * (1 - agent.p.stop_loss_pct / 100)
        lines.append(
            f"\n<b>{esc(pos.symbol)}</b> {gain:+.1f}% (puncak {peak:+.0f}%)\n"
            f"Modal {pos.sol_in:.4f} SOL · nilai ≈ {agent.position_value(pos):.4f} SOL\n"
            f"SL di {(stop / ref - 1) * 100:+.0f}% · TP1 {'✔' if pos.tp1_done else '–'} · "
            f"{(now - pos.opened_at) / 60:.1f}m\n"
            f"<code>{pos.mint}</code>\n{pumpfun_link(pos.mint)}"
        )
    return "\n".join(lines)


def trades_text(agent: "Agent", limit: int = 10) -> str:
    closed = agent.store.closed_positions(agent.mode, limit=limit)
    if not closed:
        return "Belum ada trade yang ditutup."
    lines = [f"<b>{len(closed)} trade terakhir</b>"]
    for p in closed:
        icon = "✅" if (p.pnl_sol or 0) > 0 else "🔴"
        lines.append(f"{icon} {esc(p.symbol)} {p.pnl_pct:+.1f}% ({p.pnl_sol:+.4f}) · {esc(p.exit_reason)}")
    return "\n".join(lines)


def pnl_text(agent: "Agent", now: float) -> str:
    season_start = agent.season_start
    day_start = max(now - 86400, season_start)
    text = (
        f"<b>Musim {agent.season_no} · 24 jam terakhir</b>\n" + _fmt_summary(pnl_summary(agent, day_start)) +
        f"\n\n<b>Musim {agent.season_no} · sejak reset</b>\n" + _fmt_summary(pnl_summary(agent, season_start))
    )
    if season_start > 0:
        text += "\n\n<b>Semua musim</b>\n" + _fmt_summary(pnl_summary(agent, 0))
    return text


def narratives_text(agent: "Agent", now: float) -> str:
    rows = agent.narrative.top(now, 12)
    if not rows:
        return "Belum cukup data narrative (tunggu beberapa menit setelah agent jalan)."
    lines = ["<b>Narrative terpanas (30 menit)</b>"]
    for r in rows:
        bar = "█" * max(1, round(r["heat"] * 10))
        lines.append(f"{bar} <b>{esc(r['keyword'])}</b> · {r['launches_30m']} launch · {r['buy_sol_30m']} SOL beli")
    return "\n".join(lines)


def candidates_text(agent: "Agent") -> str:
    if not agent.last_candidates:
        return "Belum ada token yang lolos filter."
    lines = ["<b>Kandidat terakhir</b> (lolos filter dasar)"]
    for c in agent.last_candidates[:10]:
        lines.append(f"{esc(c['symbol'])} skor {c['score']:.0f} · mcap {c['mcap']:.0f} · "
                     f"{esc(c['narrative'] or '-')} → {esc(c['action'])}")
    top_rej = agent.rejections.most_common(5)
    if top_rej:
        lines.append("\n<b>Alasan penolakan terbanyak</b>")
        lines += [f"• {esc(k)}: {v}" for k, v in top_rej]
    return "\n".join(lines)


def learn_text(agent: "Agent") -> str:
    a = agent.learner.analyze()
    if a["samples"] == 0:
        return "Learner belum punya sinyal yang selesai dievaluasi."
    lines = [
        f"<b>Hasil belajar</b> dari {a['samples']} sinyal",
        f"(menang = sentuh +{agent.p.learn_win_pct:.0f}% sebelum -{agent.p.stop_loss_pct:.0f}%, "
        f"horizon {agent.p.learn_horizon_minutes:.0f}m)",
        f"Win rate {a['win_rate']:.0%} · kalah {a['loss_rate']:.0%} · ekspektasi bersih {a['expectancy_pct']:+.1f}%/sinyal",
        f"(sudah dipotong biaya pulang-pergi ±{agent.learner.round_trip_cost_pct():.1f}%)",
        "",
        "<b>Per rentang skor</b>",
    ]
    for b in a["buckets"]:
        lines.append(f"{b['range']}: n={b['n']} · win {b['win_rate']:.0%} · eksp {b['expectancy_pct']:+.1f}%")
    lines += ["", "<b>Komponen (rata-rata menang vs lainnya → bobot)</b>"]
    for k, c in a["components"].items():
        lines.append(f"{k}: {c['mean_win']:.2f} vs {c['mean_other']:.2f} → {a['weights'][k]:.1f}")
    if a["samples"] < agent.p.learn_min_samples:
        lines.append(f"\nAuto-tune aktif setelah {agent.p.learn_min_samples} sampel.")

    g = agent.learner.grid_analysis()
    lines += ["", f"<b>SL/TP terbaik</b> (skor ≥{g['min_score']:.0f}, n={g['samples']}, bersih setelah biaya)"]
    if g["samples"] == 0:
        lines.append("Belum ada data — butuh ±15 menit per sinyal.")
    else:
        for c in g["cells"][:5]:
            lines.append(f"SL {c['sl']:g}% / TP {c['tp']:g}%: {c['net_pct']:+.1f}%")
        if g["current"]:
            lines.append(f"Setelan sekarang (≈SL {g['current']['sl']:g}/TP {g['current']['tp']:g}): "
                         f"{g['current']['net_pct']:+.1f}%")
        from .learner import GRID_MIN_SAMPLES
        if g["samples"] < GRID_MIN_SAMPLES:
            lines.append(f"Auto-tune SL/TP aktif setelah {GRID_MIN_SAMPLES} sinyal.")
    return "\n".join(lines)


def lab_text(agent: "Agent", analysis: dict | None = None) -> str:
    a = analysis or agent.lab.analyze(agent.learner.round_trip_cost_pct())
    lines = [f"<b>PUMPY · lab strategi</b> (mode bayangan, {a['signals']} sinyal selesai)",
             f"Hasil bersih setelah biaya ±{agent.learner.round_trip_cost_pct():.1f}% · format: entry | filter | SL/TP"]
    if not a["results"]:
        lines.append("Belum cukup data (butuh ≥50 entry per kombinasi; tiap sinyal selesai ±20 menit).")
        return "\n".join(lines)
    b = a["baseline_best"]
    if b:
        lines.append(f"\nPembanding (beli langsung, semua): terbaik {b['net_pct']:+.1f}% di SL/TP {b['exit']} (n={b['n']})")
    lines.append("\n<b>Top 10</b>")
    for r in a["results"][:10]:
        mark = "✅" if r["robust"] else "·"
        lines.append(f"{mark} {r['rule']} | {r['filter']} | {r['exit']}: {r['net_pct']:+.1f}% "
                     f"(n={r['n']}, paruh1 {r['half1']:+.1f} / paruh2 {r['half2']:+.1f})")
    lines.append(f"\nLolos uji ketahanan (✅ n≥100, untung di kedua paruh, >+2%): {len(a['robust'])}")
    return "\n".join(lines)


def params_text(agent: "Agent") -> str:
    lines = ["<b>Parameter</b> (ubah: /set nama nilai)"]
    for k, v in agent.p.to_dict().items():
        lines.append(f"<code>{k}</code> = {v}")
    return "\n".join(lines)


def daily_report(agent: "Agent", now: float) -> str:
    s = pnl_summary(agent, now - 86400)
    narr = agent.narrative.top(now, 5)
    narr_line = ", ".join(esc(r["keyword"]) for r in narr) or "-"
    a = agent.learner.analyze()
    learn_line = (f"{a['samples']} sinyal · ekspektasi {a.get('expectancy_pct', 0):+.1f}%/sinyal"
                  if a["samples"] else "belum ada data")
    return (
        f"📊 <b>PUMPY · laporan harian</b> ({agent.mode})\n"
        f"Equity: <b>{agent.equity():.4f} SOL</b> · posisi terbuka {len(agent.positions)}\n\n"
        f"{_fmt_summary(s)}\n\n"
        f"Narrative panas: {narr_line}\n"
        f"Learner: {learn_line} · min_score {agent.p.min_score:.0f}"
    )
