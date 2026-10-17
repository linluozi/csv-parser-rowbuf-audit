#!/usr/bin/env python
"""Generate the figures in charts/ from results/*.json.

Two rules followed here (both learned the hard way):

1. Plot *ratios*, never absolute milliseconds. Absolute wall-clock drifts
   across cases inside a single process, so a millisecond axis produces
   curves whose shape is measurement artefact.
2. Never plot a single-round extreme. Noise bands are p10-p90 of the
   per-round ratio; a single round can swing 20%.

Run with the interpreter that has matplotlib installed:
    python audit/make_figures.py
"""
from __future__ import annotations

import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "results"
OUT = ROOT / "charts"
OUT.mkdir(exist_ok=True)

# Warm editorial palette: espresso brown / amber gold / terracotta.
INK = "#2b2119"
PAPER = "#faf6f0"
AMBER = "#c8892b"
TERRACOTTA = "#b4552f"
OLIVE = "#6b6b3a"
MUTED = "#8a7a68"

plt.rcParams.update({
    "figure.facecolor": PAPER,
    "axes.facecolor": PAPER,
    "axes.edgecolor": INK,
    "axes.labelcolor": INK,
    "text.color": INK,
    "xtick.color": INK,
    "ytick.color": INK,
    "font.size": 10,
    "axes.grid": True,
    "grid.color": "#ddd2c4",
    "grid.linewidth": 0.6,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "font.family": ["Microsoft YaHei", "Noto Sans SC", "DejaVu Sans"],
    "axes.unicode_minus": False,
})

load = lambda name: json.loads((RES / name).read_text(encoding="utf-8"))


def fig_copy_amplification() -> None:
    """How many times the input gets copied through Buffer.concat.

    Log x-axis is mandatory here: the whole point is a 256x -> 1x collapse,
    and on a linear axis the optimized bar has zero visible width.
    """
    rows = load("concat.json")
    labels = [r["name"] for r in rows]
    up = [r["impls"]["upstream"]["copyAmplification"] for r in rows]
    op = [max(r["impls"]["optimized"]["copyAmplification"], 0.01) for r in rows]

    y = np.arange(len(rows))
    h = 0.34
    fig, ax = plt.subplots(figsize=(8.8, 4.4))
    ax.barh(y - h / 2, up, h, color=TERRACOTTA, label="upstream（重复 Buffer.concat）")
    ax.barh(y + h / 2, op, h, color=OLIVE, label="optimized（碎片列表）")
    ax.set_yticks(y)
    ax.set_yticklabels(labels, fontsize=9)
    ax.invert_yaxis()
    ax.set_xscale("log")
    ax.set_xlim(0.006, 900)
    ax.set_xlabel("经 Buffer.concat 拷贝的字节数 ÷ 输入字节数（对数轴）")
    ax.set_title("拷贝放大倍数：不依赖秒表的硬证据", fontsize=12, pad=14)

    ax.axvline(1.0, color=INK, linestyle="--", linewidth=1.1, alpha=0.55)
    ax.text(1.12, len(rows) - 0.35, "1× = 输入本身", color=INK, fontsize=8.5, ha="left", va="center")

    for yy, v, raw in zip(y - h / 2, up, [r["impls"]["upstream"]["copyAmplification"] for r in rows]):
        ax.text(v * 1.12, yy, f"{raw:.1f}×" if raw >= 1 else "<0.01×", va="center", fontsize=8.5, color=INK)
    for yy, v, raw in zip(y + h / 2, op, [r["impls"]["optimized"]["copyAmplification"] for r in rows]):
        label = f"{raw:.1f}×" if raw >= 0.05 else "<0.01×"
        ax.text(v * 1.12, yy, label, va="center", fontsize=8.5, color=OLIVE, fontweight="bold")

    ax.legend(loc="lower right", frameon=False, fontsize=9)
    fig.tight_layout()
    fig.savefig(OUT / "copy-amplification.png", dpi=160)
    plt.close(fig)


