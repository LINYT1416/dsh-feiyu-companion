/**
 * 多因素心境（P6）：长期心性 + 眼前的事 + 还没发生的事 + 身体，合成一个心境；
 * 并且要把「主要是被什么推的」说出来。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = await mkdtemp(join(tmpdir(), 'moodv2-factors-'))
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

const base = service.read().moodNow

// 1) 长期心性：天生偏闷一点，整体心境就被压下去（但压不到人格之外）
await call('/mood-v2/nudge', { longTerm: { valence: -0.7, comfort: 0 } })
const gloomy = service.read()
assert.ok(gloomy.moodNow < base, `长期低落应该压低心境：${base} -> ${gloomy.moodNow}`)
assert.ok(gloomy.moodNow >= -0.65, `不许掉出基线 ±0.75：${gloomy.moodNow}`)

// 2) 预期：越临近影响越大（明天不情愿 vs 一周后）
await call('/mood-v2/nudge', { longTerm: { valence: 0, comfort: 0 } })
const before = service.read().moodNow
await call('/mood-v2/nudge', { expect: { label: '明天要早起', when: new Date(Date.now() + 20 * 3600_000).toISOString(), valence: -0.8, strength: 0.8 } })
const tomorrow = service.read().moodNow
await call('/mood-v2/nudge', { expectClear: true })
await call('/mood-v2/nudge', { expect: { label: '一周后的事', when: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(), valence: -0.8, strength: 0.8 } })
const week = service.read().moodNow
assert.ok(tomorrow < before, `不情愿的事提前压心情：${before} -> ${tomorrow}`)
assert.ok(week >= tomorrow, `还早的事影响更小：${week} 应 >= ${tomorrow}`)

// 3) 期待的事会托起来
await call('/mood-v2/nudge', { expectClear: true })
await call('/mood-v2/nudge', { expect: { label: '周末去吃那家店', when: new Date(Date.now() + 3 * 3600_000).toISOString(), valence: 0.9, strength: 0.9 } })
const looking = service.read()
assert.ok(looking.moodNow > week, `期待的事应该托起来：${week} -> ${looking.moodNow}`)

// 4) 注入里要说出来：后面压着什么事、主要被什么推的
const text = line()
assert.match(text, /后面还有件事压在心上：周末去吃那家店/, `要提预期：${text}`)
assert.match(text, /这一刻的心情主要来自：/, `要归因：${text}`)

// 5) 身体也能单独成为主因（熬夜 + 饿）
await call('/mood-v2/nudge', { body: { sleepDebt: 0.9, hunger: 0.9 } })
const tired = service.read()
assert.ok(tired.moodNow <= looking.moodNow, '缺觉+饿不能更开心')
assert.match(tired.source, /身体状态|后面还没发生的事/, `身体要能被指出来：${tired.source}`)

// 6) 日子会留印子：昨天一整天都不痛快，今天的底子会沉一点
const beforeDay = service.read().moodNow
await call('/mood-v2/nudge', { dayTally: { day: '2000-01-01', sum: -6, n: 4 } })
await call('/mood-v2/nudge', { expectClear: true })
const afterDay = service.read()
assert.ok(Number(afterDay.traits.dayBase) < 0, `昨天的坏心情要沉进底子：${JSON.stringify(afterDay.traits)}`)
assert.ok(afterDay.moodNow <= beforeDay + 0.01, '底子沉了，今天不该更轻松')
await new Promise(r => setTimeout(r, 100))
await rm(home, { recursive: true, force: true }).catch(() => {})
console.log('mood factors test: all assertions passed')
