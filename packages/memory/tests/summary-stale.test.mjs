/**
 * 摘要生命周期回归（假模型 + 临时 HOME）：
 *  1. 底稿变了 → 保留模型那句并标 stale，绝不退回分号碎片
 *  2. 下一轮润色把 stale 的那条重写掉，stale 复位
 *  3. 每日模型调用预算能真正拦住花钱（cap=0 时一次都不调）
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'cm-stale-'))
process.env.USERPROFILE = home
process.env.HOME = home

const dayKey = date => new Date(date).toISOString().slice(0, 10)
const today = dayKey(Date.now())
const hoursAgo = h => new Date(Date.now() - h * 3600000).toISOString()
const S = 'sess-stale'
const MODEL_TEXT = '那天我们说好把记忆写顺，细节回头再补。'
const NEW_TEXT = '那天我们把记忆写顺了，还记着别让对话之间串味。'

const dataDir = join(home, '.dsh', 'companion-memory')
await mkdir(dataDir, { recursive: true })
await writeFile(join(dataDir, 'state.json'), JSON.stringify({
  version: 4,
  raw: [
    { role: 'user', text: '我们先把记忆插件的日记写好再继续迭代', at: hoursAgo(3), source: 'session-event', confidence: 1, anchor: { sessionId: S, eventType: 'user/message', at: hoursAgo(3) } },
    { role: 'user', text: '现在最大的问题是各个对话间别窜记忆', at: hoursAgo(2), source: 'session-event', confidence: 1, anchor: { sessionId: S, eventType: 'user/message', at: hoursAgo(2) } }
  ],
  // 预置：模型摘要的底稿已经和当前 digest 不一致（模拟「那天又说了新话」）
  diary: [{
    id: `day-${S}-${today}`, kind: 'day', day: today, text: MODEL_TEXT, extractiveText: '完全不同的旧底稿；跟现在对不上',
    inputsHash: 'stale-hash', source: 'model-summary', confidence: 0.55,
    at: `${today}T23:59:59.000Z`, updatedAt: hoursAgo(1),
    anchor: { sessionId: S, eventType: 'daily-digest', at: `${today}T23:59:59.000Z` }
  }],
  sessions: { [S]: { recent: [] } },
  settings: { enabled: true, activeThinking: false, modelSummary: true, modelDailyCap: 5, sevenDayMs: 604800000, injectionChars: 3500 },
  lastModelConfig: { provider: 'fake-provider', model: 'fake-model' }
}, null, 2), 'utf8')

const model = { calls: 0, output: NEW_TEXT }
const mod = await import('../index.js')
const routes = new Map()
const tools = new Map()
const ctx = {
  on() { return () => {} },
  effect(fn) { const off = fn(); return () => off?.() },
  systemPrompt: { context() { return () => {} } },
  webServer: { register(spec) { routes.set(spec.path, spec.handler); return () => routes.delete(spec.path) } },
  agents: { list: () => [], get: () => undefined, currentInitiator: () => undefined },
  get(name) {
    if (name !== 'llm') return undefined
    return {
      async *stream() {
        model.calls += 1
        yield { type: 'text-delta', text: model.output }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
}
ctx.tools = { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) }, get: n => tools.get(n), schemas: () => [...tools.values()].map(t => ({ name: t.name })) }
mod.apply(ctx)
await new Promise(r => setTimeout(r, 150))

const stateFile = join(dataDir, 'state.json')
const rows = async () => JSON.parse(await readFile(stateFile, 'utf8')).diary || []
const dayRow = list => list.find(r => r.day === today && (r.kind === 'day' || !r.kind) && r.anchor?.sessionId === S)

async function callRoute(path, body) {
  const handler = routes.get(path)
  assert.ok(handler, `route ${path} registered`)
  let payload = null
  const listeners = {}
  const req = {
    method: 'POST',
    headers: { host: '127.0.0.1:1' },
    on(event, fn) { listeners[event] = fn; return this },
    _fire() {
      if (listeners.data && body) listeners.data(Buffer.from(JSON.stringify(body)))
      if (listeners.end) listeners.end()
    }
  }
  const res = { writeHead() {}, end(text) { payload = JSON.parse(String(text)) } }
  const done = handler(req, res)
  await new Promise(r => setTimeout(r, 30))
  req._fire()
  await done
  return payload
}

// 1) 启动时的重建：底稿对不上了，但模型那句要留下，并标记 stale
let list = await rows()
let row = dayRow(list)
assert.equal(row.text, MODEL_TEXT, '底稿变化不该把模型文案退回碎片')
assert.equal(row.source, 'model-summary')
assert.equal(row.stale, true, '应标记为过期，等待重新润色')
assert.equal(model.calls, 0, '启动重建不该调用模型')

// 2) 下一轮润色：把 stale 的那条重写掉
const refined = await callRoute('/silicon-life-companion/refine', { sessionId: S, maxOne: true })
assert.equal(refined.refined, 1, `应重写一条：${JSON.stringify(refined.debug)}`)
list = await rows()
row = dayRow(list)
assert.equal(row.text, NEW_TEXT, '模型新写的那句要生效')
assert.equal(row.stale, false, '重写后 stale 复位')
assert.equal(model.calls, 1, '只花了一次模型调用')

// 3) 每日预算：cap=0 后一次都不能调
const configured = await callRoute('/silicon-life-companion/config', { modelDailyCap: 0 })
assert.equal(configured.settings.modelDailyCap, 0)
const before = model.calls
const blocked = await callRoute('/silicon-life-companion/refine', { sessionId: S })
assert.equal(blocked.refined, 0, '预算耗尽后不该再重写')
assert.equal(model.calls, before, '预算耗尽后不该发出模型请求')
assert.match(String(blocked.debug.error), /daily-cap/, '要能看出是被预算拦下的')

await rm(home, { recursive: true, force: true })
console.log('summary-stale test: all assertions passed')
