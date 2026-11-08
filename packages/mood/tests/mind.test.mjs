/**
 * 心理维度更全（P7）：除了社交电量/耐心/防备/想被哄，还有自尊与专注。
 * 被否定会掉自尊，被夸会涨，被催会散掉专注。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = await mkdtemp(join(tmpdir(), 'moodv2-pride-'))
process.env.DSH_HOME = home

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
const send = async text => {
  handlers.get('session/event')({ id: 's' }, { type: 'user/message', data: { text } })
  await new Promise(r => setTimeout(r, 30))
}
const read = () => service.read()

// 1) 六个维度都在，且都是 -1..1
const dims = Object.keys(read().mind)
for (const dim of ['social', 'patience', 'guard', 'comfort', 'pride', 'focus']) {
  assert.ok(dims.includes(dim), `应该有 ${dim} 这一维：${dims}`)
  assert.ok(Math.abs(read().mind[dim]) <= 1, `${dim} 越界`)
}

// 2) 被否定：自尊掉，并且会产生羞耻
const before = read()
const beforePride = before.mind.pride || 0
await send('你怎么这么笨，这点事都做不好，算了指望不上你')
const hurt = read()
assert.ok((hurt.mind.pride || 0) < beforePride, `被否定要掉自尊：${beforePride} -> ${hurt.mind.pride}`)
assert.ok((hurt.emotions || []).some(item => item.kind === '羞耻'), `要有羞耻：${JSON.stringify(hurt.emotions)}`)

// 3) 被夸：自尊涨回来
await send('说真的你太强了，我服了你了')
const praised = read()
assert.ok((praised.mind.pride || 0) > (hurt.mind.pride || 0), '被夸要涨自尊')

// 4) 被催：专注掉、耐心掉
const beforeFocus = read().mind.focus || 0
const beforePatience = read().mind.patience || 0
await send('快点快点，别废话，说重点，来不及了')
const rushed = read()
assert.ok((rushed.mind.focus || 0) < beforeFocus, '被催要散掉专注')
assert.ok((rushed.mind.patience || 0) <= beforePatience, '被催耐心不该涨')

// 5) 注入里能看见新维度（至少有一个被点名）
const text = line()
assert.ok(/自尊|专注/.test(text), `六个维度里总该有一个被写进注入：${text}`)

// 6) 注入别变成心理报告：最多两维
const dimCount = (text.match(/偏高|偏低/g) || []).length
assert.ok(dimCount <= 2, `注入最多两维：${text}`)

await new Promise(r => setTimeout(r, 100))
await rm(home, { recursive: true, force: true }).catch(() => {})
console.log('mind dims test: all assertions passed')
