'use strict'
// 臂分解：把优化拆成相邻臂，逐个隔离
//   arm1 = 只换碎片列表（每行仍无条件 concat）
//   arm2 = 碎片列表 + 单块零拷贝快路径（= 交付版主体）
//   arm3 = 掏空法骨架臂（同样的扫描 + 缓冲形状，但不解析）
// 输出 results/arms.json
const fs = require('fs')
const path = require('path')
const { performance } = require('perf_hooks')
const { Transform } = require('stream')
const { load, slice, runParser, median, quantile, round } = require('./harness')

const upstream = load('upstream/index.js')
const arm2delivered = load('patch/optimized.js')

const [cr] = Buffer.from('\r')
const [nl] = Buffer.from('\n')

const DEFAULTS = {
  escape: '"',
  headers: null,
  mapHeaders: ({ header }) => header,
  mapValues: ({ value }) => value,
  newline: '\n',
  quote: '"',
  raw: false,
  separator: ',',
  skipComments: false,
  skipLines: null,
  maxRowBytes: Number.MAX_SAFE_INTEGER,
  strict: false,
  outputByteOffset: false
}

function makeClass (transformImpl) {
  return class CsvParser extends Transform {
    constructor (opts = {}) {
      super({ objectMode: true, highWaterMark: 16 })
      if (Array.isArray(opts)) opts = { headers: opts }
      const options = Object.assign({}, DEFAULTS, opts)
      options.customNewline = options.newline !== DEFAULTS.newline
      for (const key of ['newline', 'quote', 'separator']) {
        if (typeof options[key] !== 'undefined') ([options[key]] = Buffer.from(options[key]))
      }
      options.escape = (opts || {}).escape ? Buffer.from(options.escape)[0] : options.quote
      this.state = {
        empty: options.raw ? Buffer.alloc(0) : '',
        escaped: false,
        first: true,
        lineNumber: 0,
        previousEnd: 0,
        rowLength: 0,
        quoted: false
      }
      this._rowChunks = []
      this._rowStartOffset = 0
      if (options.headers === false) options.strict = false
      if (options.headers || options.headers === false) this.state.first = false
      this.options = options
      this.headers = options.headers
      this.bytesRead = 0
    }

    parseCell (buffer, start, end) {
      const { escape, quote } = this.options
      if (buffer[start] === quote && buffer[end - 1] === quote) { start++; end-- }
      let y = start
      for (let i = start; i < end; i++) {
        if (buffer[i] === escape && i + 1 < end && buffer[i + 1] === quote) i++
        if (y !== i) buffer[y] = buffer[i]
        y++
      }
      return this.parseValue(buffer, start, y)
    }

    parseLine (buffer, start, end, byteOffset) {
      const { customNewline, mapHeaders, mapValues, quote, separator, skipComments, skipLines } = this.options
      end--
      if (!customNewline && buffer.length && buffer[end - 1] === cr) end--
      const comma = separator
      const cells = []
      let isQuoted = false
      let offset = start
      if (skipComments) {
        const char = typeof skipComments === 'string' ? skipComments : '#'
        if (buffer[start] === Buffer.from(char)[0]) return
      }
      const mapValue = (value) => {
        if (this.state.first) return value
        const index = cells.length
        const header = this.headers[index]
        return mapValues({ header, index, value })
      }
      for (let i = start; i < end; i++) {
        const isStartingQuote = !isQuoted && buffer[i] === quote
        const isEndingQuote = isQuoted && buffer[i] === quote && i + 1 <= end && buffer[i + 1] === comma
        const isEscape = isQuoted && buffer[i] === this.options.escape && i + 1 < end && buffer[i + 1] === quote
        if (isStartingQuote || isEndingQuote) { isQuoted = !isQuoted; continue } else if (isEscape) { i++; continue }
        if (buffer[i] === comma && !isQuoted) {
          let value = this.parseCell(buffer, offset, i)
          value = mapValue(value)
          cells.push(value)
          offset = i + 1
        }
      }
      if (offset < end) {
        let value = this.parseCell(buffer, offset, end)
        value = mapValue(value)
        cells.push(value)
      }
      if (buffer[end - 1] === comma) cells.push(mapValue(this.state.empty))
      const skip = skipLines && skipLines > this.state.lineNumber
      this.state.lineNumber++
      if (this.state.first && !skip) {
        this.state.first = false
        this.headers = cells.map((header, index) => mapHeaders({ header, index }))
        this.emit('headers', this.headers)
        return
      }
      if (!skip && this.options.strict && cells.length !== this.headers.length) {
        this.emit('error', new RangeError('Row length does not match headers'))
      } else if (!skip) {
        const rowOffset = byteOffset === undefined ? this.bytesRead - buffer.length + start : byteOffset
        this.writeRow(cells, rowOffset)
      }
    }

    parseValue (buffer, start, end) {
      if (this.options.raw) return buffer.slice(start, end)
      return buffer.toString('utf-8', start, end)
    }

    writeRow (cells, byteOffset) {
      const headers = (this.headers === false) ? cells.map((value, index) => index) : this.headers
      const row = cells.reduce((o, cell, index) => {
        const header = headers[index]
        if (header === null) return o
        if (header !== undefined) o[header] = cell
        else o[`_${index}`] = cell
        return o
      }, {})
      if (this.options.outputByteOffset) this.push({ row, byteOffset })
      else this.push(row)
    }

    _flush (cb) {
      if (this.state.escaped || this._rowChunks.length === 0) return cb()
      const row = Buffer.concat(this._rowChunks)
      this._rowChunks = []
      this.parseLine(row, 0, row.length + 1, this._rowStartOffset)
      cb()
    }

    _transform (data, enc, cb) {
      if (typeof data === 'string') data = Buffer.from(data)
      return transformImpl.call(this, data, cb)
    }
  }
}

