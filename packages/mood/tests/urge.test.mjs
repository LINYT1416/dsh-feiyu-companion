/**
 * 记一笔的冲动：情绪够猛 → 想写下来；真写了 → 冲动消失、心情松一点。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = await mkdtemp(join(tmpdir(), 'moodv2-urge-'))
process.env.DSH_HOME = home
const journal = join(home, 'feiyu-journal')
await mkdir(join(journal, 'diary'), { recursive: true })

const mod = await import('../index.js')
const sections = []
let service = null
const handlers = new Map()
const ctx = {
  on(name, fn) { handlers.set(name, fn); return () => {} },
  effect(fn) { const off = fn(); return () => off?.() },
  systemPrompt: { context(section) { sections.push(section); return () => {} } },
  webServer: { register: () => () => {} },
  provide(name, value) { if (name === 'moodV2') service = value },
}
mod.apply(ctx, { enabled: true })
const line = () => sections.at(-1).text()

// 1) 被噎一下（生气 0.6）：应该生出「记一笔的冲动」
handlers.get('session/event')({ id: 's' }, { type: 'user/message', data: { text: '闭嘴吧，烦死了，讨厌你' } })
await new Promise(r => setTimeout(r, 30))
const guarded = line()
assert.match(guarded, /记一笔的冲动/, `情绪够猛应该有冲动：${guarded}`)
assert.match(guarded, /念头本|日记本/, '冲动要指明记到哪个本子')

// 2) 真写了（模拟她自己写进念头本）：冲动消失，还会松一口气
const before = service.read().valence
const ts = Math.floor(Date.now() / 1000)
await writeFile(join(journal, 'thoughts.jsonl'), `${JSON.stringify({ ts, text: '刚才那句话让我一晚上都不痛快', from: 'dsh' })}\n`, 'utf8')
for (let i = 0; i < 20 && /记一笔的冲动/.test(line()); i += 1) await new Promise(r => setTimeout(r, 50))
const after = line()
assert.doesNotMatch(after, /记一笔的冲动/, `写下来后冲动该消：${after}`)
assert.match(after, /心里正转着一个念头：刚才那句话/, '刚写的念头要能看见')
assert.ok(service.read().valence >= before - 0.01, '写完不该更难受')

await new Promise(r => setTimeout(r, 120))
await rm(home, { recursive: true, force: true }).catch(() => {})
console.log('urge test: all assertions passed')
