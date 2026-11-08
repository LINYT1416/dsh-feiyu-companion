/**
 * 模型摘要的持久化回归（不碰真实记忆：HOME/USERPROFILE 指向临时目录）。
 *
 * 保护的 bug：日记被模型重写成一句人话后，下一轮/重载时编年史重建又把它覆盖回
 * 分号拼接的抽取式文本，等于每轮白花钱、而且用户看到的还是碎片。
 *
 * 覆盖：模型摘要在重建后保留、底稿 hash 记录、失败回退抽取式、来源可追溯、会话隔离。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'cm-summary-'))
process.env.USERPROFILE = home
process.env.HOME = home

const dayKey = date => new Date(date).toISOString().slice(0, 10)
const today = dayKey(Date.now())
const hoursAgo = h => new Date(Date.now() - h * 3600000).toISOString()

const S = 'sess-summary'
const T = 'sess-other'
const dataDir = join(home, '.dsh', 'companion-memory')
await mkdir(dataDir, { recursive: true })
await writeFile(join(dataDir, 'state.json'), JSON.stringify({
  version: 4,
  raw: [
    { role: 'user', text: '我们先把记忆插件的日记写好再继续迭代', at: hoursAgo(2), source: 'session-event', confidence: 1, anchor: { sessionId: S, eventType: 'user/message', at: hoursAgo(2) } },
    { role: 'user', text: '现在最大的问题是各个对话间别窜记忆', at: hoursAgo(1), source: 'session-event', confidence: 1, anchor: { sessionId: S, eventType: 'user/message', at: hoursAgo(1) } },
    // 另一个会话的原话：绝不能出现在 S 的日记里
    { role: 'user', text: '另一个会话在聊完全无关的事情', at: hoursAgo(1), source: 'session-event', confidence: 1, anchor: { sessionId: T, eventType: 'user/message', at: hoursAgo(1) } }
  ],
  sessions: { [S]: { recent: [] }, [T]: { recent: [] } },
  settings: { enabled: true, activeThinking: false, modelSummary: true, sevenDayMs: 604800000, injectionChars: 3500 },
  // 让模型配置在“没有 agent 可问”的测试环境里也能解析出来
  lastModelConfig: { provider: 'fake-provider', model: 'fake-model' }
}, null, 2), 'utf8')

// 可切换的假模型：默认成功，failMode 时模拟上游失败。
const model = { calls: 0, failMode: false, output: '那天我们先把记忆插件的日记写顺了，也在防着各对话串记忆。' }
const mod = await import('../index.js')

const routes = new Map()
const tools = new Map()
const makeAgent = id => ({ id, ctx: { on() { return () => {} } }, session: { requestHeader: () => ({ config: { provider: 'fake-provider', model: 'fake-model' } }) } })

const ctx = {
  on() { return () => {} },
  effect(fn) { const off = fn(); return () => off?.() },
  systemPrompt: { context() { return () => {} } },
  webServer: { register(spec) { routes.set(spec.path, spec.handler); return () => routes.delete(spec.path) } },
  // 不挂载任何 agent：mount 需要真实的 agent 上下文；这里走工具与路由两种入口。
  agents: { list: () => [], get: () => undefined, currentInitiator: () => undefined },
  get(name) {
    if (name !== 'llm') return undefined
    return {
      async *stream() {
        model.calls += 1
        if (model.failMode) throw new Error('upstream exploded')
        yield { type: 'text-delta', text: model.output }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
}
ctx.tools = { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) }, get: n => tools.get(n), schemas: () => [...tools.values()].map(t => ({ name: t.name })) }
mod.apply(ctx)
await new Promise(r => setTimeout(r, 150))

function fakeReq(method, body) {
  const listeners = {}
  return {
    method,
    headers: { host: '127.0.0.1:1' },
    on(event, fn) { listeners[event] = fn; return this },
    _fire() {
      if (listeners.data && body) listeners.data(Buffer.from(JSON.stringify(body)))
      if (listeners.end) listeners.end()
    }
  }
}
async function callRoute(path, body) {
  const handler = routes.get(path)
  assert.ok(handler, `route ${path} registered`)
  let payload = null
  const req = fakeReq('POST', body)
  const res = {
    writeHead() {},
    end(text) { payload = JSON.parse(String(text)) }
  }
  const done = handler(req, res)
  // handler 先 await load()，readBody 的监听是在那之后才挂上的，所以要等一下再灌 body。
  await new Promise(r => setTimeout(r, 30))
  req._fire()
  await done
  return payload
}
const stateFile = join(dataDir, 'state.json')
const readDiary = async () => JSON.parse(await readFile(stateFile, 'utf8')).diary || []
const dayRow = rows => rows.find(r => r.day === today && (r.kind === 'day' || !r.kind) && r.anchor?.sessionId === S)

// 1) 模型重写成功：写进 model-summary，并留下底稿与 hash
const rebuilt = await callRoute('/silicon-life-companion/rebuild', { sessionId: S, days: 3 })
assert.equal(rebuilt.refinedDays, 1, `应有一条日记被模型重写：${JSON.stringify(rebuilt.details)}`)
let rows = await readDiary()
let row = dayRow(rows)
assert.equal(row.source, 'model-summary')
assert.equal(row.text, model.output, '展示的是模型写的那句')
assert.ok(row.extractiveText.includes('日记写好'), '底稿仍在，可用于追溯/重写')
assert.ok(row.inputsHash, '必须记录底稿 hash，否则无法判断要不要重写')
assert.ok(!row.text.includes('；'), '模型文案不该是分号拼接')

// 2) 关键回归：模拟下一轮整理（走 consolidateExpired → rebuildChronicle），不能覆盖模型文案
const consolidate = tools.get('silicon_life_consolidate')
assert.ok(consolidate, 'consolidate 工具已注册')
await consolidate.execute({ dryRun: false }, { agent: { id: S } })
rows = await readDiary()
row = dayRow(rows)
assert.equal(row.source, 'model-summary', '重建后仍应标记为模型摘要')
assert.equal(row.text, model.output, '重建后模型文案不能被抽取式覆盖')

// 3) 会话隔离：另一个会话的日记里不能出现 S 的原话
const otherRow = rows.find(r => r.day === today && r.anchor?.sessionId === T)
if (otherRow) assert.ok(!otherRow.text.includes('记忆插件的日记'), '别的会话不能拿到 S 的原话')

// 4) 失败回退：模型报错时保留抽取式，不产生假的 model-summary
model.failMode = true
const before = model.calls
const rebuilt2 = await callRoute('/silicon-life-companion/rebuild', { sessionId: S, days: 3 })
assert.ok(model.calls > before, '确实尝试调用过模型')
assert.equal(rebuilt2.refinedDays, 0, '模型失败时不该声称重写成功')
rows = await readDiary()
row = dayRow(rows)
assert.notEqual(row.source, 'model-summary', '失败后应回退为抽取式来源')
assert.ok(!row.text.includes('那天我们'), '失败后不该残留上一次的模型文案')
assert.ok(row.text.length > 0, '失败也必须有日记，不能空')

await rm(home, { recursive: true, force: true })
console.log('summary-persist test: all assertions passed')
