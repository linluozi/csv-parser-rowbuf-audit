#!/usr/bin/env python
"""把 README.md 转成一个自包含的 HTML 阅读页（暖色编辑风）。

图片走 GitHub raw，因此页面本身可以放在任意静态托管上。
跑法：python audit/make_page.py
"""
from __future__ import annotations

import html
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = "https://raw.githubusercontent.com/linluozi/csv-parser-rowbuf-audit/main/"
OUT = ROOT / "index.html"


def inline(text: str) -> str:
    t = html.escape(text)
    t = re.sub(
        r"!\[([^\]]*)\]\(([^)]+)\)",
        lambda m: f'<img alt="{m.group(1)}" src="{RAW}{m.group(2)}">',
        t,
    )
    t = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', t)
    t = re.sub(r"`([^`]+)`", r"<code>\1</code>", t)
    t = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", t)
    return t


def slug(text: str) -> str:
    s = re.sub(r"[^\w\u4e00-\u9fff]+", "-", text.strip().lower())
    return s.strip("-")


def convert(md: str) -> str:
    lines = md.split("\n")
    out: list[str] = []
    i = 0
    in_code = False
    code_buf: list[str] = []

    while i < len(lines):
        line = lines[i]

        if line.startswith("```"):
            if in_code:
                out.append("<pre><code>" + html.escape("\n".join(code_buf)) + "</code></pre>")
                code_buf = []
                in_code = False
            else:
                in_code = True
            i += 1
            continue
        if in_code:
            code_buf.append(line)
            i += 1
            continue

        # 表格
        if line.startswith("|") and i + 1 < len(lines) and re.match(r"^\|[\s:\-|]+\|$", lines[i + 1]):
            heads = [c.strip() for c in line.strip("|").split("|")]
            out.append("<table><thead><tr>" + "".join(f"<th>{inline(c)}</th>" for c in heads) + "</tr></thead><tbody>")
            i += 2
            while i < len(lines) and lines[i].startswith("|"):
                cells = [c.strip() for c in lines[i].strip("|").split("|")]
                out.append("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in cells) + "</tr>")
                i += 1
            out.append("</tbody></table>")
            continue

        if line.startswith("#"):
            level = len(line) - len(line.lstrip("#"))
            text = line[level:].strip()
            out.append(f'<h{level} id="{slug(text)}">{inline(text)}</h{level}>')
            i += 1
            continue

        if line.strip() == "---":
            out.append("<hr>")
            i += 1
            continue

        if line.startswith(">"):
            buf = []
            while i < len(lines) and lines[i].startswith(">"):
                buf.append(lines[i].lstrip(">").strip())
                i += 1
            out.append("<blockquote><p>" + inline(" ".join(buf)) + "</p></blockquote>")
            continue

        if re.match(r"^\s*[-*] ", line):
            out.append("<ul>")
            while i < len(lines) and re.match(r"^\s*[-*] ", lines[i]):
                out.append("<li>" + inline(re.sub(r"^\s*[-*] ", "", lines[i])) + "</li>")
                i += 1
            out.append("</ul>")
            continue

        if re.match(r"^\d+\. ", line):
            out.append("<ol>")
            while i < len(lines) and re.match(r"^\d+\. ", lines[i]):
                out.append("<li>" + inline(re.sub(r"^\d+\. ", "", lines[i])) + "</li>")
                i += 1
            out.append("</ol>")
            continue

        if line.strip():
            out.append("<p>" + inline(line) + "</p>")
        i += 1

    return "\n".join(out)


CSS = """
:root{--ink:#2b2119;--paper:#faf6f0;--amber:#c8892b;--terra:#b4552f;
--olive:#6b6b3a;--muted:#8a7a68;--line:#ddd2c4;--card:#fffdf9}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);
font:16px/1.78 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
-webkit-font-smoothing:antialiased}
.wrap{max-width:860px;margin:0 auto;padding:52px 28px 120px}
h1{font-size:2.02rem;line-height:1.32;letter-spacing:-.01em;margin:0 0 10px}
h2{font-size:1.32rem;margin:2.6em 0 .8em;padding-bottom:.34em;
border-bottom:2px solid var(--line)}
h3{font-size:1.06rem;margin:1.8em 0 .6em;color:var(--terra)}
p{margin:.85em 0}
a{color:var(--terra);text-decoration:none;border-bottom:1px solid rgba(180,85,47,.32)}
a:hover{border-bottom-color:var(--terra)}
hr{border:0;border-top:1px solid var(--line);margin:2.4em 0}
code{background:#f2ece2;padding:.12em .4em;border-radius:4px;
font:.87em/1.5 "SFMono-Regular",Consolas,"Liberation Mono",monospace}
pre{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--amber);
border-radius:6px;padding:16px 18px;overflow-x:auto;margin:1.1em 0}
pre code{background:none;padding:0;font-size:.84em;line-height:1.65}
blockquote{margin:1.4em 0;padding:14px 20px;background:var(--card);
border-left:3px solid var(--terra);border-radius:0 6px 6px 0;color:#4a3d31}
blockquote p{margin:0}
img{display:block;max-width:100%;height:auto;margin:1.6em auto;
border:1px solid var(--line);border-radius:8px;background:#fff;
box-shadow:0 2px 14px rgba(43,33,25,.07)}
table{width:100%;border-collapse:collapse;margin:1.3em 0;font-size:.9rem;
background:var(--card);border-radius:6px;overflow:hidden;
box-shadow:0 1px 3px rgba(43,33,25,.05)}
th,td{padding:9px 13px;text-align:left;border-bottom:1px solid var(--line)}
th{background:#f2ece2;font-weight:600;font-size:.85rem;letter-spacing:.02em}
tr:last-child td{border-bottom:0}
tbody tr:hover{background:#fdfaf4}
ul,ol{padding-left:1.5em;margin:.9em 0}
li{margin:.35em 0}
.topbar{position:sticky;top:0;z-index:10;background:rgba(250,246,240,.94);
backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.topbar .inner{max-width:860px;margin:0 auto;padding:11px 28px;display:flex;
gap:13px;align-items:center;flex-wrap:wrap;font-size:.85rem;color:var(--muted)}
.topbar a{color:var(--muted);border-bottom:none}
.topbar a:hover{color:var(--terra)}
.sep{opacity:.4}
.tag{display:inline-block;padding:2px 9px;border-radius:99px;font-size:.74rem;
background:#f2ece2;color:var(--olive);border:1px solid var(--line);margin-left:6px}
@media(max-width:640px){
.wrap{padding:30px 18px 80px}
h1{font-size:1.55rem}
table{font-size:.79rem}
th,td{padding:7px 9px}
}
"""

BODY = convert((ROOT / "README.md").read_text(encoding="utf-8"))

PAGE = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>csv-parser 部分行缓冲优化：独立审查</title>
<meta name="description" content="对一个第三方 csv-parser 优化包的独立复核：229,616 组等价性验证、确定性操作计数、噪声底实测。">
<style>{CSS}</style>
</head>
<body>
<div class="topbar"><div class="inner">
<a href="https://github.com/linluozi/csv-parser-rowbuf-audit">← 仓库</a><span class="sep">/</span>
<a href="https://github.com/linluozi/csv-parser-rowbuf-audit/blob/main/patch/submission.js">patch/submission.js</a><span class="sep">/</span>
<a href="https://github.com/linluozi/csv-parser-rowbuf-audit/tree/main/results">results/</a><span class="sep">/</span>
<a href="https://github.com/linluozi/csv-parser-rowbuf-audit/tree/main/charts">charts/</a>
<span style="margin-left:auto"><span class="tag">PUBLIC</span><span class="tag">MIT</span></span>
</div></div>
<div class="wrap">
{BODY}
</div>
</body>
</html>
"""

OUT.write_text(PAGE, encoding="utf-8", newline="\n")
print(f"wrote {OUT} ({len(PAGE.encode('utf-8')):,} bytes)")
print(f"images referenced: {PAGE.count('<img ')}")
