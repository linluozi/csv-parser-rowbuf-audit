'use strict'
// 硬证据：统计 Buffer.concat 的调用次数与累计拷贝字节（不依赖秒表）
// 输出 results/concat.json
const fs = require('fs')
const path = require('path')
const { load } = require('./harness')

const upstream = load('upstream/index.js')
const baseline = load('patch/baseline.js')
const optimized = load('patch/optimized.js')
const fixed = load('patch/fixed.js')

const realConcat = Buffer.concat
let calls = 0
let bytes = 0

function instrument () {
  Buffer.concat = function (list, total) {
    calls++
    const r = realConcat(list, total)
    bytes += r.length
    return r
  }
}
function restore () { Buffer.concat = realConcat }

function slice (buf, n) {
  const out = []
  for (let i = 0; i < buf.length; i += n) out.push(Buffer.from(buf.subarray(i, i + n)))
  return out
}

function run (factory, chunks, opts) {
  return new Promise((resolve, reject) => {
    const p = factory(opts)
    let n = 0
    p.on('data', () => { n++ })
    p.on('error', reject)
    p.on('end', () => resolve(n))
    for (const c of chunks) p.write(c)
    p.end()
  })
}

const KIB = 1024
const MIB = 1024 * 1024

const CASES = [
  {
    name: '2 MiB 单行 / 4 KiB 块',
    buf: Buffer.concat([Buffer.from('x'.repeat(2 * MIB - 1)), Buffer.from('\n')]),
    chunk: 4 * KIB,
    opts: { headers: ['p'] }
  },
  {
    name: '256 KiB 单行 / 4 KiB 块',
    buf: Buffer.concat([Buffer.from('x'.repeat(256 * KIB - 1)), Buffer.from('\n')]),
    chunk: 4 * KIB,
    opts: { headers: ['p'] }
  },
  {
    name: '2 MiB 单行 / 64 KiB 块',
    buf: Buffer.concat([Buffer.from('x'.repeat(2 * MIB - 1)), Buffer.from('\n')]),
    chunk: 64 * KIB,
    opts: { headers: ['p'] }
  },
  {
    name: '7268 行 × 43 B / 4 KiB 块',
    buf: (() => { let s = 'a,b\n'; for (let i = 0; i < 7268; i++) s += `${i},v${i}\n`; return Buffer.from(s) })(),
    chunk: 4 * KIB,
    opts: {}
  },
  {
    name: '10 万行 × 13 B / 64 KiB 块',
    buf: (() => { let s = 'id,val\n'; for (let i = 0; i < 100000; i++) s += `${i},v${i}\n`; return Buffer.from(s) })(),
    chunk: 64 * KIB,
    opts: {}
  }
]

const IMPLS = [['upstream', upstream], ['baseline', baseline], ['optimized', optimized], ['fixed', fixed]]

;(async () => {
  const out = []
  console.log('Buffer.concat 硬统计（调用次数 / 累计拷贝字节）\n')
  for (const c of CASES) {
    const proto = slice(c.buf, c.chunk)
    const rec = { name: c.name, inputBytes: c.buf.length, chunkBytes: c.chunk, chunks: proto.length, impls: {} }
    for (const [name, f] of IMPLS) {
      const chunks = proto.map((x) => Buffer.from(x))
      calls = 0
      bytes = 0
      instrument()
      await run(f, chunks, c.opts)
      restore()
      rec.impls[name] = { concatCalls: calls, copiedBytes: bytes, copyAmplification: Number((bytes / c.buf.length).toFixed(2)) }
    }
    out.push(rec)
    console.log(`### ${c.name}  (输入 ${(c.buf.length / KIB).toFixed(0)} KiB, ${proto.length} 块)`)
    for (const [name] of IMPLS) {
      const r = rec.impls[name]
      console.log(`  ${name.padEnd(10)} ${String(r.concatCalls).padStart(5)} 次   拷贝 ${(r.copiedBytes / MIB).toFixed(2).padStart(8)} MiB   = 输入 ${r.copyAmplification.toFixed(2)}×`)
    }
    console.log('')
  }
  fs.writeFileSync(path.join(__dirname, '..', 'results', 'concat.json'), JSON.stringify(out, null, 2) + '\n')
  console.log('已写 results/concat.json')
})()
