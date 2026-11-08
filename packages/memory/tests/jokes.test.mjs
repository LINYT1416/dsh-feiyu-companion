/**
 * 关系互动：可自定义称呼 + 用户确认后才保存的「我们的梗」。
 * 断言：称呼留空不注入；梗必须显式确认；梗按会话隔离；可列/删；不写进四层记忆。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'cm-jokes-'))
process.env.USERPROFILE = home
process.env.HOME = home
process.env.DSH_HOME = home
process.env.DSH_PROFILE_DIR = join(home, 'profile')
const dataDir = join(home, '.dsh', 'companion-memory')
await mkdir(dataDir, { recursive: true })
const oldAt = new Date(Date.now() - 3 * 3600000).toISOString()
await writeFile(join(dataDir, 'state.json'), JSON.stringify({
  version: 4,
  raw: [{ role: 'user', text: '我们上次说好要一起去看海', at: oldAt, source: 'session-event', confidence: 1, anchor: { sessionId: 'sess-J', eventType: 'user/message', at: oldAt } }],
  facts: [], episodes: [], profile: [], moods: [], sessions: {},
  settings: { enabled: true, activeThinking: false, sevenDayMs: 604800000, injectionChars: 3500 }
}, null, 2), 'utf8')

const mod = await import('../index.js')
const handlers = new Map()
const tools = new Map()
const root = {
  on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name) },
  effect(fn) { const off = fn(); return () => off?.() },
  tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) }, get(name) { return tools.get(name) } },
  systemPrompt: { context() { return () => {} } },
  webServer: { register() { return () => {} } },
  agents: { list: () => [] }
}
mod.apply(root)
await new Promise(resolve => setTimeout(resolve, 120))

const agentCtx = () => {
  const c = { prompts: [] }
  c.on = () => () => {}
  c.tools = { register: () => () => {} }
  c.systemPrompt = { context(spec) { c.prompts.push(spec); return () => {} } }
  return c
}
const J = { id: 'sess-J', ctx: agentCtx() }
handlers.get('agent/created')({ agent: J })
await new Promise(resolve => setTimeout(resolve, 60))
const call = async (tool, args, sessionId) =>
  JSON.parse((await tools.get(tool).execute(args, { agent: { id: sessionId } })).content[0].text)
const injection = () => J.ctx.prompts.at(-1).text()

// 1) 称呼默认不出现
assert.doesNotMatch(injection(), /称呼对方/, '白纸默认不该替用户起称呼')

// 2) 填了称呼才出现，且能清掉
await call('silicon_life_configure', { personaUserAddress: '阿蕤' }, 'sess-J')
assert.match(injection(), /称呼对方：阿蕤/)
await call('silicon_life_configure', { personaUserAddress: '' }, 'sess-J')
assert.doesNotMatch(injection(), /称呼对方/)

// 3) 梗必须显式确认，否则不存
const refused = await call('silicon_life_joke', { action: 'save', text: '拉面梗' }, 'sess-J')
assert.match(refused.error, /confirm/)
assert.equal((await call('silicon_life_joke', { action: 'list' }, 'sess-J')).count, 0)
assert.doesNotMatch(injection(), /拉面梗/)

// 4) 确认后保存、去重、进注入
const saved = await call('silicon_life_joke', { action: 'save', text: '拉面梗', confirm: '记住' }, 'sess-J')
assert.equal(saved.saved, true)
const dup = await call('silicon_life_joke', { action: 'save', text: '拉面梗', confirm: '记住' }, 'sess-J')
assert.equal(dup.duplicate, true)
assert.match(injection(), /拉面梗/)
const status = await call('silicon_life_status', {}, 'sess-J')
assert.equal(status.jokeCount, 1)

// 5) 会话隔离：另一个会话看不到，也数不到
assert.doesNotMatch(await (async () => {
  const other = { id: 'sess-K', ctx: agentCtx() }
  handlers.get('agent/created')({ agent: other })
  return other.ctx.prompts.at(-1).text()
})(), /拉面梗/)
assert.equal((await call('silicon_life_joke', { action: 'list' }, 'sess-K')).count, 0)
assert.equal((await call('silicon_life_status', {}, 'sess-K')).jokeCount, 0)

// 6) 删除
const deleted = await call('silicon_life_joke', { action: 'delete', id: saved.item.id }, 'sess-J')
assert.equal(deleted.deleted, true)
assert.doesNotMatch(injection(), /拉面梗/)

// 7) 不写进四层记忆
const after = await call('silicon_life_status', {}, 'sess-J')
assert.equal(after.counts.facts, 0)
assert.equal(after.counts.profile, 0)

// 8) 上限与错误输入
for (let i = 0; i < 32; i += 1) await call('silicon_life_joke', { action: 'save', text: `梗${i}`, confirm: '记住' }, 'sess-J')
const capped = await call('silicon_life_joke', { action: 'list' }, 'sess-J')
assert.ok(capped.count <= 30, `上限应 ≤30：${capped.count}`)
const tooShort = await call('silicon_life_joke', { action: 'save', text: 'a', confirm: '记住' }, 'sess-J')
assert.match(tooShort.error, /太短/)
const noSession = await call('silicon_life_joke', { action: 'save', text: '光' , confirm: '记住' }, '')
assert.match(noSession.error, /session-bound/)

// 9) 自检仍全绿
const selfTest = await call('silicon_life_self_test', {}, 'sess-J')
assert.equal(selfTest.passed, true, `自检应通过：${JSON.stringify(selfTest.checks)}`)

await rm(home, { recursive: true, force: true })
console.log('jokes test: all assertions passed')
