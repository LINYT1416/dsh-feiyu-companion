/**
 * 跨会话隔离与记忆行为回归（不碰真实记忆：HOME/USERPROFILE 指向临时目录）
 * 覆盖：早期记忆注入带时间、10 分钟内新消息不重复注入、召回隔离、
 *       伪造 crossSession 无效、raw 不可变、可变层按会话清除、无会话拒绝写入。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'cm-isolation-'))
process.env.USERPROFILE = home
process.env.HOME = home

const dataDir = join(home, '.dsh', 'companion-memory')
await mkdir(dataDir, { recursive: true })
const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString()
// 预置「很久以前」的记忆：注入应该带出来并标注时间。
await writeFile(join(dataDir, 'state.json'), JSON.stringify({
  version: 4,
  raw: [
    { role: 'user', text: 'A 很早以前说只想吃拉面', at: hoursAgo(3), source: 'session-event', confidence: 1, anchor: { sessionId: 'sess-A', eventType: 'user/message', at: hoursAgo(3) } },
    { role: 'user', text: 'B 很早以前计划去爬山', at: hoursAgo(3), source: 'session-event', confidence: 1, anchor: { sessionId: 'sess-B', eventType: 'user/message', at: hoursAgo(3) } }
  ],
  facts: [
    { text: 'A 养了一只叫年糕的猫', at: hoursAgo(3), source: 'auto-self-fact', confidence: 0.6, mood: { label: '很好', score: 88, source: 'feiyu-mood', at: hoursAgo(3) }, anchor: { sessionId: 'sess-A', eventType: 'user/message', at: hoursAgo(3) } }
  ],
  // B 被显式绑定为主记忆为 A：只能读到 A 的长期记忆，读不到 A 的原话。
  sessions: { 'sess-B': { recent: [], readsFrom: ['sess-A'] } },
  settings: { enabled: true, activeThinking: false, sevenDayMs: 604800000, injectionChars: 3500 }
}, null, 2), 'utf8')

const mod = await import('../index.js')

function makeCtx() {
  const handlers = new Map()
  const tools = new Map()
  const prompts = []
  return {
    handlers, prompts,
    on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name) },
    effect(fn) { const off = fn(); return () => off?.() },
    systemPrompt: { context(spec) { prompts.push(spec); return () => {} } },
    webServer: { register() { return () => {} } },
    agents: { list: () => [] },
    _tools: tools
  }
}

const root = makeCtx()
root.tools = {
  register(tool) { root._tools.set(tool.name, tool); return () => root._tools.delete(tool.name) },
  get(name) { return root._tools.get(name) },
  schemas() { return [...root._tools.values()].map(tool => ({ name: tool.name })) }
}
mod.apply(root)
// load() 是异步的：等它把预置的旧记忆读进来再做注入断言。
await new Promise(resolve => setTimeout(resolve, 100))

const emit = async (name, ...args) => {
  const fn = root.handlers.get(name)
  assert.ok(fn, `handler for ${name} must be registered`)
  return fn(...args)
}

const agentCtx = () => {
  const c = { prompts: [] }
  c.on = () => () => {}
  c.tools = { register: () => () => {} }
  c.systemPrompt = { context(spec) { c.prompts.push(spec); return () => {} } }
  return c
}

const A = { id: 'sess-A', ctx: agentCtx() }
const B = { id: 'sess-B', ctx: agentCtx() }
await emit('agent/created', { agent: A })
await emit('agent/created', { agent: B })

const call = async (tool, args, sessionId) =>
  JSON.parse((await root._tools.get(tool).execute(args, { agent: { id: sessionId } })).content[0].text)

// 1) 早期记忆会注入，带相对时间，且不含别的会话
const textA = A.ctx.prompts.at(-1).text()
const textB = B.ctx.prompts.at(-1).text()
assert.match(textA, /拉面/, 'A 的注入应带出 A 自己更早的话')
assert.match(textA, /小时前/, '注入的记忆必须带相对时间')
assert.doesNotMatch(textA, /爬山/, 'A 的注入绝不能出现 B 的话')
assert.match(textB, /爬山/, 'B 的注入应带出 B 自己更早的话')
assert.doesNotMatch(textB, /拉面/, 'B 的注入绝不能出现 A 的原话')

// 1b) 显式绑定主记忆：B 能看到 A 的长期记忆（带来源和当时心情），但仍然看不到 A 的原话
assert.match(textB, /年糕/, '绑定主记忆后 B 应能读到 A 的事实')
assert.match(textB, /来自主记忆/, '共享来的记忆必须标明来源')
assert.match(textB, /当时心情/, '共享来的记忆应带上记录时的心情')
assert.doesNotMatch(textA, /爬山/, '绑定是单向的：A 不该因此看到 B')

// 2) 刚说过的话不重复注入（避免「记忆」只是复读），但召回能查到
await emit('session/event', { id: 'sess-A', header: { id: 'sess-A' } }, { type: 'user/message', data: { text: 'A 刚刚说现在想喝汤' } })
const freshTextA = A.ctx.prompts.at(-1).text()
assert.doesNotMatch(freshTextA, /现在想喝汤/, '10 分钟内的话不应再注入一遍')
const recallFresh = await call('silicon_life_recall', { query: '喝汤' }, 'sess-A')
assert.ok(recallFresh.matches.length > 0, '刚说的话仍然要能被召回')

// 3) 召回不跨会话
const recallA = await call('silicon_life_recall', { query: '爬山' }, 'sess-A')
assert.equal(recallA.matches.length, 0, 'A 召回「爬山」不该命中 B 的记录')
const recallB = await call('silicon_life_recall', { query: '爬山' }, 'sess-B')
assert.ok(recallB.matches.length > 0, 'B 应该能召回自己的记录')

// 4) 伪造旧参数也跨不过去，schema 里也没有这个参数
const attemptedCross = await call('silicon_life_recall', { query: '爬山', crossSession: true }, 'sess-A')
assert.equal(attemptedCross.matches.length, 0, 'A 伪造 crossSession 也不得读到 B 的记录')
assert.equal(attemptedCross.isolated, true)
const recallSchema = root._tools.get('silicon_life_recall').parameters.properties
assert.equal(Object.hasOwn(recallSchema, 'crossSession'), false, '工具 schema 不应暴露跨会话参数')

// 5) 自述会自动沉淀成事实，且只落在本会话
await emit('session/event', { id: 'sess-A', header: { id: 'sess-A' } }, { type: 'user/message', data: { text: '我养了一只叫年糕的猫' } })
const factsA = await call('silicon_life_status', {}, 'sess-A')
const factsB = await call('silicon_life_status', {}, 'sess-B')
assert.ok(factsA.counts.facts >= 1, '自述应该被记成事实')
assert.equal(factsB.counts.facts, 0, 'B 不该出现 A 的事实')
assert.match(factsA.summary, /年糕|猫/, '状态摘要里应能看到记下的事')

// 5b) 记忆要带上当时的心情（本轮没有心情源时应能优雅缺省，不报错）
const factRecall = await call('silicon_life_recall', { query: '年糕' }, 'sess-A')
assert.ok(factRecall.matches.length > 0, '事实应可召回')
const factRow = factRecall.matches.find(item => item.bucket === 'facts')
assert.ok(factRow, '召回结果应包含 facts 层')
assert.ok(!('mood' in factRow) || typeof factRow.mood === 'object', '心情字段要么没有，要么是对象')

// 5c) 运行期新建的 Agent（QQ 桥这类外部渠道）也要拿到同样的能力
const C = { id: 'sess-C', ctx: agentCtx() }
await emit('agent/created', { agent: C })
const promptC = C.ctx.prompts.at(-1)
assert.ok(promptC, '运行期新建的 Agent 应注册注入')
// 白纸人格 + 这个会话没有记忆 → 注入理应是空的（宁可不写，也不硬塞人格）。
assert.equal(promptC.text(), '', '空会话 + 白纸人格时不该注入任何内容')
assert.equal(promptC.text().includes('爬山'), false, '新 Agent 更不能看到别的会话的话')
const statusC = await call('silicon_life_status', {}, 'sess-C')
assert.equal(statusC.isolated, true, '新 Agent 的工具必须绑定到它自己的会话')
assert.equal(statusC.counts.raw, 0, '新 Agent 不应看到别的会话的记录')

// 5d) 编年史：整理时把「今天做过什么」压成一条日记，注入里能看到
await call('silicon_life_consolidate', { ageDays: 0 }, 'sess-A')
const afterChronicle = await call('silicon_life_status', {}, 'sess-A')
assert.ok(afterChronicle.chronicle.days >= 1, `整理后应生成至少一天编年史：${JSON.stringify({ chronicle: afterChronicle.chronicle, counts: afterChronicle.counts })}`)
assert.ok(afterChronicle.chronicle.lastText.length > 0, '编年史条目应有内容')
const chroniclePrompt = A.ctx.prompts.at(-1).text()
assert.match(chroniclePrompt, /我的编年史/, '注入里应出现编年史段')
assert.match(chroniclePrompt, /拉面|喝汤|年糕/, '编年史应概括当天说过的事')
// 编年史是「这个对话自己的经历」：A 的编年史里不能出现 B 那句原话。
assert.doesNotMatch(chroniclePrompt, /爬山/, '编年史不得把别的会话的原话带进来')

// 6) 无会话绑定一律拒绝写
const noSession = await call('silicon_life_remember', { kind: 'fact', text: '无来源' }, '')
assert.match(noSession.error, /session-bound/)

// 7) raw/archive 不可变；可变层只能清自己的会话
const immutable = await call('silicon_life_clear', { confirm: 'CLEAR', buckets: ['raw'] }, 'sess-A')
assert.match(immutable.error, /immutable/, 'raw/archive 必须拒绝清除')
await call('silicon_life_remember', { kind: 'profile', text: 'A 的偏好' }, 'sess-A')
await call('silicon_life_remember', { kind: 'profile', text: 'B 的偏好' }, 'sess-B')
await call('silicon_life_clear', { confirm: 'CLEAR', buckets: ['profile'] }, 'sess-A')
const afterA = await call('silicon_life_status', {}, 'sess-A')
const afterB = await call('silicon_life_status', {}, 'sess-B')
assert.equal(afterA.counts.profile, 0, 'A 的偏好层应被清空')
assert.equal(afterB.counts.profile, 1, '清除 A 不得影响 B 的偏好层')
assert.ok(afterA.counts.raw >= 2, '不可变 raw 不得被清除')

// 8) 自检通过
const selfTest = await call('silicon_life_self_test', {}, 'sess-B')
assert.equal(selfTest.passed, true, `自检应通过：${JSON.stringify(selfTest.checks)}`)

// 9) 四层自动分工：偏好进 profile（画像），一般自述进 facts，且都只落在本会话
await emit('session/event', { id: 'sess-D', header: { id: 'sess-D' } }, { type: 'user/message', data: { text: '我喜欢喝乌龙茶，我住在杭州' } })
const dStatus = await call('silicon_life_status', {}, 'sess-D')
assert.ok(dStatus.counts.profile >= 1, `偏好型自述应进 profile：${JSON.stringify(dStatus.counts)}`)
assert.ok(dStatus.counts.facts >= 1, `一般自述应进 facts：${JSON.stringify(dStatus.counts)}`)
assert.equal((await call('silicon_life_status', {}, 'sess-B')).counts.profile, 1, 'D 的偏好不得落到 B')
const dData = await call('silicon_life_export', {}, 'sess-D')
const exported = JSON.parse(dData.content)
assert.ok(exported.data.profile.some(item => /乌龙茶/.test(item.text)), '导出里应能看到画像层')
assert.ok(exported.data.archive.every(item => item.anchor.sessionId === 'sess-D'), '会话导出只能含本会话 archive')

// 10) Harness 通知不能当成用户原话入库；历史噪声只标记不删除
await emit('session/event', { id: 'sess-D', header: { id: 'sess-D' } }, { type: 'user/message', data: { text: 'You are repeating the exact same tool call with identical arguments. Try a different approach.' } })
await emit('session/event', { id: 'sess-D', header: { id: 'sess-D' } }, { type: 'user/message', data: { text: 'Agent session-0123456789abcdef sent a message: Please finish now.' } })
const dAfter = await call('silicon_life_status', {}, 'sess-D')
assert.equal(dAfter.counts.raw, dStatus.counts.raw, 'Harness 通知不得写进 archive')
const bStatus = await call('silicon_life_status', {}, 'sess-B')
assert.ok(bStatus.archiveClean >= 0 && bStatus.archiveNoise >= 0, '噪音计数应可读')

await rm(home, { recursive: true, force: true })
console.log('isolation test: all assertions passed')
