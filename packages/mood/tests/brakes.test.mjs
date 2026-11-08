/**
 * 刹车自检：风险文档里写的那五条，必须真的在代码里生效。
 * 1) 状态爆炸：情绪 ≤3、账本 ≤4、心理四维、注入只写 1 笔账
 * 2) 过度解释：注入里要有「别补细节/别编」这句
 * 3) 喜怒无常：一小时内的位移有额度、心境被夹在基线 ±0.75
 * 4) 注入膨胀：维度最多 2 个、账本 1 笔
 * 5) 和人格打架：无论怎么刷，心境都回不到基线外的人格外
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = await mkdtemp(join(tmpdir(), 'moodv2-brakes-'))
process.env.DSH_HOME = home

const mod = await import('../index.js')
const sections = []
let service = null
const handlers = new Map()
const ctx = {
  on(name, fn) { handlers.set(name, fn); return () => {} },
  effect(fn) { const off = fn(); return () => off?.() },
  systemPrompt: { context(section) { sections.push(section); return () => {} } },
  webServer: { register() { return () => {} } },
  provide(name, value) { if (name === 'moodV2') service = value },
}
mod.apply(ctx, { enabled: true })
const line = () => sections.at(-1).text()
const send = async text => {
  handlers.get('session/event')({ id: 's' }, { type: 'user/message', data: { text } })
  await new Promise(r => setTimeout(r, 20))
}

// 1) 连刷难听话：情绪、账本、位移都得有上限
for (let i = 0; i < 15; i += 1) await send('滚，闭嘴，烦死了，讨厌你，别烦我')
const read = service.read()
assert.ok(read.emotions.length <= 3, `情绪最多 3 条：${JSON.stringify(read.emotions)}`)
assert.ok(read.ledger.length <= 1, `注入口径只留 1 笔账：${JSON.stringify(read.ledger)}`)
assert.ok(Math.abs(read.valence) <= 0.86, `心境不能跑到天边：${read.valence}`)
assert.ok(read.valence >= -1 && read.valence <= 1)

// 2) 注入：账本最多一行、维度最多两个、反虚构那句在
const text = line()
const ledgerLines = text.split('\n').filter(row => row.startsWith('心里还压着')).length
assert.ok(ledgerLines <= 1, `注入里账本最多一行：${text}`)
assert.match(text, /别补细节|别编/, '注入里必须有反虚构这条')
const dims = (text.match(/偏高|偏低/g) || []).length
assert.ok(dims <= 2, `维度最多两个：${text}`)

// 3) 一小时内的位移额度：连续再体验也推不动多少
const before = service.read().valence
for (let i = 0; i < 10; i += 1) service.recollect({ text: `刷屏回忆 ${i}`, valence: -1 })
const after = service.read().valence
assert.ok(before - after <= 0.65, `一小时内位移有额度（实际 ${(before - after).toFixed(2)}）`)
assert.ok(after >= -0.76, `再刷也不会掉出基线 ±0.75：${after}`)

// 4) 心理四维永远在 -1..1
for (const [dim, value] of Object.entries(service.read().mind)) {
  assert.ok(value >= -1 && value <= 1, `${dim} 越界：${value}`)
}

await new Promise(r => setTimeout(r, 120))
await rm(home, { recursive: true, force: true }).catch(() => {})
console.log('brakes test: all assertions passed')
