/**
 * 白纸人格：默认什么都不注入；只有用户在设置里填了的段落才进注入；
 * 「清空成白纸」会先把当前人设存档，再清空，且记忆不受影响。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'cm-persona-'))
process.env.USERPROFILE = home
process.env.HOME = home
process.env.DSH_HOME = home
process.env.DSH_PROFILE_DIR = join(home, 'profile')
const dataDir = join(home, '.dsh', 'companion-memory')
await mkdir(dataDir, { recursive: true })
await writeFile(join(dataDir, 'state.json'), JSON.stringify({
  version: 4,
  raw: [{ role: 'user', text: '我昨天说想去看海', at: new Date(Date.now() - 3 * 3600000).toISOString(), source: 'session-event', confidence: 1, anchor: { sessionId: 'sess-P', eventType: 'user/message', at: new Date(Date.now() - 3 * 3600000).toISOString() } }],
  facts: [], episodes: [], profile: [], moods: [], sessions: {},
  settings: { enabled: true, activeThinking: false, sevenDayMs: 604800000, injectionChars: 3500 }
}, null, 2), 'utf8')

const mod = await import('../index.js')

const routes = new Map()
const handlers = new Map()
const tools = new Map()
const root = {
  on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name) },
  effect(fn) { const off = fn(); return () => off?.() },
  tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) }, get(name) { return tools.get(name) } },
  systemPrompt: { context() { return () => {} } },
  webServer: { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path) } },
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
const P = { id: 'sess-P', ctx: agentCtx() }
handlers.get('agent/created')({ agent: P })
await new Promise(resolve => setTimeout(resolve, 80))

const call = async (tool, args, sessionId) =>
  JSON.parse((await tools.get(tool).execute(args, { agent: { id: sessionId } })).content[0].text)
const injection = () => P.ctx.prompts.at(-1).text()

// 1) 默认白纸：注入里没有身份/三观/说话方式/性格/性格参数
const blank = injection()
assert.doesNotMatch(blank, /我是谁/, '白纸默认不该有身份段')
assert.doesNotMatch(blank, /我的三观/, '白纸默认不该有三观段')
assert.doesNotMatch(blank, /说话方式/, '白纸默认不该有说话方式段')
assert.doesNotMatch(blank, /性格参数/, '中性滑块不该硬塞性格参数')
assert.match(blank, /想去看海/, '记忆照常注入')

const status = await call('silicon_life_status', {}, 'sess-P')
assert.equal(status.persona.name, '')
assert.equal(status.persona.values, '')
assert.equal(status.personality.traits, '')
assert.match(status.summary, /白纸/, '状态摘要应说明现在是白纸')

// 2) 填了才生效：名字/三观/说话方式/性格/参数按段落出现
await call('silicon_life_configure', {
  personaName: '小白',
  personaDescription: '一个愿意陪你熬夜的人',
  personaValues: '诚实优先，不哄骗，不替人做决定',
  personaVoice: '短句，先给结论，少用感叹号',
  personaSamples: '那我不管你了哦。\n哼，才不是担心你呢。',
  traits: '安静、耐心',
  warmth: 80,
  curiosity: 40,
  pragmatism: 70
}, 'sess-P')
const filled = injection()
assert.match(filled, /我是谁：小白；一个愿意陪你熬夜的人/)
assert.match(filled, /我的三观：诚实优先/)
assert.match(filled, /说话方式：短句，先给结论/)
assert.match(filled, /她平时说话的口气/)
assert.match(filled, /才不是担心你呢/)
assert.match(filled, /性格底色：安静、耐心/)
assert.match(filled, /温暖拉满、好奇偏低、务实偏高/)

// 3) 清空成白纸：先存档、再清空，记忆不动
const post = (path, body) => new Promise(resolve => {
  const req = new EventEmitter()
  req.method = 'POST'
  const res = { statusCode: 0, payload: null, writeHead(code) { this.statusCode = code }, end(text) { this.payload = JSON.parse(text); resolve(this) } }
  routes.get(path)(req, res)
  req.emit('data', JSON.stringify(body || {}))
  req.emit('end')
})
const response = await post('/silicon-life-companion/persona/blank', {})
assert.equal(response.statusCode, 200)
assert.equal(response.payload.blanked, true)
assert.equal(response.payload.archived, true, '有内容时清空应先存档')
assert.ok(response.payload.presets >= 1)
assert.equal(response.payload.status.persona.name, '')
assert.equal(response.payload.status.personality.traits, '')
const afterBlank = injection()
assert.doesNotMatch(afterBlank, /我是谁/, '清空后不该再注入身份')
assert.match(afterBlank, /想去看海/, '清空人格不能动记忆')

// 4) 空的时候再点一次：不重复存档
const second = await post('/silicon-life-companion/persona/blank', {})
assert.equal(second.payload.archived, false, '已经是白纸时不该再存一份空档')
assert.equal(second.payload.presets, response.payload.presets)

await rm(home, { recursive: true, force: true })
console.log('persona test: all assertions passed')
