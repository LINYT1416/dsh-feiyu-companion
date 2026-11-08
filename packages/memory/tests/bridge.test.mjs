/**
 * 与用户自己写的记忆插件联动：
 *  - dsh-fish-memory（每会话一个库）→ 镜像进 facts、可召回、不重复注入、不改它的文件
 *  - @local/persistent-memory（全局 facts）→ 镜像进 facts、可召回
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'cm-bridge-'))
process.env.USERPROFILE = home
process.env.HOME = home
process.env.DSH_HOME = home
process.env.DSH_PROFILE_DIR = join(home, 'profile')

const SID = 'sess-bridge'
const fishDir = join(home, 'fish-memory')
const upstreamDir = join(home, 'profile', 'node_modules', '@local', 'persistent-memory')
await mkdir(fishDir, { recursive: true })
await mkdir(upstreamDir, { recursive: true })

const fishStore = {
  version: 1,
  policy: {},
  memories: [
    { id: 'f1', text: '我养了一只叫团子的柴犬', at: '2026-10-01T10:00:00.000Z', category: '事实', importance: 0.9, tags: ['团子'], emotion: '开心' },
    { id: 'f2', text: '我不吃香菜', at: '2026-10-02T10:00:00.000Z', category: '偏好', importance: 0.7, tags: [] }
  ],
  traces: [],
  deleted: [],
  purgeEpoch: 0
}
const fishPath = join(fishDir, `${SID}.json`)
await writeFile(fishPath, JSON.stringify(fishStore, null, 2), 'utf8')
const fishBefore = await readFile(fishPath, 'utf8')

await writeFile(join(upstreamDir, 'persistent-memory.json'), JSON.stringify({ version: 1, facts: ['我的生日是三月十四号'], sessions: {} }, null, 2), 'utf8')

const mod = await import('../index.js')

const prompts = []
const handlers = new Map()
const tools = new Map()
const root = {
  prompts,
  on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name) },
  effect(fn) { const off = fn(); return () => off?.() },
  tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) }, get(name) { return tools.get(name) } },
  systemPrompt: { context(spec) { prompts.push(spec); return () => {} } },
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
const agent = { id: SID, ctx: agentCtx() }
handlers.get('agent/created')({ agent })
await new Promise(resolve => setTimeout(resolve, 150))

const call = async (tool, args, sessionId) =>
  JSON.parse((await tools.get(tool).execute(args, { agent: { id: sessionId } })).content[0].text)

// 1) 鱼记忆被镜像进 facts，且锚在本会话
const status = await call('silicon_life_status', {}, SID)
assert.equal(status.bridge.fish.detected, true, '应检测到鱼记忆的库')
assert.equal(status.bridge.fish.memories, 2)
assert.ok(status.bridge.fish.mirrored >= 2, `应镜像至少 2 条：${JSON.stringify(status.bridge.fish)}`)
assert.match(status.summary, /联动：鱼记忆/, '状态摘要里应体现联动')

// 2) 可召回，且标清来源
const recall = await call('silicon_life_recall', { query: '团子', limit: 5 }, SID)
assert.ok(recall.matches.length > 0, '鱼记忆里的条目应能召回')
assert.ok(recall.matches.some(item => item.source === 'fish-memory'), `召回结果应标出来源：${JSON.stringify(recall.matches.map(m => m.source))}`)

// 3) 不重复注入：鱼记忆自己会注入，Companion 不再重复一遍
const injection = agent.ctx.prompts.at(-1).text()
assert.equal((injection.match(/团子的柴犬/g) || []).length, 0, '注入里不该重复鱼记忆的条目')

// 4) persistent-memory 的全局事实也被镜像
const persistent = await call('silicon_life_status', {}, SID)
assert.equal(persistent.bridge.detected, true)
assert.ok(persistent.bridge.mirrored >= 1, '应镜像 persistent-memory 的事实')

// 5) 只读：鱼记忆的库一个字节都没动
const fishAfter = await readFile(fishPath, 'utf8')
assert.equal(fishAfter, fishBefore, '联动必须只读，不能改写鱼记忆的库')

await rm(home, { recursive: true, force: true })
console.log('bridge test: all assertions passed')