def fig_crosspoint() -> None:
    """Speedup heatmap over row length x chunk size."""
    data = load("crosspoint.json")
    rows = data["rowBytes"]
    cols = data["chunkBytes"]
    cells = {(c["rowBytes"], c["chunkBytes"]): c for c in data["cells"]}

    grid = np.array([[cells[(r, c)]["optimized"]["median"] for c in cols] for r in rows])

    fig, ax = plt.subplots(figsize=(8.0, 4.6))
    im = ax.imshow(np.log2(grid), cmap="YlOrBr", aspect="auto", vmin=-0.4, vmax=4.0)
    ax.set_xticks(np.arange(len(cols)))
    ax.set_xticklabels([f"{c // 1024}K" for c in cols])
    ax.set_yticks(np.arange(len(rows)))
    ax.set_yticklabels([f"{r // 1024}K" for r in rows])
    ax.set_xlabel("chunk size")
    ax.set_ylabel("row length")
    ax.set_title("Speedup (upstream / optimized) by row length and chunk size", fontsize=12, pad=12)
    for i, r in enumerate(rows):
        for j, c in enumerate(cols):
            v = grid[i, j]
            col = PAPER if np.log2(v) > 2.2 else INK
            ax.text(j, i, f"{v:.2f}x", ha="center", va="center", fontsize=9, color=col)
    ax.grid(False)
    cb = fig.colorbar(im, ax=ax, pad=0.02)
    cb.set_label("log2(speedup)")
    fig.tight_layout()
    fig.savefig(OUT / "crosspoint-heatmap.png", dpi=160)
    plt.close(fig)


def fig_crosspoint_lines() -> None:
    """Same data as lines: speedup vs number of chunks a single row spans."""
    data = load("crosspoint.json")
    cells = data["cells"]
    by_row: dict[int, list] = {}
    for c in cells:
        by_row.setdefault(c["rowBytes"], []).append(c)

    # Six distinct colours: the palette must not repeat, or the two largest
    # rows become visually identical in the legend.
    palette = ["#8a7a68", "#6b6b3a", "#c8892b", "#b4552f", "#7a4a2a", "#2b2119"]
    styles = ["o-", "s-", "^-", "D-", "v-", "P-"]

    fig, ax = plt.subplots(figsize=(8.0, 4.8))
    for i, (row, cs) in enumerate(sorted(by_row.items())):
        cs = sorted(cs, key=lambda c: c["chunks"])
        xs = [c["chunks"] for c in cs]
        ys = [c["optimized"]["median"] for c in cs]
        lo = [c["optimized"]["p10"] for c in cs]
        hi = [c["optimized"]["p90"] for c in cs]
        color = palette[i % len(palette)]
        ax.plot(xs, ys, styles[i % len(styles)], color=color, linewidth=2.0,
                markersize=5.5, label=f"{row // 1024} KiB 行")
        ax.fill_between(xs, lo, hi, color=color, alpha=0.10, linewidth=0)
    ax.axhline(1.0, color=MUTED, linestyle="--", linewidth=1.2)
    ax.set_xscale("log", base=2)
    ax.set_ylim(0, max(max(c["optimized"]["p90"] for c in v) for v in by_row.values()) * 1.12)
    ax.set_xlabel("单行跨越多少个输入块")
    ax.set_ylabel("加速比（upstream / optimized）")
    ax.set_title("收益由「单行跨多少块」决定，而不是行长度本身", fontsize=12, pad=12)
    ax.legend(loc="upper left", frameon=False, fontsize=8.5, ncol=2)
    fig.tight_layout()
    fig.savefig(OUT / "crosspoint-lines.png", dpi=160)
    plt.close(fig)


