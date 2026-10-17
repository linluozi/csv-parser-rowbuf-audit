'use strict'
// 交叉点扫描：行长度 × chunk 尺寸 → 加速比
// 回答「什么条件下才有收益」，避免把单点倍数当通用结论
// 输出 results/crosspoint.json
const fs = require('fs')
const path = require('path')
const { performance } = require('perf_hooks')
const { load, slice, runParser, median, quantile, round } = require('./harness')

const upstream = load('upstream/index.js')
const optimized = load('patch/optimized.js')
const fixed = load('patch/fixed.js')

const KIB = 1024
const ROW_BYTES = [4 * KIB, 16 * KIB, 64 * KIB, 256 * KIB, 1024 * KIB, 4096 * KIB]
const CHUNK_BYTES = [4 * KIB, 16 * KIB, 64 * KIB, 256 * KIB, 1024 * KIB]
const ROUNDS = 7
const BUDGET_MS = 30

const IMPLS = [['upstream', upstream], ['optimized', optimized], ['fixed', fixed]]

async function calibrate (factory, proto, opts) {
  const probe = proto.map((c) => Buffer.from(c))
  const t0 = performance.now()
  await runParser(factory, probe, opts)
  const single = performance.now() - t0
  return Math.max(1, Math.min(3000, Math.round(BUDGET_MS / Math.max(single, 0.005))))
}

;(async () => {
  const table = []
  console.log('交叉点扫描：单行 CSV（一个 payload 单元格）')
  console.log('每格按单次耗时校准迭代次数，逐轮比值取中位数\n')

  const header = '  行 \\ 块 ' + CHUNK_BYTES.map((c) => (c / KIB + 'K').padStart(10)).join('')
  console.log(header)
  const grid = { optimized: [], fixed: [] }

  for (const rowBytes of ROW_BYTES) {
    const buf = Buffer.concat([Buffer.from('x'.repeat(rowBytes - 1)), Buffer.from('\n')])
    const rowOut = []
    for (const chunkBytes of CHUNK_BYTES) {
      const proto = slice(buf, chunkBytes)
      const opts = { headers: ['p'] }
      const N = await calibrate(optimized, proto, opts)

      const pools = {}
      for (const [name] of IMPLS) pools[name] = Array.from({ length: ROUNDS + 2 }, () => Array.from({ length: N }, () => proto.map((c) => Buffer.from(c))))
      for (const [name, f] of IMPLS) for (let i = 0; i < 2; i++) for (let j = 0; j < N; j++) await runParser(f, pools[name][i][j], opts)

      const rat = { optimized: [], fixed: [] }
      for (let r = 0; r < ROUNDS; r++) {
        const row = {}
        for (const [name, f] of IMPLS) {
          const t0 = performance.now()
          for (let j = 0; j < N; j++) await runParser(f, pools[name][r + 2][j], opts)
          row[name] = (performance.now() - t0) / N
        }
        rat.optimized.push(row.upstream / row.optimized)
        rat.fixed.push(row.upstream / row.fixed)
      }

      const rec = {
        rowBytes,
        chunkBytes,
        chunks: proto.length,
        iterationsPerRound: N,
        optimized: { median: round(median(rat.optimized), 3), p10: round(quantile(rat.optimized, 0.1), 3), p90: round(quantile(rat.optimized, 0.9), 3) },
        fixed: { median: round(median(rat.fixed), 3), p10: round(quantile(rat.fixed, 0.1), 3), p90: round(quantile(rat.fixed, 0.9), 3) }
      }
      table.push(rec)
      rowOut.push(rec.optimized.median)
      grid.optimized.push(rec.optimized.median)
      grid.fixed.push(rec.fixed.median)
    }
    console.log(String(rowBytes / KIB + 'K').padStart(9) + rowOut.map((v) => (v.toFixed(2) + '×').padStart(10)).join(''))
  }

  console.log('\n同一张表（修复版 fixed）：')
  console.log(header)
  for (let i = 0; i < ROW_BYTES.length; i++) {
    const sliceRow = grid.fixed.slice(i * CHUNK_BYTES.length, (i + 1) * CHUNK_BYTES.length)
    console.log(String(ROW_BYTES[i] / KIB + 'K').padStart(9) + sliceRow.map((v) => (v.toFixed(2) + '×').padStart(10)).join(''))
  }

  fs.writeFileSync(path.join(__dirname, '..', 'results', 'crosspoint.json'), JSON.stringify({
    rowBytes: ROW_BYTES,
    chunkBytes: CHUNK_BYTES,
    rounds: ROUNDS,
    cells: table
  }, null, 2) + '\n')
  console.log('\n已写 results/crosspoint.json')
})()
