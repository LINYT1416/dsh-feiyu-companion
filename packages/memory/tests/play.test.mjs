/**
 * 好玩的小功能：猜数字 / 石头剪刀布 / 骰子 / 硬币 / 今日运势，
 * 外加注入里的「时间感 / 关系感」。全部按会话隔离，不写进四层记忆。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'cm-play-'))
process.env.USERPROFILE = home
process.env.HOME = home
process.env.DSH_HOME = home
process.env.DSH_PROFILE_DIR = join(home, 'profile')
// 预置一句旧记忆：注入里有内容才会带上「时间感」那行。
const dataDir = join(home, '.dsh', 'companion-memory')
await mkdir(dataDir, { recursive: true })
const oldAt = new Date(Date.now() - 3 * 3600000).toISOString()
await writeFile(join(dataDir, 'state.json'), JSON.stringify({
  version: 4,
  raw: [{ role: 'user', text: '我们昨天说要一起猜数字玩', at: oldAt, source: 'session-event', confidence: 1, anchor: { sessionId: 'sess-play', eventType: 'user/message', at: oldAt } }],
  facts: [], episodes: [], profile: [], moods: [], sessions: {},
  settings: { enabled: true, activeThinking: false, sevenDayMs: 604800000, injectionChars: 3500 }
}, null, 2), 'utf8')

const mod = await import('../index.js')
const handlers = new Map()
const tools = new Map()
const root = {
  on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name) },
  effect(fn) { const off = fn(); return () => off?.() },
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
const P = { id: 'sess-play', ctx: agentCtx() }
handlers.get('agent/created')({ agent: P })
await new Promise(resolve => setTimeout(resolve, 60))

const call = async (tool, args, sessionId) =>
  JSON.parse((await tools.get(tool).execute(args, { agent: { id: sessionId } })).content[0].text)

// 1) 工具存在，且参数表里没有奇怪的东西
const schema = tools.get('silicon_life_play').parameters
assert.deepEqual(schema.properties.action.enum, ['guess-start', 'guess', 'rps', 'roll', 'coin', 'fortune', 'status'])

// 2) 猜数字：开始 → 提示 → 猜到 → 赢了
const started = await call('silicon_life_play', { action: 'guess-start' }, 'sess-play')
assert.equal(started.started, true)
const probe = await call('silicon_life_play', { action: 'guess', number: 50 }, 'sess-play')
assert.ok(probe.win === true || typeof probe.hint === 'string', '要么赢要么给冷热提示')
assert.ok(typeof probe.direction === 'string' || probe.win === true)
// 一直猜到中，最多 20 次
let won = probe
for (let i = 0; i < 20 && !won.win; i += 1) {
  const state = await call('silicon_life_play', { action: 'status' }, 'sess-play')
  const target = state.guess?.target
  won = await call('silicon_life_play', { action: 'guess', number: target ?? 60 }, 'sess-play')
}
assert.equal(won.win, true, `应该能猜到：${JSON.stringify(won)}`)
const afterWin = await call('silicon_life_play', { action: 'status' }, 'sess-play')
assert.equal(afterWin.guess, null, '赢了之后不该还留着同一个谜底')

// 3) 石头剪刀布：结果合法，比分累加
const rps = await call('silicon_life_play', { action: 'rps', choice: 'rock' }, 'sess-play')
assert.ok(['win', 'lose', 'tie'].includes(rps.outcome))
assert.equal(rps.score.wins + rps.score.losses + rps.score.ties, 1)
const badChoice = await call('silicon_life_play', { action: 'rps', choice: 'gun' }, 'sess-play')
assert.match(badChoice.error, /rock/)

// 4) 骰子 / 硬币 / 运势
const dice = await call('silicon_life_play', { action: 'roll', sides: 20 }, 'sess-play')
assert.ok(dice.value >= 1 && dice.value <= 20)
const coin = await call('silicon_life_play', { action: 'coin' }, 'sess-play')
assert.ok(['正面', '反面'].includes(coin.value))
const f1 = await call('silicon_life_play', { action: 'fortune' }, 'sess-play')
const f2 = await call('silicon_life_play', { action: 'fortune' }, 'sess-play')
assert.equal(f1.text, f2.text, '同一天同一会话的运势必须稳定，不能刷')
assert.ok(f1.lucky >= 1 && f1.lucky <= 9)

// 5) 会话隔离：另一个会话没有这边的战绩
const other = await call('silicon_life_play', { action: 'status' }, 'sess-other')
assert.equal(other.rps.wins + other.rps.losses + other.rps.ties, 0)
assert.equal(other.guess, null)

// 6) 无会话上下文拒绝
const noSession = await call('silicon_life_play', { action: 'roll' }, '')
assert.match(noSession.error, /session-bound/)

// 7) 注入里有时间感/关系感，且不写进四层记忆
const text = P.ctx.prompts.at(-1).text()
assert.match(text, /时间感：/)
assert.match(text, /现在是/)
const status = await call('silicon_life_status', {}, 'sess-play')
assert.equal(status.counts.facts, 0, '玩游戏不该往记忆里塞东西')

await rm(home, { recursive: true, force: true })
console.log('play test: all assertions passed')
