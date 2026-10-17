'use strict'
// 不依赖秒表的性能证据：直接数 V8 层面的操作次数。
//
// 动机：本机常年挂着 60 个 node 进程，字节完全相同的两份代码之间
// 也能测出 ±21% 的「差异」。任何小于噪声底的耗时结论都不可信。
// 所以改用确定性计数：
//   ① Buffer.concat 调用次数与累计拷贝字节（已在 concat.js）
//   ② Buffer.subarray 调用次数 —— 这正好是 P1 的根因指标
//   ③ parseLine 调用次数与累计扫描字节
//
// 输出 results/opcount.json
const fs = require('fs')
const path = require('path')
const { load, slice, runParser, round } = require('./harness')

const upstream = load('upstream/index.js')
const optimized = load('patch/optimized.js')
const submission = load('patch/submission.js')

const realSubarray = Buffer.prototype.subarray
const realConcat = Buffer.concat
let subarrayCalls = 0
let subarrayBytes = 0
let concatCalls = 0
let concatBytes = 0

function install () {
  Buffer.prototype.subarray = function (start, end) {
    const r = realSubarray.call(this, start, end)
    subarrayCalls++
    subarrayBytes += r.length
    return r
  }
  Buffer.concat = function (list, total) {
    concatCalls++
    const r = realConcat(list, total)
    concatBytes += r.length
    return r
  }
}
function restore () {
  Buffer.prototype.subarray = realSubarray
  Buffer.concat = realConcat
}

const KIB = 1024
const MIB = 1024 * 1024

const CASES = [
  { name: '2 MiB 单行 / 4 KiB 块', buf: Buffer.concat([Buffer.from('x'.repeat(2 * MIB - 1)), Buffer.from('\n')]), chunk: 4 * KIB, opts: { headers: ['p'] } },
  { name: '256 KiB 单行 / 4 KiB 块', buf: Buffer.concat([Buffer.from('x'.repeat(256 * KIB - 1)), Buffer.from('\n')]), chunk: 4 * KIB, opts: { headers: ['p'] } },
  { name: '7268 行 / 4 KiB 块', buf: (() => { let s = 'a,b\n'; for (let i = 0; i < 7268; i++) s += `${i},v${i}\n`; return Buffer.from(s) })(), chunk: 4 * KIB, opts: {} },
  { name: '100 行（单块）', buf: (() => { let s = 'a,b\n'; for (let i = 0; i < 100; i++) s += `${i},v${i}\n`; return Buffer.from(s) })(), chunk: 4 * KIB, opts: {} },
  { name: '10 万行 / 64 KiB 块', buf: (() => { let s = 'id,val\n'; for (let i = 0; i < 100000; i++) s += `${i},v${i}\n`; return Buffer.from(s) })(), chunk: 64 * KIB, opts: {} }
]

const IMPLS = [['upstream', upstream], ['optimized', optimized], ['submission', submission]]

;(async () => {
  const out = []
  console.log('确定性操作计数（不依赖秒表）\n')
  for (const c of CASES) {
    const proto = slice(c.buf, c.chunk)
    const rec = { name: c.name, inputBytes: c.buf.length, chunkBytes: c.chunk, chunks: proto.length, impls: {} }
    for (const [name, f] of IMPLS) {
      subarrayCalls = 0
      subarrayBytes = 0
      concatCalls = 0
      concatBytes = 0
      const chunks = proto.map((x) => Buffer.from(x))
      install()
      await runParser(f, chunks, c.opts)
      restore()
      rec.impls[name] = {
        subarrayCalls,
        subarrayBytes,
        concatCalls,
        concatBytes,
        concatAmplification: round(concatBytes / c.buf.length, 3),
        // 每次 subarray 平均字节数：小值 = 大量碎视图
        avgSubarrayBytes: subarrayCalls ? round(subarrayBytes / subarrayCalls, 1) : 0
      }
    }
    out.push(rec)
    console.log(`### ${c.name}  (${(c.buf.length / KIB).toFixed(0)} KiB, ${proto.length} 块)`)
    for (const [name] of IMPLS) {
      const r = rec.impls[name]
      console.log(`  ${name.padEnd(10)} subarray ${String(r.subarrayCalls).padStart(6)} 次(均 ${String(r.avgSubarrayBytes).padStart(7)} B)  concat ${String(r.concatCalls).padStart(5)} 次(拷贝 ${(r.concatBytes / MIB).toFixed(2).padStart(7)} MiB = ${r.concatAmplification}×)`)
    }
    console.log('')
  }
  fs.writeFileSync(path.join(__dirname, '..', 'results', 'opcount.json'), JSON.stringify(out, null, 2) + '\n')
  console.log('已写 results/opcount.json')
})()