// ---- arm1：碎片列表，但每行都 concat（无单块快路径） ----
const Arm1 = makeClass(function (data, cb) {
  const { escape, quote } = this.options
  this.bytesRead += data.byteLength
  const chunkOffset = this.bytesRead - data.byteLength
  let segmentStart = 0
  for (let i = 0; i < data.length; i++) {
    const chr = data[i]
    const nextChr = i + 1 < data.length ? data[i + 1] : null
    this.state.rowLength++
    if (this.state.rowLength > this.options.maxRowBytes) return cb(new Error('Row exceeds the maximum size'))
    if (!this.state.escaped && chr === escape && nextChr === quote && i !== 0) {
      this.state.escaped = true
      continue
    } else if (chr === quote) {
      if (this.state.escaped) this.state.escaped = false
      else this.state.quoted = !this.state.quoted
      continue
    }
    if (!this.state.quoted) {
      if (this.state.first && !this.options.customNewline) {
        if (chr === nl) this.options.newline = nl
        else if (chr === cr && nextChr !== nl) this.options.newline = cr
      }
      if (chr === this.options.newline) {
        this._rowChunks.push(data.subarray(segmentStart, i + 1))
        const row = Buffer.concat(this._rowChunks)
        this._rowChunks = []
        this.parseLine(row, 0, row.length, this._rowStartOffset)
        segmentStart = i + 1
        this._rowStartOffset = chunkOffset + i + 1
        this.state.rowLength = 0
      }
    }
  }
  if (segmentStart < data.length) this._rowChunks.push(data.subarray(segmentStart))
  cb()
})

// ---- arm3：掏空法骨架（保留扫描与缓冲形状，不做解析） ----
const Arm3 = makeClass(function (data, cb) {
  const { escape, quote } = this.options
  this.bytesRead += data.byteLength
  const chunkOffset = this.bytesRead - data.byteLength
  let segmentStart = 0
  let sink = 0
  for (let i = 0; i < data.length; i++) {
    const chr = data[i]
    const nextChr = i + 1 < data.length ? data[i + 1] : null
    this.state.rowLength++
    if (!this.state.escaped && chr === escape && nextChr === quote && i !== 0) {
      this.state.escaped = true
      continue
    } else if (chr === quote) {
      if (this.state.escaped) this.state.escaped = false
      else this.state.quoted = !this.state.quoted
      continue
    }
    if (!this.state.quoted) {
      if (this.state.first && !this.options.customNewline) {
        if (chr === nl) this.options.newline = nl
        else if (chr === cr && nextChr !== nl) this.options.newline = cr
      }
      if (chr === this.options.newline) {
        if (this._rowChunks.length > 0) {
          this._rowChunks.push(data.subarray(segmentStart, i + 1))
          const row = Buffer.concat(this._rowChunks)
          this._rowChunks = []
          sink += row.length
        } else {
          sink += i + 1 - segmentStart
        }
        segmentStart = i + 1
        this._rowStartOffset = chunkOffset + i + 1
        this.state.rowLength = 0
      }
    }
  }
  if (segmentStart < data.length) this._rowChunks.push(data.subarray(segmentStart))
  this._sink = sink
  cb()
})

