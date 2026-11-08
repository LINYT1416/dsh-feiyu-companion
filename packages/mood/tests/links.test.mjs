/**
 * 性格 → 心情、日程 → 心情（P5）。
 * 断言：傲娇把「装」的基线抬起来；心软把「想被哄」的基线抬起来；
 *       日程里在上班会落一条「在上班」的小事，而且同一格只算一次。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = await mkdtemp(join(tmpdir(), 'moodv2-links-'))
process.env.DSH_HOME = home

// 造一份「现在这一刻」的日程：把当前时间包进一格「上班」
const now = new Date()
const pad = n => String(n).padStart(2, '0')
const start = `${pad(Math.max(0, now.getHours() - 1))}:00`
const end = `${pad(Math.min(23, now.getHours() + 1))}:00`
const day = now.toISOString().slice(0, 10)
const dayDir = join(home, 'daily-schedule', 'days')
await mkdir(dayDir, { recursive: true })
await writeFile(join(dayDir, `${day}.json`), JSON.stringify({
  date: day,
  mood: '今天有点累，但也还行',
  items: [{ start, end, activity: '写代码', location: '公司', detail: '修 bug' }],
}), 'utf8')

const mod = await import('../index.js')
const sections = []
let service = null
const ctx = {
  on: () => () => {},
  effect(fn) { const off = fn(); return () => off?.() },
  systemPrompt: { context(section) { sections.push(section); return () => {} } },
  webServer: { register: () => () => {} },
  provide(name, value) { if (name === 'moodV2') service = value },
}
mod.apply(ctx, { enabled: true })
const line = () => sections.at(-1).text()

// 1) 性格 → 心情：傲娇 + 心软
service.tune({ traits: '小傲娇，很顽皮，心软护短' })
const tuned = service.read().traits
assert.ok(tuned.maskBase > 0, `傲娇要抬起「装」的基线：${JSON.stringify(tuned)}`)
assert.ok(tuned.comfortBase > 0, `心软要抬起「想被哄」：${JSON.stringify(tuned)}`)
assert.ok(service.read().mask > 0, '调完当场就要往基线靠一点')

// 2) 情绪化会让起伏更大
service.tune({ traits: '有点情绪化' })
assert.ok(service.read().traits.driftMul > 1, '情绪化要让心情更容易起伏')

// 3) 日程 → 心情：当前这格是上班，会落一条小事
for (let i = 0; i < 20 && !/在上班/.test(line()); i += 1) await new Promise(r => setTimeout(r, 50))
const withSchedule = line()
assert.match(withSchedule, /在上班：写代码/, `日程要进注入：${withSchedule}`)

// 4) 同一格不重复消化：再取几次注入，小事不会变成一串
const firstCount = (withSchedule.match(/在上班/g) || []).length
await new Promise(r => setTimeout(r, 80))
const again = line()
assert.ok((again.match(/在上班/g) || []).length <= firstCount + 1, '同一格日程不该反复刷')

await new Promise(r => setTimeout(r, 120))
await rm(home, { recursive: true, force: true }).catch(() => {})
console.log('traits→mood & schedule→mood test: all assertions passed')
