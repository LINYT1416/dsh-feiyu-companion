/**
 * 表情包自动候选：接上 stickers 服务后按语境挑一张，注入里给出可直接用的图片行。
 * 断言：有服务才会有候选；频率 off 不挑；QQ 会话用本地文件、网页会话用 URL；服务报错不炸。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 让随机门（频率）与洗牌都可预测：0.05 < 任何非 off 档位。
Math.random = () => 0.05
const home = await mkdtemp(join(tmpdir(), 'cm-sticker-'))
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
  raw: [
    { role: 'user', text: '今天面试完累死了，求安慰', at: old, source: 'session-event', confidence: 1, anchor: { sessionId: 'sess-S', eventType: 'user/message', at: old } },
    { role: 'user', text: '兜底会话：这句话很长而且故意不带任何表情包标签', at: old, source: 'session-event', confidence: 1, anchor: { sessionId: 'sess-F', eventType: 'user/message', at: old } }
  ],
  facts: [], episodes: [], profile: [], moods: [], sessions: {},
  settings: { enabled: true, activeThinking: false, sevenDayMs: 604800000, injectionChars: 3500, stickerFrequency: 'often' }
}, null, 2), 'utf8')

// 假的 stickers 服务：形状与 nekowhale-stickers 的 kit 一致（search / url / file）。
const calls = []
const fakeKit = {
  strict: false,
  async search(query, opts) {
    calls.push({ query, limit: opts?.limit, emotion: opts?.emotion })
    if (query.includes('炸')) throw new Error('boom')
    // strict 模式模拟「长句一个词都对不上」：只有按情绪查才有结果。
    if (fakeKit.strict) return opts?.emotion ? [{ sticker: { id: 'p/e1', name: '开心转圈', emotion: opts.emotion, use: '心情好时' }, score: 3 }] : []
    return [{ sticker: { id: 'p/f1', name: '猫猫搓手', emotion: '期待', use: '等好消息' }, score: 3 }]
  },
  async random(opts) {
    return { id: 'p/r1', name: '兜底表情', emotion: opts?.emotion || '开心' }
  },
  url: sticker => `http://sticker.test/s/${sticker.id.replace('/', '-')}.gif`,
  async file(id) { return { path: `C:/stickers/byhash/${id}.gif` } }
}

const mod = await import('../index.js')
const handlers = new Map()
const tools = new Map()
const root = {
  on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name) },
  effect(fn) { const off = fn(); return () => off?.() },
  get(name) { return name === 'stickers' ? fakeKit : undefined },
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
const S = { id: 'sess-S', ctx: agentCtx() }
handlers.get('agent/created')({ agent: S })
await new Promise(resolve => setTimeout(resolve, 80))

const call = async (tool, args, sessionId) =>
  JSON.parse((await tools.get(tool).execute(args, { agent: { id: sessionId } })).content[0].text)
const injection = () => S.ctx.prompts.at(-1).text()

// 1) 挂载时就备了候选，注入里是「配一张」的指令而不是软建议
assert.ok(calls.length >= 1, '挂载时应调用过 stickers.search')
assert.match(injection(), /!\[猫猫搓手\]\(http:\/\/sticker\.test\//)
assert.match(injection(), /配一张/)
assert.match(injection(), /放末尾/)

// 2) 用户再说一句 → 候选会刷新，查询里带上这句话
calls.length = 0
handlers.get('session/event')({ id: 'sess-S', header: { id: 'sess-S' } }, { type: 'user/message', data: { text: '今天真的好累' } })
await new Promise(resolve => setTimeout(resolve, 120))
assert.ok(calls.some(c => String(c.query).includes('好累')), `查询应带上用户的话：${JSON.stringify(calls)}`)

// 3) QQ 会话 → 优先给本地文件（QQ 桥按 markdown 图发送）
await writeFile(join(home, 'qq-bridge-config.json'), JSON.stringify({ 私聊会话: 'sess-S', 目标会话: 'sess-S', 绑定: [] }, null, 2), 'utf8')
handlers.get('session/event')({ id: 'sess-S', header: { id: 'sess-S' } }, { type: 'user/message', data: { text: '再来一张' } })
await new Promise(resolve => setTimeout(resolve, 120))
assert.match(injection(), /!\[猫猫搓手\]\(C:\/stickers\/byhash\/p\/f1\.gif\)/, 'QQ 会话应给本地路径')

// 3b) 连着几轮没发图 → 措辞升级成催办；assistant 发了图就清零
handlers.get('session/event')({ id: 'sess-S', header: { id: 'sess-S' } }, { type: 'user/message', data: { text: '再聊两句' } })
await new Promise(resolve => setTimeout(resolve, 100))
assert.match(injection(), /轮没发表情/, `连续没发图应催一下：${injection()}`)
handlers.get('session/event')({ id: 'sess-S', header: { id: 'sess-S' } }, { type: 'assistant/message', data: { message: { text: '好呀，给你看个图 ![](http://x/y.gif)' } } })
await new Promise(resolve => setTimeout(resolve, 100))
assert.doesNotMatch(injection(), /轮没发表情/, '发了图之后不该继续催')

// 4) 频率 off 时不挑新候选
await call('silicon_life_configure', { stickerFrequency: 'off' }, 'sess-S')
const T = { id: 'sess-T', ctx: agentCtx() }
calls.length = 0
handlers.get('agent/created')({ agent: T })
await new Promise(resolve => setTimeout(resolve, 80))
assert.equal(calls.length, 0, '频率 off 时不该调用 search')

// 5) 服务报错不炸：候选为空，注入照常
await call('silicon_life_configure', { stickerFrequency: 'often' }, 'sess-S')
await writeFile(join(home, 'qq-bridge-config.json'), JSON.stringify({ 私聊会话: '', 绑定: [] }, null, 2), 'utf8')
const E = { id: 'sess-E', ctx: agentCtx() }
root.get = name => name === 'stickers' ? { ...fakeKit, search: async () => { throw new Error('boom') } } : undefined
handlers.get('agent/created')({ agent: E })
await new Promise(resolve => setTimeout(resolve, 80))
assert.ok(E.ctx.prompts.at(-1), '服务报错也要能正常注册注入')
assert.doesNotMatch(E.ctx.prompts.at(-1).text(), /这张表情可能合适/)

// 6) 长句一个词都对不上时，退到「按当下心情」也能给出一张
fakeKit.strict = true
// sess-F 在预置数据里已经有旧原话，注入本身不会是空的
const F = { id: 'sess-F', ctx: agentCtx() }
handlers.get('agent/created')({ agent: F })
await new Promise(resolve => setTimeout(resolve, 150))
const fallbackText = F.ctx.prompts.at(-1).text()
assert.match(fallbackText, /配一张/, `按心情兜底也应给出候选：${fallbackText}`)
fakeKit.strict = false

// 7) 自检全绿
const selfTest = await call('silicon_life_self_test', {}, 'sess-S')
assert.equal(selfTest.passed, true, `自检应通过：${JSON.stringify(selfTest.checks)}`)

await rm(home, { recursive: true, force: true })
console.log('sticker test: all assertions passed')
