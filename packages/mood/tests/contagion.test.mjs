/**
 * 情绪传染 + 期待落空（P8）
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = await mkdtemp(join(tmpdir(), 'moodv2-contagion-'))
process.env.DSH_HOME = home

const now = new Date()
const pad = n => String(n).padStart(2, '0')
const day = now.toISOString().slice(0, 10)
const dayDir = join(home, 'daily-schedule', 'days')
await mkdir(dayDir, { recursive: true })
// 日程里没有「看展」→ 那句期待会落空
await writeFile(join(dayDir, `${day}.json`), JSON.stringify({
  date: day,
  mood: '平平的一天',
  items: [{ start: `${pad(Math.max(0, now.getHours() - 1))}:00`, end: `${pad(Math.min(23, now.getHours() + 1))}:00`, activity: '在家待着' }],
}), 'utf8')

const mod = await import('../index.js')
const sections = []
const routes = new Map()
let service = null
const handlers = new Map()
const ctx = {
  on(name, fn) { handlers.set(name, fn); return () => {} },
  effect(fn) { const off = fn(); return () => off?.() },
  systemPrompt: { context(section) { sections.push(section); return () => {} } },
  webServer: { register(route) { routes.set(route.path, route.handler); return () => {} } },
  provide(name, value) { if (name === 'moodV2') service = value },
}
mod.apply(ctx, { enabled: true })
const line = () => sections.at(-1).text()
const send = async text => {
  handlers.get('session/event')({ id: 's' }, { type: 'user/message', data: { text } })
  await new Promise(r => setTimeout(r, 60))
}
const fakeRes = () => ({ statusCode: 0, body: '', setHeader() {}, end(chunk) { this.body = String(chunk || '') } })
const nudge = async body => {
  const res = fakeRes()
  const req = { method: 'POST', on(event, fn) { if (event === 'data') fn(JSON.stringify(body)); if (event === 'end') fn() } }
  await routes.get('/mood-v2/nudge')(req, res)
  return JSON.parse(res.body)
}

// 1) 他难受：心情跟着沉一点，想被哄升
const before = service.read()
await send('今天好累，被骂了，心情不好')
const after = service.read()
assert.ok(after.valence < before.valence, `传染要生效：${before.valence} -> ${after.valence}`)
assert.ok(after.mind.comfort > before.mind.comfort, '他难受时她的「想被哄」该上来')

// 2) 半小时内不重复传染
const mid = service.read().valence
await send('嗯，知道了')
assert.ok(Math.abs(service.read().valence - mid) < 0.02, '半小时内不该叠加：' + mid + ' -> ' + service.read().valence)

// 3) 期待落空：本来要去看展，日程里没有 → 难受 + 落下一件小事
const beforeMiss = service.read().valence
await nudge({ expect: { label: '看展', when: new Date(Date.now() - 40 * 60_000).toISOString(), valence: 0.8, strength: 0.8 } })
for (let i = 0; i < 25 && !/没去成/.test(line()); i += 1) {
  await send('嗯')
  await new Promise(r => setTimeout(r, 60))
}
const missed = service.read()
assert.ok(missed.valence < beforeMiss + 0.01, `落空不该让她更开心：${beforeMiss} -> ${missed.valence}`)
assert.match(line(), /本来要去的看展没去成/, `注入里要留下这件事：${line()}`)

await new Promise(r => setTimeout(r, 100))
await rm(home, { recursive: true, force: true }).catch(() => {})
console.log('contagion & expectation test: all assertions passed')
