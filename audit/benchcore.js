'use strict'
// 交错基准核心：解决三个已知陷阱
//   ① 冷启动校准 → 迭代次数被低估：先 warmup，再取 min-of-5 校准
//   ② 固定顺序 → 位置效应：每轮轮换 impl 顺序（拉丁方）
//   ③ 贴噪声底 → 单次 <0.1ms 不可测：校准到 BUDGET_MS 预算批跑
const { performance } = require('perf_hooks')

function rotatedOrder (impls, round) {
  const n = impls.length
  const k = round % n
  return impls.slice(k).concat(impls.slice(0, k))
}

// 预置 pool：每 impl 每轮 N 份独立副本（parseCell 会就地改 buffer）
function buildPools (impls, proto, rounds, iterations) {
  const pools = {}
  for (const [name] of impls) {
    pools[name] = Array.from({ length: rounds + 3 }, () =>
      Array.from({ length: iterations }, () => proto.map((c) => Buffer.from(c)))
    )
  }
  return pools
}

// 先 warmup 再校准：min-of-5，避免冷启动把 N 压到 1
async function calibrate (factory, proto, opts, runOnce) {
  const warm = proto.map((c) => Buffer.from(c))
  for (let i = 0; i < 3; i++) await runOnce(factory, warm.map((c) => Buffer.from(c)), opts)
  const times = []
  for (let i = 0; i < 5; i++) {
    const probe = proto.map((c) => Buffer.from(c))
    const t0 = performance.now()
    await runOnce(factory, probe, opts)
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  return times[0]
}

// 主循环：返回每轮每 impl 的单次均摊耗时
async function interleaved (impls, pools, opts, rounds, iterations, runOnce) {
  const perRound = []
  for (let r = 0; r < rounds; r++) {
    const row = {}
    for (const [name, f] of rotatedOrder(impls, r)) {
      const batch = pools[name][r + 3]
      const t0 = performance.now()
      for (let j = 0; j < iterations; j++) await runOnce(f, batch[j], opts)
      row[name] = (performance.now() - t0) / iterations
    }
    perRound.push(row)
  }
  return perRound
}

module.exports = { rotatedOrder, buildPools, calibrate, interleaved }
