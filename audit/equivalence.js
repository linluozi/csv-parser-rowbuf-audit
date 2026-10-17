'use strict'
// 等价性验证：真上游 vs baseline vs 交付版 vs 修复版
// 输出 results/equivalence.json（确定性，CI 可用 --check 重算比对）
const fs = require('fs')
const path = require('path')
const { load, rng, chunkBy, runParser, normalize } = require('./harness')

const upstream = load('upstream/index.js')
const baseline = load('patch/baseline.js')
const optimized = load('patch/optimized.js')
const fixed = load('patch/fixed.js')
const submission = load('patch/submission.js')

const IMPLS = [
  ['baseline', baseline],
  ['optimized', optimized],
  ['fixed', fixed],
  ['submission', submission]
]

// ---------- 语料生成 ----------
const CHARS = ['a', 'b', 'c', '1', '2', ' ', ',', '"', '\n', '\r\n', '中', 'ʤ', ';', "'", '\\', '#', 'X', '\t']

function randText (r, maxLen) {
  const n = Math.floor(r() * maxLen)
  let s = ''
  for (let i = 0; i < n; i++) s += CHARS[Math.floor(r() * CHARS.length)]
  return s
}

function structuredCsv (r, rows, cols, opts) {
  const sep = opts.sep || ','
  const q = opts.q || '"'
  const nl = opts.nl || '\n'
  let out = ''
  for (let i = 0; i < rows; i++) {
    const cells = []
    for (let j = 0; j < cols; j++) {
      const kind = Math.floor(r() * 5)
      let v
      if (kind === 0) v = `v${i}_${j}`
      else if (kind === 1) v = `has${sep}comma`
      else if (kind === 2) v = `line1${nl}line2`
      else if (kind === 3) v = `say${q}hi${q}`
      else v = ''
      const wrap = kind !== 0 && r() < 0.85
      cells.push(wrap ? q + v.split(q).join(q + q) + q : v)
    }
    out += cells.join(sep) + nl
  }
  return out
}

// ---------- 选项矩阵 ----------
const OPTION_SETS = [
  {},
  { headers: false },
  { outputByteOffset: true },
  { strict: true },
  { raw: true },
  { separator: ';' },
  { quote: "'" },
  { quote: "'", escape: '\\' },
  { newline: 'X' },
  { skipComments: true },
  { skipComments: '#' },
  { skipLines: 1 },
  { maxRowBytes: 12 },
  { headers: ['a', 'b', 'c'] },
  { headers: ['a', 'b', 'c'], outputByteOffset: true },
  { mapHeaders: ({ header }) => String(header).toUpperCase() },
  { mapValues: ({ value }) => '[' + value + ']' },
  { headers: false, outputByteOffset: true },
  { strict: true, outputByteOffset: true }
]

const CHUNK_PATTERNS = [[1], [2], [3], [5], [7], [13], [4, 1, 9], [64], [4096], [1 << 20]]

async function fuzz () {
  const SEEDS = Number(process.env.SEEDS || 300)
  let cases = 0
  const mismatches = []
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed)
    const kind = seed % 3
    let text
    if (kind === 0) text = structuredCsv(r, 1 + Math.floor(r() * 6), 1 + Math.floor(r() * 4), {})
    else if (kind === 1) text = randText(r, 60)
    else text = structuredCsv(r, 1 + Math.floor(r() * 4), 1 + Math.floor(r() * 3), { nl: '\r\n' })
    const buf = Buffer.from(text)

    for (const opts of OPTION_SETS) {
      for (const pattern of CHUNK_PATTERNS) {
        const chunks = chunkBy(buf, pattern)
        const base = normalize(await runParser(upstream, chunks.map((c) => Buffer.from(c)), opts))
        for (const [name, f] of IMPLS) {
          const got = normalize(await runParser(f, chunks.map((c) => Buffer.from(c)), opts))
          cases++
          if (got !== base) {
            mismatches.push({ seed, impl: name, opts, pattern, text, expected: base, got })
          }
        }
      }
    }
  }
  return { seeds: SEEDS, optionSets: OPTION_SETS.length, chunkPatterns: CHUNK_PATTERNS.length, cases, mismatches }
}