def fig_arms() -> None:
    """Adjacent-arm attribution: which arm isolates the gain.

    Bars start at a small positive floor (not 0) so the log axis is meaningful;
    labels are right-aligned at a fixed x to keep them clear of error bars.
    """
    rows = load("arms.json")
    labels = [r["name"] for r in rows]
    keys = [
        ("upstream/arm1", "upstream → 仅碎片列表", TERRACOTTA),
        ("arm1/arm2", "碎片列表 → + 单块快路径", AMBER),
        ("upstream/arm2", "upstream → 交付版", OLIVE),
    ]

    all_lo = [r["ratios"][k]["p10"] for r in rows for k, _, _ in keys]
    all_hi = [r["ratios"][k]["p90"] for r in rows for k, _, _ in keys]
    xmin = min(all_lo) * 0.75
    xmax = max(all_hi) * 1.9

    y = np.arange(len(rows))
    h = 0.24
    fig, ax = plt.subplots(figsize=(9.0, 4.4))
    for k, (key, label, color) in enumerate(keys):
        vals = [r["ratios"][key]["median"] for r in rows]
        lo = [max(v - r["ratios"][key]["p10"], 0.01) for v, r in zip(vals, rows)]
        hi = [max(r["ratios"][key]["p90"] - v, 0.01) for v, r in zip(vals, rows)]
        off = (k - 1) * h
        ax.barh(y + off, [v - xmin for v in vals], h, left=xmin, color=color, label=label,
                xerr=[lo, hi], error_kw={"ecolor": INK, "elinewidth": 0.9, "capsize": 2})
        for yy, v in zip(y + off, vals):
            ax.text(xmax * 0.92, yy, f"{v:.2f}×", va="center", ha="right",
                    fontsize=8.5, color=INK, fontweight="bold")
    ax.set_yticks(y)
    ax.set_yticklabels(labels, fontsize=9)
    ax.invert_yaxis()
    ax.axvline(1.0, color=INK, linestyle="--", linewidth=1.2, alpha=0.6)
    ax.text(1.02, -0.62, "1.0 = 无变化", fontsize=8, color=INK, ha="left")
    ax.set_xscale("log")
    ax.set_xlim(xmin, xmax)
    ax.set_ylim(len(rows) - 0.45, -0.85)
    ax.set_xlabel("加速比（对数轴，误差棒 = p10–p90）")
    ax.set_title("相邻臂归因：收益全部来自「消除重复 concat」这一臂", fontsize=12, pad=12)
    # 图例放轴下方：loc="best" 在横向柱状图上会压住最后一行的标签
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.16), ncol=3, frameon=False, fontsize=8.5)
    fig.tight_layout()
    fig.savefig(OUT / "arm-attribution.png", dpi=160)
    plt.close(fig)


def fig_scenarios() -> None:
    """Per-scenario speedup with p10-p90 band, upstream vs optimized vs fixed.

    Log x-axis: scenarios span 0.87x to 9.2x, and on a linear axis everything
    below 1x collapses into an unreadable smudge at the origin.
    """
    rows = load("bench_scenarios.json")
    labels = [f"{r['id']}  {r['name']}" for r in rows]
    y = np.arange(len(rows))
    h = 0.34
    XMAX = 30.0

    fig, ax = plt.subplots(figsize=(9.8, 5.8))
    for k, (key, label, color) in enumerate([
        ("upstream/optimized", "upstream / 交付版", TERRACOTTA),
        ("upstream/fixed", "upstream / 修复版", OLIVE),
    ]):
        med = [r["ratios"][key]["median"] for r in rows]
        lo = [max(r["ratios"][key]["median"] - r["ratios"][key]["p10"], 0.01) for r in rows]
        hi = [max(r["ratios"][key]["p90"] - r["ratios"][key]["median"], 0.01) for r in rows]
        off = (k - 0.5) * h
        ax.barh(y + off, med, h, color=color, label=label,
                xerr=[lo, hi], error_kw={"ecolor": INK, "elinewidth": 0.9, "capsize": 2})
        # 数值统一贴右边界，避开误差棒
        for yy, v in zip(y + off, med):
            ax.text(XMAX * 0.93, yy, f"{v:.2f}×", va="center", ha="right",
                    fontsize=8, color=INK, fontweight="bold")
    ax.set_yticks(y)
    ax.set_yticklabels(labels, fontsize=8.5)
    ax.invert_yaxis()
    ax.set_xscale("log")
    ax.set_xlim(0.7, XMAX)
    ax.axvline(1.0, color=INK, linestyle="--", linewidth=1.2, alpha=0.6)
    ax.text(1.04, -0.66, "1.0 = 与上游相同", fontsize=8, color=INK, ha="left")
    ax.set_xlabel("相对上游的加速比（对数轴，1.0 = 无变化；误差棒 = p10–p90）")
    ax.set_title("场景扫描：只有长行碎片化才有收益，普通 CSV 没有", fontsize=12, pad=14)
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.13), ncol=2, frameon=False, fontsize=9)
    fig.tight_layout()
    fig.savefig(OUT / "scenario-sweep.png", dpi=160)
    plt.close(fig)


