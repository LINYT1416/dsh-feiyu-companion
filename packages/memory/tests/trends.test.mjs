/**
 * 热点词：记录网上看到的新梗，挑表情时优先试它们；14 天过期；可列可清。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

Math.random = () => 0.05
const home = await mkdtemp(join(tmpdir(), 'cm-trends-'))
process.env.USERPROFILE = home
process.env.HOME = home
process.env.DSH_HOME = home
process.env.DSH_PROFILE_DIR = join(home, 'profile')
const dataDir = join(home, '.dsh', 'companion-memory')
await mkdir(dataDir, { recursive: true })
await mkdir(join(home, 'fish-memory'), { recursive: true })

const old = new Date(Date.now() - 3 * 3600000).toISOString()
await writeFile(join(dataDir, 'state.json'), JSON.stringify({
  version: 4,
  raw: [{ role: 'user', text: '今天有点无聊，陪我聊聊', at: old, source: 'session-event', confidence: 1, anchor: { sessionId: 'sess-T', eventType: 'user/message', at: old } }],
  facts: [], episodes: [], profile: [], moods: [], sessions: {},
  // 预置一个 20 天前的热点词：应被 14 天 TTL 过滤掉。
  trends: [{ term: '老梗', at: new Date(Date.now() - 20 * 86400000).toISOString(), source: 'seed' }],
  settings: { enabled: true, activeThinking: false, sevenDayMs: 604800000, injectionChars: 3500, stickerFrequency: 'often' }
}, null, 2), 'utf8')

// 普通查询永远没结果，只有热点词能命中 —— 用来验证「热点词兜底」真的接上了。
const kit = {
  async search(query) {
    if (query === '新梗热词') return [{ sticker: { id: 'p/hot1', name: '热梗表情', emotion: '开心', use: '聊到新梗时' }, score: 5 }]
    return []
  },
  async random() { return null },
  url: sticker => `http://sticker.test/s/${sticker.id}.gif`,
  async file(id) { return { path: `C:/stickers/${id}.gif` } }
}

const mod = await import('../index.js')
const handlers = new Map()
const tools = new Map()
const root = {
  on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name) },
  effect(fn) { const off = fn(); return () => off?.() },
  get(name) { return name === 'stickers' ? kit : undefined },
  tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) }, get(name) { return tools.get(name) } },
  systemPrompt: { context() { return () => {} } },
  webServer: { register() { return () => {} } },
  agents: { list: () => [] }
}
mod.apply(root)
await new Promise(resolve => setTimeout(resolve, 120))

const call = async (tool, args, sessionId) =>
  JSON.parse((await tools.get(tool).execute(args, { agent: { id: sessionId } })).content[0].text)

// 1) 先在没有任何热点词时挂载：普通查询没结果 → 不该有候选
const agentCtx = () => {
  const c = { prompts: [] }
  c.on = () => () => {}
  c.tools = { register: () => () => {} }
  c.systemPrompt = { context(spec) { c.prompts.push(spec); return () => {} } }
  return c
}
const T = { id: 'sess-T', ctx: agentCtx() }
handlers.get('agent/created')({ agent: T })
await new Promise(resolve => setTimeout(resolve, 80))
assert.doesNotMatch(T.ctx.prompts.at(-1).text(), /!\[[^\]]*\]\(http/, '没有热点词且普通查询无果时不该硬塞图片行')

// 2) 记一个热点词，再触发一次 → 用热点词挑到图
const added = await call('silicon_life_trend', { action: 'add', term: '新梗热词', source: '自测' }, 'sess-T')
assert.equal(added.added, true)
await handlers.get('session/event')({ id: 'sess-T', header: { id: 'sess-T' } }, { type: 'user/message', data: { text: '又有新梗了吗' } })
await new Promise(resolve => setTimeout(resolve, 150))
assert.match(T.ctx.prompts.at(-1).text(), /热梗表情/, `热点词应能挑到表情：${T.ctx.prompts.at(-1).text()}`)

// 3) 列表与去重
const listed = await call('silicon_life_trend', { action: 'list' }, 'sess-T')
assert.ok(listed.trends.some(row => row.term === '新梗热词'))
const dup = await call('silicon_life_trend', { action: 'add', term: '新梗热词' }, 'sess-T')
assert.equal(dup.duplicate, true)

// 4) 过期的不算（预置的那个 20 天前的「老梗」不应该出现在列表里）
const listed2 = await call('silicon_life_trend', { action: 'list' }, 'sess-T')
assert.equal(listed2.trends.some(row => row.term === '老梗'), false, '14 天前的热点词应过期')
assert.ok(listed2.trends.some(row => row.term === '新梗热词'))

// 5) 清除
const cleared = await call('silicon_life_trend', { action: 'clear', term: '新梗热词' }, 'sess-T')
assert.ok(cleared.remaining >= 0)
const listed3 = await call('silicon_life_trend', { action: 'list' }, 'sess-T')
assert.equal(listed3.trends.some(row => row.term === '新梗热词'), false)

// 6) 自检
const selfTest = await call('silicon_life_self_test', {}, 'sess-T')
assert.equal(selfTest.passed, true, `自检应通过：${JSON.stringify(selfTest.checks)}`)

await rm(home, { recursive: true, force: true })
console.log('trends test: all assertions passed')
