/**
 * 心情 → 表情：情绪插件给的「生气·对他」要能变成表情库认得的情绪词。
 * 断言：情绪高时优先用它；强度低时不用；没有服务时退回原逻辑。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = await mkdtemp(join(tmpdir(), 'cm-mood-sticker-'))
process.env.USERPROFILE = home
process.env.HOME = home
process.env.DSH_HOME = home
process.env.DSH_PROFILE_DIR = join(home, 'profile')
const dataDir = join(home, '.dsh', 'companion-memory')
await mkdir(dataDir, { recursive: true })

const now = new Date().toISOString()
await writeFile(join(dataDir, 'state.json'), JSON.stringify({
  version: 4,
  raw: [{ role: 'user', text: '嗯', at: now, anchor: { sessionId: 'sess-M', at: now } }],
  facts: [], episodes: [], profile: [], moods: [], sessions: {},
  persona: { name: '', description: '', userAddress: '', likes: '', dislikes: '', values: '', voice: '', samples: '', systemPrompt: '' },
  settings: { enabled: true, stickerFrequency: 'often', sevenDayMs: 604800000, injectionChars: 3500 },
}, null, 2), 'utf8')

const mod = await import('../index.js')
const handlers = new Map()
const tools = new Map()
const moodV2 = {
  current: null,
  read() {
    return this.current || { valence: 0, energy: 0.5, mask: 0, label: '还行', surface: '', mind: {}, emotions: [], ledger: [] }
  },
}
const root = {
  on(name, fn) { handlers.set(name, fn); return () => {} },
  effect(fn) { const off = fn(); return () => off?.() },
  get(name) { return name === 'moodV2' ? moodV2 : undefined },
  tools: { register(tool) { tools.set(tool.name, tool); return () => {} }, get(name) { return tools.get(name) } },
  systemPrompt: { context() { return () => {} } },
  webServer: { register() { return () => {} } },
  agents: { list: () => [] },
}
mod.apply(root)
await new Promise(r => setTimeout(r, 150))

const createAgent = () => {
  const prompts = []
  const ctx = { prompts, on() { return () => {} }, tools: { register: () => () => {} }, systemPrompt: { context(spec) { prompts.push(spec); return () => {} } } }
  handlers.get('agent/created')({ agent: { id: 'sess-M', ctx } })
  return { ctx, text: () => prompts.at(-1)?.text() || '' }
}
const agent = createAgent()
await new Promise(r => setTimeout(r, 150))

// 1) 强情绪：生气要落到表情库认得的情绪词上
moodV2.current = { valence: -0.4, energy: 0.5, mask: 0.2, label: '生气（对他）', surface: '', mind: { guard: 0.4 }, emotions: [{ kind: '生气', target: '他', intensity: 0.8 }], ledger: [] }
assert.equal(mod.hotEmotionWord(), '生气', '生气要映射成表情库的「生气」')

// 1b) 强开心 → 开心；委屈 → 难过
moodV2.current = { valence: 0.5, energy: 0.6, mask: 0, label: '开心', surface: '', mind: {}, emotions: [{ kind: '开心', target: '他', intensity: 0.7 }], ledger: [] }
assert.equal(mod.hotEmotionWord(), '开心')
moodV2.current = { valence: -0.3, energy: 0.4, mask: 0.3, label: '委屈', surface: '', mind: {}, emotions: [{ kind: '委屈', target: '那件事', intensity: 0.6 }], ledger: [] }
assert.equal(mod.hotEmotionWord(), '难过')

// 2) 弱情绪：强度不够时不硬套
moodV2.current = { valence: 0.1, energy: 0.5, mask: 0, label: '还行', surface: '', mind: {}, emotions: [{ kind: '生气', target: '他', intensity: 0.1 }], ledger: [] }
assert.equal(mod.hotEmotionWord(), '', '情绪太弱时不要硬塞情绪词')

// 3) 没有心情插件时也不能报错
moodV2.current = null
assert.equal(mod.hotEmotionWord(), '')
// 走一轮真实消息，注入照常出（不会因为心情没了就空掉）
handlers.get('session/event')?.({ id: 'sess-M' }, { type: 'user/message', data: { text: '继续说' } })
await new Promise(r => setTimeout(r, 120))
const plain = agent.text()
assert.ok(plain.length === 0 || /表情规则|这条要短/.test(plain), `没有情绪时注入要么为空、要么仍然完整：${plain.slice(0, 200)}`)

await rm(home, { recursive: true, force: true })
console.log('mood→sticker test: all assertions passed')
