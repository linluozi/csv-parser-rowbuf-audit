'use strict'
// 交错基准（修正版）：顺序轮换 + 预热校准 + 批跑放大
// 输出 results/bench_scenarios.json
const fs = require('fs')
const path = require('path')
const { load, slice, runParser, median, quantile, stdev, round } = require('./harness')
const { buildPools, calibrate, interleaved } = require('./benchcore')

const upstream = load('upstream/index.js')
const optimized = load('patch/optimized.js')
const fixed = load('patch/fixed.js')

const IMPLS = [['upstream', upstream], ['optimized', optimized], ['fixed', fixed]]
const KIB = 1024
const MIB = 1024 * 1024
const BUDGET_MS = 40

function buildBigCellCsv (rows, cellBytes) {
  let s = 'id,payload,ts\n'
  const cell = JSON.stringify({ items: Array.from({ length: (cellBytes / 40) | 0 }, (_, i) => ({ k: i, v: 'val' + i })) })
  const quoted = '"' + cell.replace(/"/g, '""') + '"'
  for (let i = 0; i < rows; i++) s += `${i},${quoted},2026-10-17\n`
  return Buffer.from(s)
}

const SCENARIOS = [
  { id: 'A', name: '2 MiB 单行 / 4 KiB 块', note: '包自带 bench 场景', buf: () => Buffer.concat([Buffer.from('x'.repeat(2 * MIB - 1)), Buffer.from('\n')]), chunk: 4 * KIB, opts: { headers: ['p'] } },
  { id: 'B', name: '2 MiB 单行 / 64 KiB 块', note: 'fs 流默认高水位', buf: () => Buffer.concat([Buffer.from('x'.repeat(2 * MIB - 1)), Buffer.from('\n')]), chunk: 64 * KIB, opts: { headers: ['p'] } },
  { id: 'C', name: '256 KiB 单行 / 4 KiB 块', buf: () => Buffer.concat([Buffer.from('x'.repeat(256 * KIB - 1)), Buffer.from('\n')]), chunk: 4 * KIB, opts: { headers: ['p'] } },
  { id: 'D', name: '7268 行 × 43 B / 4 KiB 块', note: '上游 large-dataset 量级', buf: () => { let s = 'a,b\n'; for (let i = 0; i < 7268; i++) s += `${i},v${i}\n`; return Buffer.from(s) }, chunk: 4 * KIB, opts: {} },
  { id: 'E', name: '7268 行 + outputByteOffset', buf: () => { let s = 'a,b\n'; for (let i = 0; i < 7268; i++) s += `${i},v${i}\n`; return Buffer.from(s) }, chunk: 4 * KIB, opts: { outputByteOffset: true } },
  { id: 'F', name: '10 万行 × 13 B / 64 KiB 块', buf: () => { let s = 'id,val\n'; for (let i = 0; i < 100000; i++) s += `${i},v${i}\n`; return Buffer.from(s) }, chunk: 64 * KIB, opts: {} },
  { id: 'G', name: '100 行 × 40 B / 4 KiB 块（单块）', note: '小文件典型形态', buf: () => { let s = 'a,b\n'; for (let i = 0; i < 100; i++) s += `${i},v${i}\n`; return Buffer.from(s) }, chunk: 4 * KIB, opts: {} },
  { id: 'H', name: '5 行 × 1 MiB JSON 单元格 / 64 KiB 块', note: '真实大单元格 CSV', buf: () => buildBigCellCsv(5, MIB), chunk: 64 * KIB, opts: {} },
  { id: 'I', name: '20 行 × 200 KiB JSON 单元格 / 64 KiB 块', buf: () => buildBigCellCsv(20, 200 * KIB), chunk: 64 * KIB, opts: {} }
]

;(async () => {
  const ROUNDS = Number(process.env.ROUNDS || 11)
  const results = []
  console.log('交错基准（修正版）')
  console.log('预热 3 次 → min-of-5 校准迭代次数 → 每轮轮换 impl 顺序 → 逐轮比值中位数')
  console.log(`每场景校准到约 ${BUDGET_MS} ms/轮，正式 ${ROUNDS} 轮\n`)

  for (const sc of SCENARIOS) {
    const buf = sc.buf()
    const proto = slice(buf, sc.chunk)
    const singleMs = await calibrate(optimized, proto, sc.opts, runParser)
    const N = Math.max(1, Math.min(4000, Math.round(BUDGET_MS / Math.max(singleMs, 0.005))))

    const pools = buildPools(IMPLS, proto, ROUNDS, N)
    for (const [name, f] of IMPLS) {
      for (let i = 0; i < 3; i++) for (let j = 0; j < N; j++) await runParser(f, pools[name][i][j], sc.opts)
    }

    const perRound = await interleaved(IMPLS, pools, sc.opts, ROUNDS, N, runParser)

    const samples = {}
    for (const [name] of IMPLS) samples[name] = perRound.map((r) => r[name])
    const ratios = { 'upstream/optimized': [], 'upstream/fixed': [], 'optimized/fixed': [] }
    for (const r of perRound) {
      ratios['upstream/optimized'].push(r.upstream / r.optimized)
      ratios['upstream/fixed'].push(r.upstream / r.fixed)
      ratios['optimized/fixed'].push(r.optimized / r.fixed)
    }

    const rec = {
      id: sc.id,
      name: sc.name,
      note: sc.note || null,
      inputBytes: buf.length,
      chunkBytes: sc.chunk,
      chunks: proto.length,
      iterationsPerRound: N,
      rounds: ROUNDS,
      perCallMs: {},
      cv: {},
      ratios: {}
    }
    for (const [name] of IMPLS) {
      rec.perCallMs[name] = round(median(samples[name]), 4)
      rec.cv[name] = round((stdev(samples[name]) / median(samples[name])) * 100, 1)
    }
    for (const k of Object.keys(ratios)) {
      rec.ratios[k] = {
        median: round(median(ratios[k]), 3),
        p10: round(quantile(ratios[k], 0.1), 3),
        p90: round(quantile(ratios[k], 0.9), 3)
      }
    }
    results.push(rec)

    console.log(`### ${sc.id} ${sc.name}  (${(buf.length / KIB).toFixed(0)} KiB, ${proto.length} 块, 每轮 ${N} 次)`)
    for (const [name] of IMPLS) {
      const v = rec.perCallMs[name]
      const shown = v >= 1 ? v.toFixed(3) + ' ms' : (v * 1000).toFixed(1) + ' µs'
      console.log(`  ${name.padEnd(10)} ${shown.padStart(10)}   CV ${String(rec.cv[name]).padStart(5)}%`)
    }
    for (const k of Object.keys(ratios)) {
      const r = rec.ratios[k]
      console.log(`  ${k.padEnd(18)} ${r.median.toFixed(3)}×  p10–p90 ${r.p10.toFixed(3)}–${r.p90.toFixed(3)}`)
    }
    console.log('')
  }

  fs.writeFileSync(path.join(__dirname, '..', 'results', 'bench_scenarios.json'), JSON.stringify(results, null, 2) + '\n')
  console.log('已写 results/bench_scenarios.json')
})()
