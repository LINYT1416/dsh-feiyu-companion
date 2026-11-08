/**
 * 记一笔：强情绪会生出「想写下来」的冲动；写下去之后冲动消失、心情松一点。
 * 同时验证 feiyu_journal_write 真的把字写进了 her 的本子。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = await mkdtemp(join(tmpdir(), 'cm-journal-write-'))
process.env.USERPROFILE = home
process.env.HOME = home
process.env.DSH_HOME = home
process.env.DSH_PROFILE_DIR = join(home, 'profile')
const dataDir = join(home, '.dsh', 'companion-memory')
const journalDir = join(home, '.dsh', 'feiyu-journal')
await mkdir(dataDir, { recursive: true })
await mkdir(journalDir, { recursive: true })
const now = new Date().toISOString()
await writeFile(join(dataDir, 'state.json'), JSON.stringify({
  version: 4, raw: [], facts: [], episodes: [], profile: [], moods: [], sessions: {},
  persona: { name: '大肥鱼', description: '', userAddress: '', likes: '', dislikes: '', values: '', voice: '', samples: '', systemPrompt: '你叫大肥鱼。' },
  settings: { enabled: true, stickerFrequency: 'off', sevenDayMs: 604800000, injectionChars: 3500 },
}, null, 2), 'utf8')

const mod = await import('../index.js')
const handlers = new Map()
const tools = new Map()
const root = {
  on(name, fn) { handlers.set(name, fn); return () => {} },
  effect(fn) { const off = fn(); return () => off?.() },
  get: () => undefined,
  tools: { register(tool) { tools.set(tool.name, tool); return () => {} }, get(name) { return tools.get(name) } },
  systemPrompt: { context: () => () => {} },
  webServer: { register: () => () => {} },
  agents: { list: () => [] },
}
mod.apply(root)
await new Promise(r => setTimeout(r, 150))

const writeTool = tools.get('feiyu_journal_write')
assert.ok(writeTool, '应该有写本子的工具')

const run = async (sessionId, input) => {
  const agent = { id: sessionId, ctx: { on: () => () => {}, tools: { register: () => () => {} }, systemPrompt: { context: () => () => {} } } }
  handlers.get('agent/created')({ agent })
  const out = await writeTool.execute(input, { agent, sessionId })
  const text = out?.content?.[0]?.text || '{}'
  try { return JSON.parse(text) } catch { return { raw: text } }
}

// 1) 写念头：文件里出现这一条
const thoughtRes = await run('sess-w', { kind: 'thought', text: '今天把那件事做完了，我有点想哭' })
const thoughts = await readFile(join(journalDir, 'thoughts.jsonl'), 'utf8')
assert.match(thoughts, /有点想哭/, `念头应该写进本子：${thoughts}`)
assert.equal(thoughtRes.saved, 'thought')

// 2) 写日记：当天文件里出现这一小段
const day = new Date().toISOString().slice(0, 10)
await run('sess-w', { kind: 'diary', text: '今天跟他拌了两句嘴，其实我没那么气。' })
const diary = await readFile(join(journalDir, 'diary', `${day}.md`), 'utf8')
assert.match(diary, /拌了两句嘴/, `日记应该写到今天：${diary}`)

// 3) 空内容要拒绝，不能写空行
const bad = await run('sess-w', { kind: 'thought', text: '   ' })
assert.ok(bad.error, '空内容应该被拒绝')

await new Promise(r => setTimeout(r, 100))
await rm(home, { recursive: true, force: true }).catch(() => {})
console.log('journal write test: all assertions passed')
