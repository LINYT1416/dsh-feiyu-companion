/**
 * 优先用 nekowhale-meme 的库：用户导入并打过标签的图，Companion 也要能挑到。
 * 断言：有 meme 服务时优先用它；挑到的是它给的 path/url；QQ 会话用 path；服务缺失时退回 stickers。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

Math.random = () => 0.05
const home = await mkdtemp(join(tmpdir(), 'cm-meme-'))
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
  raw: [{ role: 'user', text: '今天面试完累死了，求安慰', at: old, source: 'session-event', confidence: 1, anchor: { sessionId: 'sess-M', eventType: 'user/message', at: old } }],
  facts: [], episodes: [], profile: [], moods: [], sessions: {},
  settings: { enabled: true, activeThinking: false, sevenDayMs: 604800000, injectionChars: 3500, stickerFrequency: 'often' }
}, null, 2), 'utf8')

const queries = []
const memeService = {
  search({ query = '', emotion = '', limit = 8 } = {}) {
    queries.push({ query, emotion })
    if (query.includes('面试') || query.includes('累')) {
      return { ok: true, memes: [{ id: 'mine1', name: '我的收藏-抱抱', emotion: '哭', use: '安慰人时', tags: ['抱抱'], path: 'C:/memes/mine1.gif', url: 'http://meme.test/i/mine1.gif', group: '我的收藏' }] }
    }
    if (emotion === '哭' || emotion === '无语') {
      return { ok: true, memes: [{ id: 'mine2', name: '我的收藏-叹气', emotion: '无语', use: '无奈时', tags: [], path: 'C:/memes/mine2.gif', url: 'http://meme.test/i/mine2.gif', group: '我的收藏' }] }
    }
    return { ok: true, memes: [] }
  },
}

const mod = await import('../index.js')
const handlers = new Map()
const tools = new Map()
const root = {
  on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name) },
  effect(fn) { const off = fn(); return () => off?.() },
  get(name) { return name === 'nekowhaleMeme' ? memeService : undefined },
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
const M = { id: 'sess-M', ctx: agentCtx() }
handlers.get('agent/created')({ agent: M })
await new Promise(resolve => setTimeout(resolve, 100))

// 1) 用的是 meme 库的图，而不是 stickers 图包
const text = M.ctx.prompts.at(-1).text()
assert.match(text, /我的收藏-抱抱/, `应优先用新库的图：${text}`)
assert.match(text, /http:\/\/meme\.test\/i\/mine1\.gif/, '网页会话应给 meme 库的 url')
assert.ok(queries.length > 0, '应调用过 meme.search')

// 2) QQ 会话 -> 用磁盘路径
await writeFile(join(home, 'qq-bridge-config.json'), JSON.stringify({ 私聊会话: 'sess-M', 绑定: [] }, null, 2), 'utf8')
await handlers.get('session/event')({ id: 'sess-M', header: { id: 'sess-M' } }, { type: 'user/message', data: { text: '还是好累啊' } })
await new Promise(resolve => setTimeout(resolve, 120))
assert.match(M.ctx.prompts.at(-1).text(), /\(C:\/memes\/mine1\.gif\)/, `QQ 会话应给本地路径：${M.ctx.prompts.at(-1).text()}`)

// 3) 自检
const selfTest = JSON.parse((await tools.get('silicon_life_self_test').execute({}, { agent: { id: 'sess-M' } })).content[0].text)
assert.equal(selfTest.passed, true, `自检应通过：${JSON.stringify(selfTest.checks)}`)

await rm(home, { recursive: true, force: true })
console.log('meme service test: all assertions passed')
