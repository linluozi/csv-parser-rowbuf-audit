'use strict'
// 共享测试工具：可复现 PRNG、分块器、解析器驱动、统计函数
const path = require('path')

const ROOT = path.join(__dirname, '..')

function load (rel) {
  return require(path.join(ROOT, rel))
}

// mulberry32：可复现伪随机
function rng (seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 按尺寸序列切块（尺寸循环使用）
function chunkBy (buf, sizes) {
  const out = []
  let off = 0
  let k = 0
  while (off < buf.length) {
    const n = sizes[k++ % sizes.length]
    out.push(Buffer.from(buf.subarray(off, off + n)))
    off += n
  }
  return out
}

// 等长切块
function slice (buf, n) {
  const out = []
  for (let i = 0; i < buf.length; i += n) out.push(buf.subarray(i, i + n))
  return out
}

// 驱动一个解析器跑完所有块，收集结果
function runParser (factory, chunks, options) {
  return new Promise((resolve) => {
    const rows = []
    const errors = []
    let headers
    let parser
    try {
      parser = factory(options)
    } catch (e) {
      return resolve({ ctorError: e.name + ': ' + e.message, headers: undefined, rows: [], errors: [] })
    }
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      setImmediate(() => resolve({ headers, rows, errors }))
    }
    parser.on('headers', (v) => { headers = v })
    parser.on('data', (r) => rows.push(r))
    parser.on('error', (e) => errors.push(e.name + ': ' + e.message))
    parser.on('end', finish)
    parser.on('close', finish)
    try {
      for (const c of chunks) parser.write(c)
      parser.end()
    } catch (e) {
      errors.push('THROW ' + e.name + ': ' + e.message)
      finish()
    }
  })
}

// 把解析结果归一化成可比较的 JSON 串
function normalize (res) {
  return JSON.stringify({
    ctorError: res.ctorError || null,
    headers: res.headers === undefined ? '__undefined__' : res.headers,
    rows: res.rows.map((row) => {
      if (Buffer.isBuffer(row)) return { buf: row.toString('latin1') }
      if (row && typeof row === 'object' && row.row !== undefined && row.byteOffset !== undefined) {
        return { row: normalizeRow(row.row), byteOffset: row.byteOffset }
      }
      return normalizeRow(row)
    }),
    errors: res.errors
  })
}

function normalizeRow (row) {
  if (Buffer.isBuffer(row)) return { __buf: row.toString('latin1') }
  const out = {}
  for (const k of Object.keys(row)) {
    out[k] = Buffer.isBuffer(row[k]) ? { __buf: row[k].toString('latin1') } : row[k]
  }
  return out
}

function median (arr) {
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function quantile (arr, p) {
  const s = [...arr].sort((a, b) => a - b)
  const pos = (s.length - 1) * p
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

function stdev (arr) {
  const m = arr.reduce((a, b) => a + b, 0) / arr.length
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length)
}

function round (x, d = 4) {
  return Number(x.toFixed(d))
}

module.exports = {
  ROOT, load, rng, chunkBy, slice, runParser, normalize, median, quantile, stdev, round
}
