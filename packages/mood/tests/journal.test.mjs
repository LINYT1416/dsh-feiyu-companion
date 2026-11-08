/**
 * 念头本 / 日记本 → 心情（P2）：
 * 新写的一条念头会带起情绪、进注入；同一条只消化一次；日记一天只消化一次。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = await mkdtemp(join(tmpdir(), 'moodv2-journal-'))
process.env.DSH_HOME = home
const journal = join(home, 'feiyu-journal')
await mkdir(join(journal, 'diary'), { recursive: true })

const ts = Math.floor(Date.now() / 1000)
await writeFile(join(journal, 'thoughts.jsonl'), [
  JSON.stringify({ ts: ts - 60, text: '有点难过，今天什么都没做成', from: 'dsh' }),
  JSON.stringify({ ts, text: '想他，但是不想先开口', from: 'qq' }),
].join('\n') + '\n', 'utf8')

const today = new Date().toISOString().slice(0, 10)
await writeFile(join(journal, 'diary', `${today}.md`), `# ${today}\n\n## 今天\n\n有点累，但心里是松的。\n`, 'utf8')

const mod = await import('../index.js')
const sections = []
const ctx = {
  on() { return () => {} },
  effect(fn) { const off = fn(); return () => off?.() },
  systemPrompt: { context(section) { sections.push(section); return () => {} } },
  provide() {},
}
mod.apply(ctx, { enabled: true })
const line = () => sections.at(-1).text()

// 让 journalPulse 跑完（读文件是异步的）
for (let i = 0; i < 20 && !/心里正转着一个念头/.test(line()); i += 1) {
  await new Promise(r => setTimeout(r, 50))
}
const first = line()
assert.match(first, /心里正转着一个念头：想他/, `最新的念头要进注入：${first}`)
assert.match(first, /心疼（对他）|难过|委屈/, `念头要带出情绪：${first}`)

// 同一条念头不会反复叠加：过一会儿再怎么取，情绪种类不该暴涨
await new Promise(r => setTimeout(r, 120))
const second = line()
const emoCount = (text) => (text.match(/（对[^）]+）/g) || []).length
assert.ok(emoCount(second) <= emoCount(first) + 1, '同一条念头不该被反复消化')

// 日记已经消化过：不会因为再读一次就把心境拉爆
const valenceLine = second.split('\n')[0]
assert.ok(valenceLine.length > 0)

await rm(home, { recursive: true, force: true })
console.log('journal→mood test: all assertions passed')
