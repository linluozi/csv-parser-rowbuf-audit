'use strict'
// 最严空对照：同一份字节的两个独立副本，各自是独立模块实例。
// 它们之间的比值就是这台机器上「多实现对比」的噪声底。
// 任何小于噪声底的「显著差异」都是假的。
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { performance } = require('perf_hooks')
const { slice, runParser, median, quantile, round } = require('./harness')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'patch', 'submission.js')
const A_PATH = path.join(ROOT, 'patch', '.dup_a.js')
const B_PATH = path.join(ROOT, 'patch', '.dup_b.js')

const bytes = fs.readFileSync(SRC)
fs.writeFileSync(A_PATH, bytes)
fs.writeFileSync(B_PATH, bytes)

const A = require(A_PATH)
const B = require(B_PATH)

const KIB = 1024
const MIB = 1024 * 1024
const ROUNDS = Number(process.env.ROUNDS || 31)

const rotate = (a, k) => a.slice(k % a.length).concat(a.slice(0, k % a.length))

async function measure (impls, proto, opts, rounds, it) {
  const pools = {}
  for (const [n] of impls) {
    pools[n] = Array.from({ length: rounds + 3 }, () =>
      Array.from({ length: it }, () => proto.map((c) => Buffer.from(c))))
  }
  for (const [n, f] of impls) for (let i = 0; i < 3; i++) for (let j = 0; j < it; j++) await runParser(f, pools[n][i][j], opts)
  const out = []
  for (let r = 0; r < rounds; r++) {
    const row = {}
    for (const [n, f] of rotate(impls, r)) {
      const batch = pools[n][r + 3]
      const t0 = performance.now()
      for (let j = 0; j < it; j++) await runParser(f, batch[j], opts)
      row[n] = (performance.now() - t0) / it
    }
    out.push(row)
  }
  return out
}

const CASES = [
  ['2 MiB 单行 / 4 KiB 块', Buffer.concat([Buffer.from('x'.repeat(2 * MIB - 1)), Buffer.from('\n')]), 4 * KIB, { headers: ['p'] }],
  ['7268 行 / 4 KiB 块', (() => { let s = 'a,b\n'; for (let i = 0; i < 7268; i++) s += `${i},v${i}\n`; return Buffer.from(s) })(), 4 * KIB, {}],
  ['100 行（单块）', (() => { let s = 'a,b\n'; for (let i = 0; i < 100; i++) s += `${i},v${i}\n`; return Buffer.from(s) })(), 4 * KIB, {}]
]

;(async () => {
  console.log('同代码双副本空对照（两个文件字节完全相同）\n')
  const sha = crypto.createHash('sha1').update(bytes).digest('hex')
  console.log(`A sha1 = ${sha}`)
  console.log(`B sha1 = ${crypto.createHash('sha1').update(fs.readFileSync(B_PATH)).digest('hex')}\n`)

  const res = []
  for (const [name, buf, ch, opts] of CASES) {
    const proto = slice(buf, ch)
    const w = proto.map((c) => Buffer.from(c))
    for (let i = 0; i < 3; i++) await runParser(A, w.map((c) => Buffer.from(c)), opts)
    const ts = []
    for (let i = 0; i < 5; i++) {
      const p = proto.map((c) => Buffer.from(c))
      const t0 = performance.now()
      await runParser(A, p, opts)
      ts.push(performance.now() - t0)
    }
    ts.sort((a, b) => a - b)
    const N = Math.max(1, Math.min(4000, Math.round(40 / Math.max(ts[0], 0.005))))

    const pr = await measure([['A', A], ['B', B]], proto, opts, ROUNDS, N)
    const r = pr.map((x) => x.A / x.B)
    const m = median(r)
    const lo = quantile(r, 0.1)
    const hi = quantile(r, 0.9)
    const noise = Math.max(Math.abs(1 - lo), Math.abs(hi - 1)) * 100
    console.log(`### ${name} (每轮 ${N} 次, ${ROUNDS} 轮)`)
    console.log(`  A/B = ${m.toFixed(3)}×  p10–p90 ${lo.toFixed(3)}–${hi.toFixed(3)}   → 噪声底 ±${noise.toFixed(1)}%`)
    res.push({ name, iterationsPerRound: N, rounds: ROUNDS, median: round(m, 3), p10: round(lo, 3), p90: round(hi, 3), noiseFloorPct: round(noise, 1) })
  }

  fs.writeFileSync(path.join(ROOT, 'results', 'same_code_null.json'), JSON.stringify(res, null, 2) + '\n')
  fs.unlinkSync(A_PATH)
  fs.unlinkSync(B_PATH)
  console.log('\n已写 results/same_code_null.json')
})()