// ---------- 逐字节切分边界穷举 ----------
async function boundaries () {
  const cases = []
  const add = (label, text, opts) => cases.push({ label, text, opts })

  add('escape 在块边界', "'abc\\'def'\n", { quote: "'", escape: '\\' })
  add('双引号转义在块边界', '"say ""hi"" ok",x\n', {})
  add('CRLF 在块边界', 'a,b\r\nc,d\r\n', {})
  add('多字节字符被切断', 'h1,h2\n中文值,ʤabc\n', {})
  add('行首 escape', "h\n\\'x\n", { quote: "'", escape: '\\' })
  add('第二行行首 escape', "h\na,b\n\\'x,y\n", { quote: "'", escape: '\\' })
  add('行首双引号', 'h\n""x\n', {})
  add('第二行行首双引号', 'h\nq\n""x\n', {})
  add('块尾 escape + 下块首引号', "h\nab\\\u0000", { quote: "'", escape: '\\' })

  let casesRun = 0
  const mismatches = []
  for (const c of cases) {
    const buf = Buffer.from(c.text)
    for (let cut = 1; cut < buf.length; cut++) {
      const chunks = [Buffer.from(buf.subarray(0, cut)), Buffer.from(buf.subarray(cut))]
      const base = normalize(await runParser(upstream, chunks.map((x) => Buffer.from(x)), c.opts))
      for (const [name, f] of IMPLS) {
        const got = normalize(await runParser(f, chunks.map((x) => Buffer.from(x)), c.opts))
        casesRun++
        if (got !== base) mismatches.push({ label: c.label, cut, impl: name, expected: base, got })
      }
    }
  }

  // maxRowBytes 扫描（含跨块累积）
  const longText = 'x'.repeat(30) + '\n'
  for (const mrb of [5, 10, 15, 20, 30, 31, 40]) {
    for (const cut of [4, 8, 16]) {
      const buf = Buffer.from(longText)
      const chunks = [Buffer.from(buf.subarray(0, cut)), Buffer.from(buf.subarray(cut))]
      const opts = { headers: ['a'], maxRowBytes: mrb }
      const base = normalize(await runParser(upstream, chunks.map((x) => Buffer.from(x)), opts))
      for (const [name, f] of IMPLS) {
        const got = normalize(await runParser(f, chunks.map((x) => Buffer.from(x)), opts))
        casesRun++
        if (got !== base) mismatches.push({ label: `maxRowBytes=${mrb} cut=${cut}`, impl: name, expected: base, got })
      }
    }
  }

  // 空块 / 纯换行 / 空输入
  for (const [label, chunks] of [
    ['空块夹在中间', [Buffer.alloc(0), Buffer.from('a,b\n1,2\n'), Buffer.alloc(0)]],
    ['只有换行', [Buffer.from('\n')]],
    ['两个换行', [Buffer.from('\n\n')]],
    ['只有 CRLF', [Buffer.from('\r\n')]],
    ['空输入', [Buffer.alloc(0)]]
  ]) {
    const base = normalize(await runParser(upstream, chunks.map((x) => Buffer.from(x)), {}))
    for (const [name, f] of IMPLS) {
      const got = normalize(await runParser(f, chunks.map((x) => Buffer.from(x)), {}))
      casesRun++
      if (got !== base) mismatches.push({ label, impl: name, expected: base, got })
    }
  }

  return { cases: casesRun, mismatches }
}

// ---------- 上游 ava 语料等价（用上游 test/fixtures 里的真实 CSV） ----------
async function fixtures () {
  const dir = path.join(__dirname, '..', 'upstream', 'fixtures')
  if (!fs.existsSync(dir)) return { skipped: true, cases: 0, mismatches: [] }
  let cases = 0
  const mismatches = []
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.csv'))
  for (const file of files) {
    const buf = fs.readFileSync(path.join(dir, file))
    for (const size of [1, 7, 64, 4096]) {
      const chunks = chunkBy(buf, [size])
      for (const opts of [{}, { headers: false }, { outputByteOffset: true }]) {
        const base = normalize(await runParser(upstream, chunks.map((c) => Buffer.from(c)), opts))
        for (const [name, f] of IMPLS) {
          const got = normalize(await runParser(f, chunks.map((c) => Buffer.from(c)), opts))
          cases++
          if (got !== base) mismatches.push({ file, size, opts, impl: name })
        }
      }
    }
  }
  return { files: files.length, cases, mismatches }
}

;(async () => {
  console.log('等价性验证：真上游 vs baseline / 交付版 / 修复版\n')
  const f = await fuzz()
  console.log(`差分模糊  ${f.cases} 组（${f.seeds} seed × ${f.optionSets} 选项 × ${f.chunkPatterns} 分块模式）→ ${f.mismatches.length} 不一致`)

  const b = await boundaries()
  console.log(`边界穷举  ${b.cases} 组 → ${b.mismatches.length} 不一致`)

  const fx = await fixtures()
  if (fx.skipped) console.log('上游 fixtures  未提供（跳过）')
  else console.log(`上游 fixtures  ${fx.files} 文件 × ${fx.cases} 组 → ${fx.mismatches.length} 不一致`)

  const out = {
    generatedAt: new Date().toISOString().slice(0, 10),
    upstreamSha1: require('crypto').createHash('sha1').update(fs.readFileSync(path.join(__dirname, '..', 'upstream', 'index.js'))).digest('hex'),
    fuzz: { cases: f.cases, mismatches: f.mismatches.length, seeds: f.seeds, optionSets: f.optionSets, chunkPatterns: f.chunkPatterns },
    boundaries: { cases: b.cases, mismatches: b.mismatches.length },
    fixtures: fx.skipped ? { skipped: true } : { files: fx.files, cases: fx.cases, mismatches: fx.mismatches.length },
    totalCases: f.cases + b.cases + fx.cases,
    totalMismatches: f.mismatches.length + b.mismatches.length + fx.mismatches.length
  }

  const target = path.join(__dirname, '..', 'results', 'equivalence.json')
  const text = JSON.stringify(out, null, 2) + '\n'

  if (process.argv.includes('--check')) {
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''
    const strip = (s) => s.replace(/"generatedAt": "[^"]*",\n/, '')
    if (strip(existing) !== strip(text)) {
      console.error('\n✗ equivalence.json 与重算结果不一致')
      process.exitCode = 1
    } else {
      console.log('\n✓ equivalence.json 与重算结果一致')
    }
  } else {
    fs.writeFileSync(target, text)
    console.log(`\n已写 results/equivalence.json（总计 ${out.totalCases} 组，${out.totalMismatches} 不一致）`)
  }

  if (out.totalMismatches > 0) {
    for (const m of [...f.mismatches, ...b.mismatches, ...fx.mismatches].slice(0, 8)) {
      console.error('  ' + JSON.stringify(m).slice(0, 300))
    }
    process.exitCode = 1
  }
})()
