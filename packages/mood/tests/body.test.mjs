/**
 * 身体层 + 自我调节：饿了会写进注入并自己去找吃的；难受久了会去做点自己的事。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = await mkdtemp(join(tmpdir(), 'moodv2-body-'))
process.env.DSH_HOME = home

const mod = await import('../index.js')
const sections = []
let service = null
const routes = new Map()
const ctx = {
  on: () => () => {},
  effect(fn) { const off = fn(); return () => off?.() },
  systemPrompt: { context(section) { sections.push(section); return () => {} } },
  webServer: { register(route) { routes.set(route.path, route.handler); return () => {} } },
  provide(name, value) { if (name === 'moodV2') service = value },
}
mod.apply(ctx, { enabled: true })
const line = () => sections.at(-1).text()

const fakeRes = () => ({ statusCode: 0, body: '', setHeader() {}, end(chunk) { this.body = String(chunk || '') } })
const call = async (path, body) => {
  const res = fakeRes()
  const req = { method: body ? 'POST' : 'GET', on(event, fn) { if (event === 'data' && body) fn(JSON.stringify(body)); if (event === 'end') fn() } }
  await routes.get(path)(req, res)
  return JSON.parse(res.body)
}

// 1) 饿了（0.82，还没到自动去吃的 0.85）：注入里要提身体
const hungry = await call('/mood-v2/nudge', { body: { hunger: 0.82, sleepDebt: 0.1, ache: 0 } })
assert.ok(hungry.ok)
const hungryLine = line()
assert.match(hungryLine, /身体上：.*有点饿/, `饿的时候应该提一句：${hungryLine}`)

// 2) 难受 + 自己去做点事（把随机数压到必触发）
const originalRandom = Math.random
Math.random = () => 0.1
try {
  await call('/mood-v2/nudge', { valence: -0.5, event: '测试：难受' })
  const before = service.read().valence
  // text() 里会调用 maybeSoothe
  await new Promise(r => setTimeout(r, 20))
  const after = line()
  assert.match(after, /去楼下|热水澡|耳机|窗户/, `难受时应该会去做点什么：${after}`)
  assert.ok(service.read().valence >= before - 0.01, '做点什么之后不该更难受')
} finally {
  Math.random = originalRandom
}

// 3) 缺觉也会写进注入
await call('/mood-v2/nudge', { body: { hunger: 0.2, sleepDebt: 0.8, ache: 0 } })
assert.match(line(), /没睡够/, '缺觉时应该提一句')

// 4) 一切正常时不提身体（不刷屏）
await call('/mood-v2/nudge', { body: { hunger: 0.2, sleepDebt: 0.1, ache: 0 } })
assert.doesNotMatch(line(), /身体上：/, '正常的时候不该提身体')

await new Promise(r => setTimeout(r, 100))
await rm(home, { recursive: true, force: true }).catch(() => {})
console.log('body test: all assertions passed')