def fig_poison() -> None:
    """Mutation testing outcome."""
    data = load("poison.json")
    results = data["results"]
    labels = [f"{r['id']}  {r['desc']}" for r in results]
    colors = []
    for r in results:
        if r["verdict"] == "caught":
            colors.append(OLIVE)
        elif r["verdict"] == "missed_valid":
            colors.append(TERRACOTTA)
        else:
            colors.append(MUTED)

    fig, ax = plt.subplots(figsize=(9.0, 4.8))
    y = np.arange(len(results))
    ax.barh(y, [1] * len(results), color=colors, height=0.62)
    ax.set_yticks(y)
    ax.set_yticklabels(labels, fontsize=8.5)
    ax.invert_yaxis()
    ax.set_xlim(0, 1)
    ax.set_xticks([])
    ax.grid(False)
    verdict_text = {"caught": "caught", "missed_valid": "MISSED (real blind spot)", "missed_equivalent": "missed (equivalent)"}
    for i, r in enumerate(results):
        ax.text(0.5, i, verdict_text.get(r["verdict"], r["verdict"]), ha="center", va="center",
                fontsize=9, color=PAPER, fontweight="bold")
    ax.set_title(f"Mutation testing: {data['caught']} of {data['mutants']} injected defects caught",
                 fontsize=12, pad=12)
    fig.tight_layout()
    fig.savefig(OUT / "poison-matrix.png", dpi=160)
    plt.close(fig)


def fig_equivalence() -> None:
    """What was actually verified: case counts by family.

    Log x-axis, horizontal bars: the families span three orders of magnitude
    (464 vs 228,000) and a linear vertical bar chart makes two of them invisible.
    """
    data = load("equivalence.json")
    families = [
        ("差分模糊\n（真上游 vs 每个实现）", data["fuzz"]["cases"]),
        ("逐字节切分边界穷举", data["boundaries"]["cases"]),
        ("上游真实 fixtures\n（24 个 CSV 文件）", data["fixtures"].get("cases", 0))
    ]
    labels = [f[0] for f in families]
    values = [f[1] for f in families]

    fig, ax = plt.subplots(figsize=(8.6, 3.8))
    y = np.arange(len(families))
    bars = ax.barh(y, values, color=[AMBER, OLIVE, TERRACOTTA], height=0.5)
    ax.set_yticks(y)
    ax.set_yticklabels(labels, fontsize=9)
    ax.invert_yaxis()
    ax.set_xscale("log")
    ax.set_xlim(100, max(values) * 12)
    for rect, v in zip(bars, values):
        ax.text(v * 1.15, rect.get_y() + rect.get_height() / 2, f"{v:,}",
                va="center", fontsize=10, color=INK, fontweight="bold")
    ax.set_xlabel("比较次数（对数轴）")
    ax.set_title(f"等价性验证覆盖：{data['totalCases']:,} 组比较，{data['totalMismatches']} 处不一致",
                 fontsize=12, pad=12)
    fig.tight_layout()
    fig.savefig(OUT / "equivalence-coverage.png", dpi=160)
    plt.close(fig)


