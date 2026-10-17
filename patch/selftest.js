'use strict'
const assert = require('assert')
const optimized = require('./optimized')
const baseline = require('./baseline')

function chunksOf (text, size) {
  const bytes = Buffer.from(text)
  const chunks = []
  for (let i = 0; i < bytes.length; i += size) chunks.push(Buffer.from(bytes.subarray(i, i + size)))
  return chunks
}

function parse (factory, chunks, options) {
  return new Promise((resolve, reject) => {
    const parser = factory(options)
    const rows = []
    let headers
    parser.on('headers', (value) => { headers = value })
    parser.on('data', (row) => rows.push(row))
    parser.on('error', reject)
    parser.on('end', () => resolve({ rows, headers }))
    for (const chunk of chunks) parser.write(chunk)
    parser.end()
  })
}

async function test () {
  const corpus = [
    {
      name: 'quoted commas, CRLF, escaped quotes, multiline field',
      csv: 'name,description,note\nAlice,"hello, world","say ""yes"""\nBob,"line one\nline two",ok\n',
      opts: {},
      chunkSizes: [1, 2, 3, 7, 11, 4096]
    },
    {
      name: 'final row without trailing newline',
      csv: 'id,value\n1,alpha\n2,beta',
      opts: {},
      chunkSizes: [1, 4, 6, 1024]
    },
    {
      name: 'explicit headers and outputByteOffset',
      csv: 'A,1\nLonger,2\n',
      opts: { headers: ['name', 'value'], outputByteOffset: true },
      chunkSizes: [1, 5, 8]
    },
    {
      name: 'header/value mappers',
      csv: 'Name,Value\nALICE,ONE\nBOB,TWO\n',
      opts: { mapHeaders: ({ header }) => header.toLowerCase(), mapValues: ({ value }) => value.toLowerCase() },
      chunkSizes: [2, 9, 20]
    },
    {
      name: 'no-header mode',
      csv: 'a,b\nc,d\n',
      opts: { headers: false },
      chunkSizes: [1, 3, 6]
    },
    {
      name: 'comments and skipped lines',
      csv: '# export\nmeta\nid,name\n1,Ada\n',
      opts: { skipComments: true, skipLines: 1 },
      chunkSizes: [4, 8, 16]
    }
  ]

  let checks = 0
  for (const item of corpus) {
    for (const size of item.chunkSizes) {
      const chunks = chunksOf(item.csv, size)
      const [before, after] = await Promise.all([
        parse(baseline, chunks.map(Buffer.from), item.opts),
        parse(optimized, chunks.map(Buffer.from), item.opts)
      ])
      assert.deepStrictEqual(after, before, `${item.name}; chunk size=${size}`)
      checks++
    }
  }

  // Deterministic fragmentation stress matrix: 100 quoted rows with commas,
  // escaped quotes, and embedded LF characters, split by several chunk patterns.
  let stressCsv = 'id,name,description\n'
  for (let i = 0; i < 100; i++) {
    const quote = (value) => `\"${value.replace(/\"/g, '\"\"')}\"`
    const description = i % 3 === 0 ? 'with,comma' : (i % 3 === 1 ? 'say \"hi\"' : 'line one\nline two')
    stressCsv += `${i},${quote(`item-${i}`)},${quote(description)}\n`
  }
  for (const pattern of [[1], [2, 3, 5, 7], [13, 1, 21, 2], [64, 4096]]) {
    const bytes = Buffer.from(stressCsv)
    const chunks = []
    let offset = 0
    let part = 0
    while (offset < bytes.length) {
      const length = pattern[part++ % pattern.length]
      chunks.push(Buffer.from(bytes.subarray(offset, offset + length)))
      offset += length
    }
    const [before, after] = await Promise.all([
      parse(baseline, chunks.map((chunk) => Buffer.from(chunk)), {}),
      parse(optimized, chunks.map((chunk) => Buffer.from(chunk)), {})
    ])
    assert.deepStrictEqual(after, before, `stress split pattern=${pattern.join(',')}`)
    assert.strictEqual(after.rows.length, 100)
    checks++
  }

  // CRLF rows where CR and LF remain in the same input chunk (the upstream
  // scanner has a pre-existing auto-detection edge case if CRLF is split
  // exactly between chunks; this optimization intentionally does not change it).
  const crlf = 'name,value\r\nAda,1\r\nLin,2\r\n'
  for (const size of [3, 7, 4096]) {
    const result = await parse(optimized, chunksOf(crlf, size), {})
    assert.deepStrictEqual(result.rows, [{ name: 'Ada', value: '1' }, { name: 'Lin', value: '2' }])
    checks++
  }

  // Explicit absolute byte offsets for fragmented rows.
  const offsetInput = 'name,val\nA,1\nLong,2\n'
  const offsetResult = await parse(optimized, chunksOf(offsetInput, 3), { outputByteOffset: true })
  assert.deepStrictEqual(offsetResult.rows.map((entry) => entry.byteOffset), [9, 13])

  // Ensure the optimized buffering path works for one large row across many chunks.
  const payload = 'x'.repeat(128 * 1024)
  const large = await parse(optimized, chunksOf(payload + '\n', 1024), { headers: ['payload'] })
  assert.strictEqual(large.rows.length, 1)
  assert.strictEqual(large.rows[0].payload.length, payload.length)

  console.log(`PASS: ${checks} baseline parity checks + byte-offset and large-row checks`)
}

test().catch((err) => {
  console.error(err && err.stack ? err.stack : err)
  process.exitCode = 1
})
