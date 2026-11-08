/**
 * 注入预算：装不下时先丢旧的，别一刀切尾巴。
 * 断言：预算很小的时候，最新的事实还在、最旧的原话被丢掉、人格设定被压但没消失。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = await mkdtemp(join(tmpdir(), 'cm-budget-'))
process.env.USERPROFILE = home
process.env.HOME = home
process.env.DSH_HOME = home
process.env.DSH_PROFILE_DIR = join(home, 'profile')
const dataDir = join(home, '.dsh', 'companion-memory')
await mkdir(dataDir, { recursive: true })
await mkdir(join(home, 'fish-memory'), { recursive: true })

const now = Date.now()
const raw = []
for (let i = 0; i < 30; i += 1) {
  const at = new Date(now - (30 - i) * 86400000).toISOString()
  raw.push({ role: 'user', text: `第 ${i} 天的旧话：今天在忙一件很久以前的事，编号 ${i}`, at, source: 'session-event', confidence: 1, anchor: { sessionId: 'sess-B', eventType: 'user/message', at } })
}
const facts = []
for (let i = 0; i < 12; i += 1) {
  const at = new Date(now - (12 - i) * 86400000).toISOString()
  facts.push({ text: `旧事实第 ${i} 条：我喜欢的东西编号 ${i}，这是一段比较长的描述用来占预算`, at, source: 'auto-fact', confidence: 0.6, tier: 'short', anchor: { sessionId: 'sess-B', at } })
}
const newestAt = new Date(now - 60_000).toISOString()
facts.push({ text: '【最新】我今晚想吃火锅，别忘了我说的这句', at: newestAt, source: 'auto-fact', confidence: 0.9, tier: 'instant', anchor: { sessionId: 'sess-B', at: newestAt } })

await writeFile(join(dataDir, 'state.json'), JSON.stringify({
  version: 4,
  raw, facts, episodes: [], profile: [], moods: [], sessions: {},
  persona: { name: '大肥鱼', description: '', userAddress: '', likes: '', dislikes: '', values: '', voice: '', samples: '', systemPrompt: '你叫大肥鱼，人格设定的内容在这里，用来占一段预算，确认它不会被整段丢掉。'.repeat(5) },
  settings: { enabled: true, activeThinking: false, sevenDayMs: 604800000, injectionChars: 1200 }
}, null, 2), 'utf8')

const mod = await import('../index.js')
const handlers = new Map()
const tools = new Map()
const root = {
  on(name, fn) { handlers.set(name, fn); return () => {} },
  effect(fn) { const off = fn(); return () => off?.() },
  tools: { register(tool) { tools.set(tool.name, tool); return () => {} }, get(name) { return tools.get(name) } },
  systemPrompt: { context() { return () => {} } },
  webServer: { register() { return () => {} } },
  agents: { list: () => [] }
}
mod.apply(root)
await new Promise(r => setTimeout(r, 150))

const ctx = () => { const c = { prompts: [] }; c.on = () => () => {}; c.tools = { register: () => () => {} }; c.systemPrompt = { context(spec) { c.prompts.push(spec); return () => {} } }; return c }
const agent = { id: 'sess-B', ctx: ctx() }
handlers.get('agent/created')({ agent })
await new Promise(r => setTimeout(r, 150))
const text = agent.ctx.prompts.at(-1).text()

assert.ok(text.length <= 1200, `注入不能超预算：${text.length}`)
assert.match(text, /最新/, '最新的记的事必须进得来')
assert.doesNotMatch(text, /第 0 天的旧话/, '最旧的原话应该先被丢掉')
assert.match(text, /人格设定：/, '人格设定不能被整段删掉')

await rm(home, { recursive: true, force: true })
console.log('budget test: all assertions passed')