def fig_opcount() -> None:
    """Deterministic op counts: subarray views allocated per input row.

    This replaces wall-clock as the primary evidence for P1. Wall clock on
    this machine has a +/-21% noise floor (measured between two byte-identical
    copies of the same file), so a 12% timing difference proves nothing.
    """
    rows = load("opcount.json")
    labels = [r["name"] for r in rows]
    op = [r["impls"]["optimized"]["subarrayCalls"] for r in rows]
    sub = [r["impls"]["submission"]["subarrayCalls"] for r in rows]

    y = np.arange(len(rows))
    h = 0.34
    fig, ax = plt.subplots(figsize=(9.0, 4.6))
    ax.barh(y - h / 2, op, h, color=TERRACOTTA, label="交付版（每行无条件分配 tail）")
    ax.barh(y + h / 2, sub, h, color=OLIVE, label="可提交版（tail 只在需要时分配）")
    ax.set_yticks(y)
    ax.set_yticklabels(labels, fontsize=9)
    ax.invert_yaxis()
    ax.set_xscale("symlog", linthresh=10)
    ax.set_xlim(0, max(op) * 30)
    for yy, v in zip(y - h / 2, op):
        ax.text(max(v, 1) * 1.5, yy, f"{v:,}", va="center", fontsize=8.5, color=INK, fontweight="bold")
    for yy, v in zip(y + h / 2, sub):
        ax.text(max(v, 1) * 1.5, yy, f"{v:,}", va="center", fontsize=8.5, color=OLIVE, fontweight="bold")
    ax.set_xlabel("Buffer.subarray 调用次数（对数轴）")
    ax.set_title("确定性证据：每行多付一次 Buffer 视图分配", fontsize=12, pad=12)
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.16), ncol=2, frameon=False, fontsize=8.5)
    fig.tight_layout()
    fig.savefig(OUT / "subarray-count.png", dpi=160)
    plt.close(fig)


def fig_noise_floor() -> None:
    """Why the timing conclusions were withdrawn: the noise floor."""
    rows = load("same_code_null.json")
    labels = [r["name"] for r in rows]
    noise = [r["noiseFloorPct"] for r in rows]

    fig, ax = plt.subplots(figsize=(8.4, 3.8))
    y = np.arange(len(rows))
    bars = ax.barh(y, noise, color=MUTED, height=0.5)
    ax.set_yticks(y)
    ax.set_yticklabels(labels, fontsize=9)
    ax.invert_yaxis()
    ax.axvline(13, color=TERRACOTTA, linestyle="--", linewidth=1.6)
    ax.set_ylim(len(rows) - 0.4, -0.95)
    ax.text(13.6, -0.72, "此前声称的效应量（~12%）", color=TERRACOTTA, fontsize=8.5, va="center", ha="left")
    for rect, v in zip(bars, noise):
        ax.text(v + 0.6, rect.get_y() + rect.get_height() / 2, f"±{v}%", va="center", fontsize=9, color=INK, fontweight="bold")
    ax.set_xlim(0, max(noise) * 1.45)
    ax.set_xlabel("空对照的 p10–p90 偏离幅度（两份字节完全相同的代码之间）")
    ax.set_title("噪声底比效应还大：耗时结论全部撤回", fontsize=12, pad=12)
    fig.tight_layout()
    fig.savefig(OUT / "noise-floor.png", dpi=160)
    plt.close(fig)


if __name__ == "__main__":
    fig_copy_amplification()
    fig_crosspoint()
    fig_crosspoint_lines()
    fig_arms()
    fig_scenarios()
    fig_poison()
    fig_equivalence()
    fig_opcount()
    fig_noise_floor()
    print("figures written to", OUT)
    for p in sorted(OUT.glob("*.png")):
        print(" ", p.name, p.stat().st_size, "bytes")