const IMPLS = [
  ['upstream', upstream],
  ['arm1_fragments_only', (o) => new Arm1(o)],
  ['arm2_fragments_fastpath', (o) => new Arm2Wrapper(o)],
  ['arm3_skeleton', (o) => new Arm3(o)]
]

// arm2 用交付版本身，保证与发布代码一致
function Arm2Wrapper (opts) { return arm2delivered(opts) }

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
    name: '7268 行 × 43 B / 4 KiB 块',
    buf: (() => { let s = 'a,b\n'; for (let i = 0; i < 7268; i++) s += `${i},v${i}\n`; return Buffer.from(s) })(),
    chunk: 4 * KIB,
    opts: {}
  }
]

;(async () => {
  const ROUNDS = Number(process.env.ROUNDS || 11)
  const out = []
  console.log(`臂分解：${ROUNDS} 轮交错\n`)
  for (const c of CASES) {
    const proto = slice(c.buf, c.chunk)
    const pools = {}
    for (const [name] of IMPLS) pools[name] = Array.from({ length: ROUNDS + 2 }, () => proto.map((x) => Buffer.from(x)))
    for (const [name, f] of IMPLS) for (let i = 0; i < 2; i++) await runParser(f, pools[name][i], c.opts)

    const samples = {}
    for (const [name] of IMPLS) samples[name] = []
    const ratios = { 'upstream/arm1': [], 'arm1/arm2': [], 'upstream/arm2': [], 'upstream/arm3': [] }

    for (let r = 0; r < ROUNDS; r++) {
      const row = {}
      for (const [name, f] of IMPLS) {
        const t0 = performance.now()
        await runParser(f, pools[name][r + 2], c.opts)
        row[name] = performance.now() - t0
        samples[name].push(row[name])
      }
      ratios['upstream/arm1'].push(row.upstream / row.arm1_fragments_only)
      ratios['arm1/arm2'].push(row.arm1_fragments_only / row.arm2_fragments_fastpath)
      ratios['upstream/arm2'].push(row.upstream / row.arm2_fragments_fastpath)
      ratios['upstream/arm3'].push(row.upstream / row.arm3_skeleton)
    }

    const rec = { name: c.name, chunks: proto.length, mediansMs: {}, ratios: {} }
    for (const [name] of IMPLS) rec.mediansMs[name] = round(median(samples[name]), 3)
    for (const k of Object.keys(ratios)) {
      rec.ratios[k] = {
        median: round(median(ratios[k]), 3),
        p10: round(quantile(ratios[k], 0.1), 3),
        p90: round(quantile(ratios[k], 0.9), 3)
      }
    }
    rec.parseSharePct = round((1 - median(samples.arm3_skeleton) / median(samples.upstream)) * 100, 1)
    out.push(rec)

    console.log(`### ${c.name}  (${proto.length} 块)`)
    for (const [name] of IMPLS) console.log(`  ${name.padEnd(24)} ${rec.mediansMs[name].toFixed(2).padStart(9)} ms`)
    for (const k of Object.keys(ratios)) {
      const r = rec.ratios[k]
      console.log(`  ${k.padEnd(16)} ${r.median.toFixed(3)}×  p10–p90 ${r.p10.toFixed(3)}–${r.p90.toFixed(3)}`)
    }
    console.log(`  → 解析占 ${rec.parseSharePct}%（掏空法骨架臂）`)
    console.log('')
  }
  fs.writeFileSync(path.join(__dirname, '..', 'results', 'arms.json'), JSON.stringify(out, null, 2) + '\n')
  console.log('已写 results/arms.json')
})()
