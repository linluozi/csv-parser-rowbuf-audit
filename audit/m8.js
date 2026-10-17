'use strict'
// M8 精确判定：把「漏检项是否真的改变行为」写成可复现脚本，不用 node -e 拼引号
const fs = require('fs')
const path = require('path')
const { load, runParser, normalize } = require('./harness')

const ROOT = path.join(__dirname, '..')
const TARGET = path.join(ROOT, 'patch', 'optimized.js')
const upstream = load('upstream/index.js')

const ORIGINAL = fs.readFileSync(TARGET, 'utf8')
const FROM = 'chr === escape && nextChr === quote && i !== 0'
const TO = 'chr === escape && nextChr === quote && i !== segmentStart'

const CASES = [
  { label: '单块内第二行行首 escape', text: "h\na,b\n\\'x,y\n", opts: { quote: "'", escape: '\\' } },
  { label: '单块内首行行首 escape', text: "h\n\\'x\n", opts: { quote: "'", escape: '\\' } },
  { label: '三行，第三行行首 escape', text: "a\nb\nc\\'d,e\n", opts: { quote: "'", escape: '\\' } },
  { label: '默认双引号，行首双引号', text: 'h\n""x\n', opts: {} },
  { label: '自定义 quote+escape 跨块', text: "h\nab\\", opts: { quote: "'", escape: '\\' } }
]

;(async () => {
  console.log('M8 判定：`i !== 0` → `i !== segmentStart` 是否真改变行为\n')
  const out = []
  for (const c of CASES) {
    const buf = Buffer.from(c.text, 'binary')
    const base = normalize(await runParser(upstream, [Buffer.from(buf)], c.opts))
    const good = normalize(await runParser(load('patch/optimized.js'), [Buffer.from(buf)], c.opts))

    fs.writeFileSync(TARGET, ORIGINAL.replace(FROM, TO))
    delete require.cache[require.resolve(TARGET)]
    const bad = normalize(await runParser(load('patch/optimized.js'), [Buffer.from(buf)], c.opts))
    fs.writeFileSync(TARGET, ORIGINAL)
    delete require.cache[require.resolve(TARGET)]

    const rec = { label: c.label, text: c.text, upstream: base, optimized: good, mutated: bad, optimizedMatchesUpstream: base === good, mutatedDiffers: base !== bad }
    out.push(rec)
    console.log(`### ${c.label}`)
    console.log(`  upstream  ${base}`)
    console.log(`  optimized ${good}   ${base === good ? '✓ 与上游一致' : '✗ 与上游不一致'}`)
    console.log(`  mutated   ${bad}   ${base === bad ? '（等价，非有效毒）' : '（不等价 ⇒ 有效毒）'}`)
    console.log('')
  }
  fs.writeFileSync(path.join(ROOT, 'results', 'm8.json'), JSON.stringify(out, null, 2) + '\n')
  console.log('已写 results/m8.json')
})()
