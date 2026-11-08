/**
 * 此刻的心理（P0）：不因每条消息机械变化；分「心里/表面」；情绪带对象；
 * 心理四维；未结清账本；回忆唤起每天每条约一次；全局共享。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = await mkdtemp(join(tmpdir(), 'moodv2-'))
process.env.DSH_HOME = home

const mod = await import('../index.js')
const handlers = new Map()
const sections = []
let service = null
const ctx = {
  on(name, fn) { handlers.set(name, fn); return () => {} },
  effect(fn) { const off = fn(); return () => off?.() },
  systemPrompt: { context(section) { sections.push(section); return () => {} } },
  provide(name, value) { if (name === 'moodV2') service = value },
}
mod.apply(ctx, { enabled: true })

const line = () => sections.at(-1).text()
const send = async text => {
  handlers.get('session/event')({ id: 's' }, { type: 'user/message', data: { text } })
  await new Promise(r => setTimeout(r, 40))
}
const read = () => service.read()

// 1) 基本形态：心里、表面都在，不是每条消息都重算
assert.match(line(), /心里/)
assert.match(line(), /表面/)
assert.match(line(), /心情不是每条消息都重新算/)

// 2) 被夸：心境变好，冒出「开心（对他）」，社交电量上来
await send('你今天好可爱，我好喜欢你')
const happy = read()
assert.ok(happy.emotions.some(item => item.kind === '开心'), `被夸应有开心：${JSON.stringify(happy.emotions)}`)
assert.ok(happy.mind.social > 0, '被夸后社交电量应该上来')

// 3) 被噎：情绪转负面，表面开始装，账本记一笔
for (let i = 0; i < 3; i += 1) await send('闭嘴吧，烦死了，讨厌你')
const upset = read()
assert.ok(upset.valence < 0, '被噎后心境应该变差')
assert.match(line(), /嘴|收着|装/, '表面应该开始装')
assert.ok(upset.ledger.length > 0, '被噎要记一笔没结清的账')
assert.match(line(), /没放下的事/, '注入里要提这笔账')

// 4) 道歉清账
await send('对不起，刚才我说话冲了')
const calmed = read()
assert.equal(calmed.ledger.length, 0, '道歉后账要清掉')
assert.ok(calmed.mind.guard < upset.mind.guard, '清账后防备应该降')

// 5) 回忆唤起：同一条记忆一天只算一次
const originalRandom = Math.random
const first = service.recollect({ text: '去年冬天在便利店门口等你的那晚', valence: -0.8 })
assert.equal(first.ok, true, '第一次想起应该生效')
const again = service.recollect({ text: '去年冬天在便利店门口等你的那晚', valence: -0.8 })
assert.equal(again.ok, false, '同一条记忆同一天只算一次')
assert.match(line(), /刚想起：|想起：/, '注入里应该看得到刚想起什么')
Math.random = originalRandom

// 7) 反刍：连着想起第三件不痛快的旧事，耐心会掉、会标 rumination
const patienceBefore = read().mind.patience
service.recollect({ text: '那次没说出口的话', valence: -0.7 })
const third = service.recollect({ text: '那次没赶上的车', valence: -0.75 })
assert.equal(third.rumination, true, '连着第三件负面旧事应该判为反刍')
assert.ok(read().mind.patience < patienceBefore, '反刍后耐心应该下降')
assert.match(line(), /想起：|情绪沉下去了/, '反刍也要在注入里留痕')

// 6) 心理维度有上限，不会被刷爆
for (let i = 0; i < 20; i += 1) await send('滚，闭嘴，烦死了')
const wild = read()
for (const [dim, value] of Object.entries(wild.mind)) {
  assert.ok(value >= -1 && value <= 1, `${dim} 越界了：${value}`)
}

// 7) 落盘：情绪、心理、账本、轨迹都在
await new Promise(r => setTimeout(r, 100))
const saved = JSON.parse(await readFile(join(home, 'mood-v2', 'state.json'), 'utf8'))
assert.equal(saved.v, 2)
assert.ok(Array.isArray(saved.emotions) && Array.isArray(saved.ledger) && Array.isArray(saved.mind ? [saved.mind] : []))
assert.ok(saved.events.length > 0)

await rm(home, { recursive: true, force: true })
console.log('mood-v2 test: all assertions passed')
