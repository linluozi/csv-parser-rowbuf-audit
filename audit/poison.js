'use strict'
// 反向喂毒：向交付版注入已知缺陷，看它自带的测试能否抓到
// 对每个漏检项再做一次「是否真改变行为」的反证，区分「测试有洞」与「等价变更」
// 输出 results/poison.json
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const crypto = require('crypto')
const { load, runParser, normalize } = require('./harness')

const ROOT = path.join(__dirname, '..')
const TARGET = path.join(ROOT, 'patch', 'optimized.js')
const TEST_DIR = path.join(ROOT, 'patch')
const upstream = load('upstream/index.js')

const ORIGINAL = fs.readFileSync(TARGET, 'utf8')
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex')
const ORIG_SHA = sha1(ORIGINAL)

const MUTANTS = [
  {
    id: 'M1',
    desc: '删掉 _flush 的 fragment 拼接（EOF 残留行丢弃）',
    from: 'if (this.state.escaped || this._rowChunks.length === 0) return cb()',
    to: 'if (true) return cb()'
  },
  {
    id: 'M2',
    desc: '行起始偏移用 chunk 内偏移代替绝对偏移',
    from: 'this._rowStartOffset = chunkOffset + i + 1',
    to: 'this._rowStartOffset = i + 1'
  },
  {
    id: 'M3',
    desc: '跨块行的 byteOffset 传 0',
    from: 'this.parseLine(row, 0, row.length, this._rowStartOffset)',
    to: 'this.parseLine(row, 0, row.length, 0)'
  },
  {
    id: 'M4',
    desc: '单块快路径 end 少传一个（行尾被吃掉）',
    from: 'this.parseLine(data, segmentStart, i + 1, this._rowStartOffset)',
    to: 'this.parseLine(data, segmentStart, i, this._rowStartOffset)'
  },
  {
    id: 'M5',
    desc: '漏掉末尾残片入队',
    from: 'if (segmentStart < data.length) this._rowChunks.push(data.subarray(segmentStart))',
    to: 'if (segmentStart < data.length) { /* dropped */ }'
  },
  {
    id: 'M6',
    desc: 'maxRowBytes 判定失效（静默返回超长行）',
    from: "if (this.state.rowLength > this.options.maxRowBytes) return cb(new Error('Row exceeds the maximum size'))",
    to: 'void 0',
    probe: { chunks: ['x'.repeat(40) + '\n'], opts: { headers: ['a'], maxRowBytes: 10 } }
  },
  {
    id: 'M7',
    desc: '单块快路径条件反转（有残片时走单块路径）',
    from: 'if (this._rowChunks.length > 0) {',
    to: 'if (this._rowChunks.length === 0) {'
  },
  {
    id: 'M8',
    desc: 'escape 判断 i !== 0 → i !== segmentStart',
    from: 'chr === escape && nextChr === quote && i !== 0',
    to: 'chr === escape && nextChr === quote && i !== segmentStart',
    probe: { chunks: ["h\na,b\n\\'x,y\n"], opts: { quote: "'", escape: '\\' } }
  },  {
    id: 'M9',
    desc: '_rowStartOffset 初值错（0 → 1）',
    from: 'this._rowStartOffset = 0',
    to: 'this._rowStartOffset = 1'
  },
  {
    id: 'M10',
    desc: '删掉被测文件本身',
    deleteFile: true
  }
]

// 包自带测试（这里用 patch/selftest.js 复刻包内 test/run.js）
function runSelfTest () {
  try {
    const out = execFileSync(process.execPath, [path.join(TEST_DIR, 'selftest.js')], { encoding: 'utf8', stdio: 'pipe' })
    return { ok: true, out: out.trim() }
  } catch (e) {
    return { ok: false, out: ((e.stdout || '') + (e.stderr || '')).trim().split('\n').slice(0, 2).join(' | ') }
  }
}

