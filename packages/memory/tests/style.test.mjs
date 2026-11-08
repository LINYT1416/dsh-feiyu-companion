/**
 * 习惯层 / 说不出口层：同一份心情要能换着口气说；防备高时允许拒绝。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = await mkdtemp(join(tmpdir(), 'cm-style-'))
process.env.USERPROFILE = home
process.env.HOME = home
process.env.DSH_HOME = home
process.env.DSH_PROFILE_DIR = join(home, 'profile')
const dataDir = join(home, '.dsh', 'companion-memory')
await mkdir(dataDir, { recursive: true })
const now = new Date().toISOString()
await writeFile(join(dataDir, 'state.json'), JSON.stringify({
  version: 4, raw: [], facts: [], episodes: [], profile: [], moods: [], sessions: {},
  persona: { name: '大肥鱼', description: '', userAddress: '', likes: '', dislikes: '', values: '', voice: '', samples: '', systemPrompt: '你叫大肥鱼。' },
  settings: { enabled: true, stickerFrequency: 'off', sevenDayMs: 604800000, injectionChars: 3500 },
}, null, 2), 'utf8')

const mod = await import('../index.js')
const moodV2 = { current: null, read() { return this.current } }
const handlers = new Map()
const root = {
  on(name, fn) { handlers.set(name, fn); return () => {} },
  effect(fn) { const off = fn(); return () => off?.() },
  get(name) {
    if (name === 'moodV2') return moodV2
    if (name === 'humanMemory') return { read: () => ({ episodes: [{ summary: '那次在便利店门口等你的晚上' }] }) }
    return undefined
  },
  tools: { register: () => () => {}, get: () => null },
  systemPrompt: { context: () => () => {} },
  webServer: { register: () => () => {} },
  agents: { list: () => [] },
}
mod.apply(root)
await new Promise(r => setTimeout(r, 120))

const agentFor = id => {
  const prompts = []
  const ctx = { on: () => () => {}, tools: { register: () => () => {} }, systemPrompt: { context(s) { prompts.push(s); return () => {} } } }
  handlers.get('agent/created')({ agent: { id, ctx } })
  return { id, text: () => prompts.at(-1)?.text() || probes.set }
}
const probes = new Map()
const agent = agentFor('sess-1')
const text = () => {
  handlers.get('session/event')({ id: 'sess-1' }, { type: 'user/message', data: { text: '在吗' } })
  return agent.text()
}

// 0) 一条就是一条：不能换行分段（QQ 会把空行原样显示）
assert.match(text(), /不换行、?不空行/, '要明确禁止换行分段')

// 0.5) 人格/心情/身体/印象/本子要合成一句「这会儿的她」
await mkdir(join(home, 'feiyu-journal'), { recursive: true })
await writeFile(join(home, 'feiyu-journal', 'thoughts.jsonl'), JSON.stringify({ ts: Math.floor(Date.now() / 1000), text: '想他，但是不想先开口' }) + '\n', 'utf8')

// 1) 累的时候：语气变短，出现「打字习惯」
moodV2.current = { valence: 0.1, energy: 0.2, mask: 0, label: '还行', surface: '', mind: { social: -0.2, patience: -0.2, guard: -0.1, comfort: 0 }, emotions: [], ledger: [] }
const tired = text()
assert.match(tired, /这条的打字习惯：/, `应该有打字习惯：${tired}`)
assert.match(tired, /短|咽回去|一句话/, `累时应该让她说短：${tired}`)

// 2) 防备高：给一句「可以不说」的许可，但要求正事照做
moodV2.current = { valence: -0.3, energy: 0.5, mask: 0.4, label: '有点不乐意', surface: '', mind: { guard: 0.5 }, emotions: [], ledger: [] }
const guarded = text()
assert.match(guarded, /不想说/, `防备高时要允许拒绝：${guarded}`)
assert.match(guarded, /正事|做完/, '拒绝也要说明正事不能打折')

// 3) 心情好：风格换成另一种，不是同一句
moodV2.current = { valence: 0.5, energy: 0.6, mask: 0, label: '开心', surface: '', mind: { comfort: 0.2 }, emotions: [], ledger: [] }
const happy = text()
assert.match(happy, /这条的打字习惯：/)
assert.notEqual(happy.match(/这条的打字习惯：.*/)?.[0], tired.match(/这条的打字习惯：.*/)?.[0], '心情不同，打字习惯那句不能一模一样')

// 4) 没有心情插件：不注入这两行，也不报错
moodV2.current = null
const plain = text()
assert.ok(!/这条的打字习惯：/.test(plain), '没有心情时不该硬编风格')

await new Promise(r => setTimeout(r, 100))
await rm(home, { recursive: true, force: true }).catch(() => {})
console.log('style→speech test: all assertions passed')
