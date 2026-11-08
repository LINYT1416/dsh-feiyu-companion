/**
 * 性格深度：她的喜恶、关系阶段、心情底色。
 * 断言：默认白纸不注入；填了才出现；阶段由天数/句数/梗推出；心情底色随 valence 变；不跨会话、不写记忆。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'cm-personality-'))
process.env.USERPROFILE = home
process.env.HOME = home
process.env.DSH_HOME = home
process.env.DSH_PROFILE_DIR = join(home, 'profile')
const dataDir = join(home, '.dsh', 'companion-memory')
await mkdir(dataDir, { recursive: true })

const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString()
// 老会话：30 天前开始、说过 120 句 → 应该是「亲近」。
const oldRows = []
for (let i = 0; i < 120; i += 1) {
  const at = daysAgo(10 - (i % 10) * 0.01)
  oldRows.push({ role: 'user', text: `老会话第 ${i} 句：今天也想一起吃饭`, at, source: 'session-event', confidence: 1, anchor: { sessionId: 'sess-old', eventType: 'user/message', at } })
}
oldRows.push({ role: 'user', text: '这条是三十天前说的第一句', at: daysAgo(30), source: 'session-event', confidence: 1, anchor: { sessionId: 'sess-old', eventType: 'user/message', at: daysAgo(30) } })
// 新会话：只有一句 → 应该是「初识」。
const freshAt = new Date(Date.now() - 3 * 3600000).toISOString()
const freshRow = { role: 'user', text: '第一次见面，打个招呼', at: freshAt, source: 'session-event', confidence: 1, anchor: { sessionId: 'sess-new', eventType: 'user/message', at: freshAt } }

await writeFile(join(dataDir, 'state.json'), JSON.stringify({
  version: 4,
  raw: [...oldRows, freshRow],
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
await new Promise(resolve => setTimeout(resolve, 150))

const agentCtx = () => {
  const c = { prompts: [] }
  c.on = () => () => {}
  c.tools = { register: () => () => {} }
  c.systemPrompt = { context(spec) { c.prompts.push(spec); return () => {} } }
  return c
}
const NEW = { id: 'sess-new', ctx: agentCtx() }
const OLD = { id: 'sess-old', ctx: agentCtx() }
handlers.get('agent/created')({ agent: NEW })
handlers.get('agent/created')({ agent: OLD })
await new Promise(resolve => setTimeout(resolve, 80))

const call = async (tool, args, sessionId) =>
  JSON.parse((await tools.get(tool).execute(args, { agent: { id: sessionId } })).content[0].text)
const injection = agent => agent.ctx.prompts.at(-1).text()

// 1) 默认白纸：没有喜恶、没有替用户编的喜好
assert.doesNotMatch(injection(NEW), /她喜欢的/)
assert.doesNotMatch(injection(NEW), /她不喜欢的/)

// 2) 填了才出现
await call('silicon_life_configure', { personaLikes: '下雨天、热汤、被摸头', personaDislikes: '香菜、被催' }, 'sess-new')
assert.match(injection(NEW), /她喜欢的：下雨天、热汤、被摸头/)
assert.match(injection(NEW), /她不喜欢的：香菜、被催/)

// 3) 关系阶段：老会话「亲近」，新会话「初识」
assert.match(injection(OLD), /关系阶段：亲近/)
assert.match(injection(NEW), /关系阶段：熟了/)
const oldStatus = await call('silicon_life_status', {}, 'sess-old')
assert.equal(oldStatus.isolated, true)

// 4) 存一个梗会把新会话推到「熟了」
await call('silicon_life_joke', { action: 'save', text: '打招呼的梗', confirm: '记住' }, 'sess-new')
assert.match(injection(NEW), /关系阶段：熟了/)
// 老会话不受影响
assert.match(injection(OLD), /关系阶段：亲近/)

// 5) 心情底色跟着 valence 走（测试环境没有鱼的心情插件，走本地心情）
// 单次波动上限 0.25，所以连写两次才能明显偏正/偏负。
await call('silicon_life_mood', { emotion: '喜悦', valence: 0.8, arousal: 0.2, note: '开心' }, 'sess-old')
await call('silicon_life_mood', { emotion: '喜悦', valence: 0.8, arousal: 0.2, note: '还是很开心' }, 'sess-old')
const happy = injection(OLD)
assert.match(happy, /情绪底色：心情挺好|情绪底色：心情不错/, `心情好时应有对应底色：${happy}`)
for (let i = 0; i < 4; i += 1) await call('silicon_life_mood', { emotion: '悲伤', valence: -0.9, arousal: 0.1, note: '低落' }, 'sess-old')
const sad = injection(OLD)
assert.match(sad, /情绪底色：心情偏低/, `心情低时应有对应底色：${sad}`)

// 6) 喜恶不写进记忆层
const status = await call('silicon_life_status', {}, 'sess-new')
assert.equal(status.counts.facts, 0)
assert.equal(status.counts.profile, 0)

// 7) 自检全绿
const selfTest = await call('silicon_life_self_test', {}, 'sess-new')
assert.equal(selfTest.passed, true, `自检应通过：${JSON.stringify(selfTest.checks)}`)

await rm(home, { recursive: true, force: true })
console.log('personality test: all assertions passed')
