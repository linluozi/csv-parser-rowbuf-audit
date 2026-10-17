#!/usr/bin/env python
"""生成可提交版 patch/submission.js。

在 patch/fixed.js（tail 惰性分配）基础上，把 defaults 与 this.state 恢复成
上游 standard 风格（一行一属性），以通过上游 eslint。

跑法：python audit/make_submission.py
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "patch" / "fixed.js"
DST = ROOT / "patch" / "submission.js"

text = SRC.read_text(encoding="utf-8")

OLD_DEFAULTS = """const defaults = {
  escape: '"', headers: null, mapHeaders: ({ header }) => header,
  mapValues: ({ value }) => value, newline: '\\n', quote: '"', raw: false,
  separator: ',', skipComments: false, skipLines: null,
  maxRowBytes: Number.MAX_SAFE_INTEGER, strict: false, outputByteOffset: false
}
"""

NEW_DEFAULTS = """const defaults = {
  escape: '"',
  headers: null,
  mapHeaders: ({ header }) => header,
  mapValues: ({ value }) => value,
  newline: '\\n',
  quote: '"',
  raw: false,
  separator: ',',
  skipComments: false,
  skipLines: null,
  maxRowBytes: Number.MAX_SAFE_INTEGER,
  strict: false,
  outputByteOffset: false
}
"""

OLD_STATE = """    this.state = {
      empty: options.raw ? Buffer.alloc(0) : '', escaped: false, first: true,
      lineNumber: 0, previousEnd: 0, rowLength: 0, quoted: false
    }
"""

NEW_STATE = """    this.state = {
      empty: options.raw ? Buffer.alloc(0) : '',
      escaped: false,
      first: true,
      lineNumber: 0,
      previousEnd: 0,
      rowLength: 0,
      quoted: false
    }
"""

assert OLD_DEFAULTS in text, "defaults block not found in fixed.js"
assert OLD_STATE in text, "state block not found in fixed.js"

text = text.replace(OLD_DEFAULTS, NEW_DEFAULTS).replace(OLD_STATE, NEW_STATE)

# 说明性头部注释：标明这是审查后建议采用的版本
text = text.replace(
    "// Optimization patch based on mafintosh/csv-parser (MIT).\n"
    "// Upstream copyright and license are preserved in LICENSE.\n",
    "// Fragment-buffer optimization for mafintosh/csv-parser (MIT).\n"
    "// Upstream copyright and license are preserved in LICENSE.\n"
    "//\n"
    "// This is the version recommended after independent audit: it keeps the\n"
    "// fragment-list rewrite, moves the per-row `subarray` view into the branch\n"
    "// that actually needs it, and restores the upstream one-property-per-line\n"
    "// object style so the repo's own eslint config passes.\n",
)

DST.write_text(text, encoding="utf-8", newline="\n")
print(f"wrote {DST}")
