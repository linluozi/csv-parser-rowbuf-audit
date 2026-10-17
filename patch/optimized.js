// Optimization patch based on mafintosh/csv-parser (MIT).
// Upstream copyright and license are preserved in LICENSE.
const { Transform } = require('stream')

const [cr] = Buffer.from('\r')
const [nl] = Buffer.from('\n')
const defaults = {
  escape: '"', headers: null, mapHeaders: ({ header }) => header,
  mapValues: ({ value }) => value, newline: '\n', quote: '"', raw: false,
  separator: ',', skipComments: false, skipLines: null,
  maxRowBytes: Number.MAX_SAFE_INTEGER, strict: false, outputByteOffset: false
}
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
function sanitizeHeader (header) {
  if (typeof header !== 'string') return null
  if (DANGEROUS_KEYS.has(header)) return null
  return header
}

class CsvParser extends Transform {
  constructor (opts = {}) {
    super({ objectMode: true, highWaterMark: 16 })
    if (Array.isArray(opts)) opts = { headers: opts }
    const options = Object.assign({}, defaults, opts)
    options.customNewline = options.newline !== defaults.newline
    for (const key of ['newline', 'quote', 'separator']) {
      if (typeof options[key] !== 'undefined') ([options[key]] = Buffer.from(options[key]))
    }
    options.escape = (opts || {}).escape ? Buffer.from(options.escape)[0] : options.quote
    this.state = {
      empty: options.raw ? Buffer.alloc(0) : '', escaped: false, first: true,
      lineNumber: 0, previousEnd: 0, rowLength: 0, quoted: false
    }
    // Keep incomplete-row fragments separate. The previous implementation
    // concatenated the entire accumulated row on every _transform call.
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

  // byteOffset is the absolute start of this row. It is supplied by the
  // chunk-aware scanner so outputByteOffset remains correct after buffering.
  parseLine (buffer, start, end, byteOffset) {
    const { customNewline, mapHeaders, mapValues, quote, separator, skipComments, skipLines } = this.options
    end-- // trim newline
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
      this.headers = cells.map((header, index) => {
        const mapped = mapHeaders({ header, index })
        if (mapped === null) return null
        return sanitizeHeader(mapped)
      })
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
    // parseLine expects the end argument to include one character past EOF,
    // matching the upstream _flush convention and its newline trimming.
    this.parseLine(row, 0, row.length + 1, this._rowStartOffset)
    cb()
  }

  _transform (data, enc, cb) {
    if (typeof data === 'string') data = Buffer.from(data)
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
          const tail = data.subarray(segmentStart, i + 1)
          if (this._rowChunks.length > 0) {
            // Join once, only when the logical CSV row is complete.
            const row = Buffer.concat([...this._rowChunks, tail])
            this._rowChunks = []
            this.parseLine(row, 0, row.length, this._rowStartOffset)
          } else {
            this.parseLine(data, segmentStart, i + 1, this._rowStartOffset)
          }
          segmentStart = i + 1
          this._rowStartOffset = chunkOffset + i + 1
          this.state.rowLength = 0
        }
      }
    }

    if (segmentStart < data.length) this._rowChunks.push(data.subarray(segmentStart))
    cb()
  }
}

module.exports = (opts) => new CsvParser(opts)
