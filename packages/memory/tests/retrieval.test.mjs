/**
 * 检索（BM25 + 实体硬条件 + 线索门控）、记忆变糊（原文不动、注入变短）、容量水位回归。
 * 同样把 HOME/USERPROFILE 指到临时目录，绝不碰真实记忆。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'cm-retrieval-'))
process.env.USERPROFILE = home
process.env.HOME = home
process.env.DSH_HOME = home
const dataDir = join(home, '.dsh', 'companion-memory')
await mkdir(dataDir, { recursive: true })
const at = h => new Date(Date.now() - h * 3600000).toISOString()
const anchor = (sessionId, when) => ({ sessionId, eventType: 'user/message', at: when })
const row = (sessionId, text, when) => ({ role: 'user', text, at: when, source: 'session-event', confidence: 1, anchor: anchor(sessionId, when) })

// 210 天前的原话：注入里应该只剩很短一截，但原文必须完整留在 archive。
const ancient = '很久以前我住在杭州西湖区文三路的旧小区，楼下有家开了二十年的老面馆，老板姓陈，面汤是骨头熬的'
await writeFile(join(dataDir, 'state.json'), JSON.stringify({
  version: 4,
  raw: [
    row('sess-R', '我最近在折腾 BV1xx411c7mD 这个视频', at(3)),
    row('sess-R', '拉面 拉面 拉面 想吃拉面', at(3)),
    row('sess-S', 'BV1xx411c7mD 是别人发的视频，跟我无关', at(3)),
    row('sess-R', ancient, at(210 * 24))
  ],
  facts: [],
  episodes: [],
  profile: [],
  moods: [],
  sessions: {},
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
  get(name) { return root._tools.get(name) }
}
mod.apply(root)
await new Promise(resolve => setTimeout(resolve, 100))

const agentCtx = () => {
  const c = { prompts: [] }
  c.on = () => () => {}
  c.tools = { register: () => () => {} }
  c.systemPrompt = { context(spec) { c.prompts.push(spec); return () => {} } }
  return c
}
const R = { id: 'sess-R', ctx: agentCtx() }
root.handlers.get('agent/created')({ agent: R })
const injection = R.ctx.prompts.at(-1).text()

const call = async (tool, args, sessionId) =>
  JSON.parse((await root._tools.get(tool).execute(args, { agent: { id: sessionId } })).content[0].text)

// 1) BM25：词频高的那条排第一
const ramen = await call('silicon_life_recall', { query: '拉面', limit: 5 }, 'sess-R')
assert.ok(ramen.matches.length > 0, '「拉面」应能被召回')
assert.equal(ramen.ranked, 'bm25')
assert.match(ramen.matches[0].text, /拉面 拉面/, `词频更高的应排第一：${JSON.stringify(ramen.matches.map(m => m.text))}`)
assert.ok(ramen.matches[0].score > 0, '命中的要有分数')

// 2) 实体硬条件：BV号必须整体命中，少一个字符不算
const entity = await call('silicon_life_recall', { query: 'BV1xx411c7mD', limit: 5 }, 'sess-R')
assert.equal(entity.matches.length, 1, `BV号只应命中一条：${JSON.stringify(entity.matches.map(m => m.text))}`)
assert.ok(entity.entities.includes('bv1xx411c7md'))
const partial = await call('silicon_life_recall', { query: 'BV1xx411c7m', limit: 5 }, 'sess-R')
assert.equal(partial.matches.length, 0, '半个 BV 号不该被模糊命中')

// 3) 会话隔离仍然成立
const otherSession = await call('silicon_life_recall', { query: 'BV1xx411c7mD', limit: 5 }, 'sess-S')
assert.equal(otherSession.matches.length, 1)
assert.match(otherSession.matches[0].text, /别人发的视频/, 'S 只能看到自己的那条')

// 4) 记忆变糊：注入里只剩很短一截 + 提示，原文完整可查
assert.match(injection, /久远记忆，细节已模糊/, `210 天前的记忆在注入里应标记变糊：${injection}`)
assert.equal(injection.includes(ancient), false, '注入里不该出现久远原话的完整句子')
assert.match(injection, /7 个月前/, `长期记忆要带真实时间，不能当成刚刚：${injection}`)
const status = await call('silicon_life_status', {}, 'sess-R')
const exported = JSON.parse((await call('silicon_life_export', {}, 'sess-R')).content)
const archivedAncient = exported.data.archive.find(item => item.text.includes('文三路'))
assert.ok(archivedAncient, '原文必须完整留在 archive 里')
assert.equal(archivedAncient.text, ancient, 'archive 里的原文不得被截断或改写')
assert.equal(status.counts.archive, 3, '这个会话的原文条数不该被注入裁剪影响')

// 5) 容量水位：只告警，不删除
assert.equal(status.capacity.archive.limit, 1000)
// 水位看的是整个原文库（不是单个会话），所以这里用全局条数对照。
assert.equal(status.capacity.archive.used, 4, '原文库水位应统计全部会话的原文')
assert.ok([0, 80, 90, 100].includes(status.capacity.archive.level), '水位只能是 0/80/90/100')
assert.ok(status.capacity.injection.ratio >= 0, '注入水位可计算')

// 6) 自检仍全绿
const selfTest = await call('silicon_life_self_test', {}, 'sess-R')
assert.equal(selfTest.passed, true, `自检应通过：${JSON.stringify(selfTest.checks)}`)

await rm(home, { recursive: true, force: true })
console.log('retrieval test: all assertions passed')