// 判定注入是否真的改变了行为（对比真上游）
// 🔴 必须清 require 缓存：否则拿到的是上一次 mutate 前/后的旧模块
async function behaviorDiffers (probe) {
  const target = path.join(ROOT, 'patch', 'optimized.js')
  delete require.cache[require.resolve(target)]
  const mutated = require(target)
  const chunks = probe.chunks.map((c) => Buffer.from(c, 'binary'))
  const base = normalize(await runParser(upstream, chunks.map((c) => Buffer.from(c)), probe.opts))
  const got = normalize(await runParser(mutated, chunks.map((c) => Buffer.from(c)), probe.opts))
  return { differs: base !== got, expected: base, got }
}

;(async () => {
  console.log('反向喂毒：向交付版注入缺陷，看包自带测试能否抓到\n')
  console.log(`原始 sha1 = ${ORIG_SHA}`)

  const baseline = runSelfTest()
  console.log(`基线: ${baseline.ok ? 'PASS' : 'FAIL'}  ${baseline.out.slice(0, 90)}`)
  if (!baseline.ok) {
    console.log('!! 基线不通过，喂毒结论无效')
    process.exitCode = 1
    return
  }

  const results = []
  for (const m of MUTANTS) {
    let applied = false
    let note = ''
    if (m.deleteFile) {
      fs.renameSync(TARGET, TARGET + '.bak')
      applied = true
    } else if (!ORIGINAL.includes(m.from)) {
      note = '注入点未找到'
    } else {
      fs.writeFileSync(TARGET, ORIGINAL.replace(m.from, m.to))
      applied = true
    }

    let testResult
    let valid = null
    if (applied) {
      testResult = runSelfTest()
      // 漏检时，判定是否真改变行为（区分「真盲区」与「等价变更」）
      if (testResult.ok && m.probe) {
        const d = await behaviorDiffers(m.probe)
        valid = d.differs
      }
    } else {
      testResult = { ok: true, out: note }
    }

    if (m.deleteFile) fs.renameSync(TARGET + '.bak', TARGET)
    else fs.writeFileSync(TARGET, ORIGINAL)

    const caught = applied && !testResult.ok
    // 判定分类
    let verdict
    if (!applied) verdict = 'skipped'
    else if (caught) verdict = 'caught'
    else if (valid === true) verdict = 'missed_valid'   // 真盲区：行为变了却没抓到
    else if (valid === false) verdict = 'missed_equivalent' // 等价变更，不算测试有洞
    else verdict = 'missed_unprobed'

    results.push({ id: m.id, desc: m.desc, applied, caught, verdict, output: testResult.out.slice(0, 160) })

    const label = { caught: '抓到', missed_valid: '漏掉(有效毒)', missed_equivalent: '漏掉(等价)', missed_unprobed: '漏掉(未反证)', skipped: '跳过' }[verdict]
    console.log(`${label.padEnd(14)} ${m.id}  ${m.desc}`)
    if (verdict === 'missed_valid') console.log(`               → 已反证：该改动确实改变输出（上游与毒版不一致）`)
  }

  const restored = sha1(fs.readFileSync(TARGET, 'utf8'))
  console.log(`\n恢复后 sha1 = ${restored}  ${restored === ORIG_SHA ? '✓ 一致' : '✗ 不一致 !!'}`)

  const caughtN = results.filter((r) => r.verdict === 'caught').length
  const missedValid = results.filter((r) => r.verdict === 'missed_valid')
  console.log(`喂毒结果：${caughtN}/${MUTANTS.length} 抓住，其中 ${missedValid.length} 项确认为真盲区`)

  fs.writeFileSync(path.join(ROOT, 'results', 'poison.json'), JSON.stringify({
    originalSha1: ORIG_SHA,
    mutants: MUTANTS.length,
    caught: caughtN,
    missedValid: missedValid.map((r) => r.id),
    results
  }, null, 2) + '\n')
  console.log('已写 results/poison.json')

  if (restored !== ORIG_SHA) process.exitCode = 1
})()
