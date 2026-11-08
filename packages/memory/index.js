import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname as pathJoinDirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
const readFileSync2 = readFileSync
import { scoreImportance, classifyTier, tierOfRow, summarizeTiers, shouldPromote, TIER_LABEL } from './tiers.js'
import { rollupMonths, rollupYears } from './chronicle.js'
import { buildRollupPrompt, cleanSummary, shouldAcceptSummary, hashInputs } from './summary.js'
import { extractSelfFacts, looksLikeSpeech } from './extract.js'
import { makeTick, selfCheck } from './auto-iter.js'
import { pickFreshLines } from './digest.js'
import { buildThreadsPrompt, parseThreads, threadsSignature } from './threads.js'
import { vectorsFor, vectorsForLoose, coverage, warm } from './embed/embedder.js'
import { makeIndex, makeVectorIndex, rrf, mmr, toAtoms, atomAlive, finalScore, intentBonus, sweepAtoms } from './memory-engine.js'
import { bucketize, promotionOf, condenseForOverflow } from './memory-policy.js'
import { runHousekeeping } from './housekeeping.js'

const DATA_DIR = join(homedir(), '.dsh', 'companion-memory')
const DATA_FILE = join(DATA_DIR, 'state.json')
// 手抄本：一个纯文本的「重要记忆」文件，只在磁盘上、只增不减，不参与任何淘汰。
// 她可以自己用记事本改，我也可以在需要时往里加一行；每次注入都先念它。
const 手抄本 = join(DATA_DIR, '重要记忆.md')

/** 读手抄本：去掉 # 注释和空行，返回纯条目数组。文件不在就是空。 */
function 读手抄本() {
  try {
    const 文 = readFileSync(手抄本, 'utf8')
    return 文.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.replace(/^[-*]\s*/, ''))
  } catch { return [] }
}

/** 往手抄本追加一行；同一句话已经有了就不重复写。 */
function 记手抄本(文字, 日期 = '') {
  const 净 = String(文字 || '').replace(/\s+/g, ' ').trim()
  if (净.length < 4) return false
  const 已有 = 读手抄本()
  if (已有.some((x) => x === 净 || x.includes(净) || 净.includes(x))) return false
  try {
    if (!existsSync(手抄本)) writeFileSync(手抄本, '# 重要记忆（手抄本）\n# 这里的东西不参与淘汰，每次都会先念一遍。可以自己改。\n\n', 'utf8')
    const 戳 = 日期 ? String(日期).slice(0, 10) : new Date().toISOString().slice(0, 10)
    writeFileSync(手抄本, readFileSync(手抄本, 'utf8').replace(/\s*$/, '') + `\n- [${戳}] ${净}\n`, 'utf8')
    return true
  } catch { return false }
}

/** 读她自己手写的日记（~/.dsh/feiyu-life/diary/*.md）：最近两天各取头一段。 */
function 读手写日记(天 = 2) {
  try {
    const 目录 = join(homedir(), '.dsh', 'feiyu-life', 'diary')
    const 文件们 = readdirSync(目录).filter((f) => f.endsWith('.md')).sort().slice(-天)
    const 出 = []
    for (const f of 文件们) {
      const 原文 = readFileSync(join(目录, f), 'utf8')
      const 段 = 原文.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, '').trim()).filter((l) => l && !l.startsWith('- '))
      const 文 = 段.join(' ').replace(/\s+/g, ' ').trim()
      // 只有标题/日期的空壳文件跳过，别把「2026-11-06」当日记念出来
      if (!文 || 文.length < 6 || /^\d{4}-\d{2}-\d{2}/.test(文) && 文.length < 16) continue
      if (文) 出.push({ day: f.replace(/\.md$/, ''), text: 文.length > 120 ? 文.slice(0, 120) + '…' : 文 })
    }
    return 出
  } catch { return [] }
}

/** 第一次用：把已经是「永久」的记忆抄进来，省得手抄本空着。 */
function 抄一下永久记忆() {  try {
    const 池 = ['facts', 'profile', 'episodes', 'raw'].flatMap((b) => state?.data?.[b] || [])
    // 只抄「像身份事实」的那类：群聊里的寒暄就算被抬成永久，也不该进手抄本。
    const 身份味 = /uid|昵称|名字|生日|称呼|喜欢|讨厌|不吃|过敏|住|电话|号/i
    const 永久 = 池.filter((r) => r && r.tier === '永久' && 身份味.test(String(r.text || '')))
    let 抄了 = 0
    for (const r of 永久) if (记手抄本(r.text, r.at)) 抄了 += 1
    return 抄了
  } catch { return 0 }
}
const DAY = 86400000
const LIMITS = { raw: 1000, facts: 300, profile: 120, episodes: 300, diary: 120, thoughts: 160, purposes: 100, moods: 300 }
const DEFAULT_SETTINGS = {
  // 人格段和记忆段各自有上限和开关：记忆再多也不会把人格挤掉。
  personaInject: true,
  memoryInject: true,
  personaChars: 3200,
  memoryChars: 3600, enabled: true, activeThinking: false, modelSummary: true, modelDailyCap: 40, stickerFrequency: 'normal', sevenDayMs: 7 * DAY, injectionChars: 3500 }
// 人格默认是「一张白纸」：不预设名字、性格、三观、说话方式，全部由用户在设置里定义。
// 只有用户真正填了东西，注入里才会出现对应段落——没填就当没这回事。
const DEFAULT_PERSONA = { name: '', description: '', userAddress: '', likes: '', dislikes: '', values: '', voice: '', samples: '', systemPrompt: '' }
const DEFAULT_PERSONALITY = { warmth: 50, curiosity: 50, pragmatism: 50, traits: '' }
const DEFAULT_MOOD_SETTINGS = { taxonomy: ['喜悦', '悲伤', '愤怒', '恐惧', '厌恶', '惊讶', '平静'], decayHours: 72, maxDelta: 0.25 }
const MEMORY_LAYERS = ['archive', 'facts', 'episodes', 'profile']
const defaults = () => ({ version: 4, raw: [], facts: [], profile: [], episodes: [], diary: [], threads: {}, thoughts: [], purposes: [], moods: [], games: {}, insideJokes: {}, trends: [], stickerRefresh: null, persona: { ...DEFAULT_PERSONA }, personality: { ...DEFAULT_PERSONALITY }, personaPresets: [], moodSettings: { ...DEFAULT_MOOD_SETTINGS }, thresholds: { happiness: 60 }, settings: { ...DEFAULT_SETTINGS }, sessions: {}, quotas: {} })
const state = { loaded: false, loading: null, data: defaults(), saving: Promise.resolve() }
// 运行态诊断：注入是否真的挂到了 Agent 上下文（不是只生成了字符串）。
const runtime = { mountedAgents: 0, lastMountAt: null, lastInjectChars: 0, lastSummaryError: null, lastRefinedAt: null, lastModelConfig: null, liveAgents: [], stickers: null, meme: null, moodV2: null, getMoodV2: null }
const now = () => new Date().toISOString()
const clean = (v, max = 1200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const textOf = v => typeof v === 'string' ? v : Array.isArray(v) ? v.map(textOf).join(' ') : v && typeof v === 'object' ? textOf(v.text ?? v.content ?? v.message ?? v.blocks) : ''
const isHarnessNoise = value => {
  const text = String(value || '')
  return text.includes('<goal_') || text.includes('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.') || text.includes('Approval prompts are disabled in this session') || text.includes('Companion 状态与记忆') || text.includes('【你记得的事】') || text.includes('<system-reminder>') || text.includes('available skill catalog changed') || text.includes('Delegation depth for') || text.includes('Time sampled while preparing turn') || text.includes('Browser time zone for this request') || text.includes('Elapsed since the preceding step context') || /This is an automatically generated checkpoint condensing an earlier span/i.test(text) || text.includes('<compacted-summary>') || /\[model changed:\s*assistant turns above this point/i.test(text) || /Your parent agent id is\s*['"]session-/i.test(text) || /^(?:\*\*?Evaluating|\*\*?Planning|\*\*?Validating)\b/i.test(text.trim()) || /^(?:Background )?[Ss]ubagent\s+[0-9a-f-]{8,}\s+(?:finished|failed)\b/.test(text.trim()) || /\bAgent\s+(?:session-)?[0-9a-f-]{8,}\s+sent a message:/.test(text) || /^Agent\s+(?:session-)?[0-9a-f-]{8,}\s+(?:finished|failed)\b/.test(text.trim()) || /You are repeating the exact same tool call/i.test(text) || /^(?:Background )?[Ss]ubagent\s+(?:session-)?[0-9a-f-]{8,}\b/.test(text.trim()) || text.includes('<tool_call_error>') || /^Tool call failed\b/i.test(text.trim())
}
// 归档里的历史噪声（如早期版本存进来的助手草稿、Harness 通知）不删除，只标记隔离：
// 原文不可变，但注入/检索/展示要能区分「真的用户原话」和「系统灌进来的字」。
const isArchivedNoise = row => isHarnessNoise(row?.text) || (row?.role !== 'user' && row?.role !== 'assistant')
const isConversationRole = role => role === 'user'
const isStorableConversation = (role, body) => isConversationRole(role) && Boolean(body) && !isHarnessNoise(body)
const rowBelongsToSession = (row, sessionId) => {
  const sid = String(sessionId || '').trim()
  return Boolean(sid && row?.anchor?.sessionId && String(row.anchor.sessionId) === sid)
}
const sessionRows = (rows, sessionId) => (rows || []).filter(row => rowBelongsToSession(row, sessionId))
const alreadyRecorded = (sessionId, role, body) => Boolean(sessionId && sessionId !== 'unknown') && state.data.raw.some(row => row.role === role && row.text === body && rowBelongsToSession(row, sessionId))
const clamp = (n, min, max) => Math.max(min, Math.min(max, Number.isFinite(Number(n)) ? Number(n) : 0))
// 配置项只在收到「能变成数字」的值时才改：否则一个手滑的字符串会把滑块清零。
const isNumeric = v => v !== null && v !== '' && Number.isFinite(Number(v))
// 表情包：不重复造一套索引，直接用「nekowhale-stickers」暴露的 stickers 服务。
// 它给 URL（网页用）和本地文件（QQ 桥按 markdown 图发送）。
const STICKER_MOOD_WORDS = { 很好: '开心 高兴', 不错: '开心 轻松', 平静: '平静 嗯', 有点低落: '难过 低落', 很低落: '难过 委屈' }
// 心情插件给的具体情绪（「生气·对他」）→ 表情库认得的情绪词。没有就返回空。
const EMOTION_TO_STICKER = { 开心: '开心', 得意: '开心', 安心: '平静', 生气: '生气', 厌烦: '生气', 委屈: '难过', 失望: '难过', 羞耻: '害羞', 心疼: '难过', 紧张: '紧张' }
export function hotEmotionWord() {
  try {
    const mv2 = (typeof runtime.getMoodV2 === 'function' ? runtime.getMoodV2() : null) || runtime.moodV2
    const read = mv2?.read?.()
    const hot = (read?.emotions || [])[0]
    if (!hot || Number(hot.intensity) < 0.3) return ''
    return EMOTION_TO_STICKER[hot.kind] || ''
  } catch { return '' }
}
function stickerQuery(sessionId = '') {
  const last = sessionRows(state.data.raw, sessionId).filter(row => row.role === 'user').at(-1)
  // 语义以「刚说的这句话」为主：去掉 @文件、链接、纯标点，剩下的才是内容。
  const semantic = clean(last?.text, 80)
    .replace(/@"[^"]*"/g, ' ')
    .replace(/@\S+/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[!?。，,、:：;；~～]/g, ' ')
    .trim()
  const feiyu = readFeiyuMood()
  const mood = hotEmotionWord() || (feiyu ? (STICKER_MOOD_WORDS[feiyu.label] || '') : '')
  // 这句话够长就以它为准；太短（「继续」「嗯」）才用心情兜底。
  if (semantic.length >= 6) return semantic.slice(0, 60)
  return [semantic, mood].filter(Boolean).join(' ').slice(0, 60) || '日常 聊天'
}
// 当下大致是什么情绪：具体情绪优先，其次鱼的心情，最后本地最近一条 valence。
function currentEmotionWord() {
  const hot = hotEmotionWord()
  if (hot) return hot
  const feiyu = readFeiyuMood()
  if (feiyu) {
    if (feiyu.label === '很好' || feiyu.label === '不错') return '开心'
    if (feiyu.label === '平静') return '平静'
    return '难过'
  }
  const last = (state.data.moods || []).at(-1)
  if (!last) return ''
  const valence = Number(last.valence) || 0
  if (valence >= 0.3) return '开心'
  if (valence <= -0.3) return '难过'
  return '平静'
}
// 热点词：我可以去网上看现在的梗，再把词记下来；挑表情时优先试这些词，旧的自动过期。
function trendsList() {
  const ttl = 14 * DAY
  const rows = Array.isArray(state.data.trends) ? state.data.trends : []
  return rows.filter(row => row?.term && Date.now() - new Date(row.at).getTime() <= ttl).slice(-30)
}
function trendTool(input) {
  const action = String(input.action || '').trim()
  if (action === 'add') {
    const term = clean(input.term, 40)
    if (!term) return { error: 'term 不能为空' }
    const rows = Array.isArray(state.data.trends) ? state.data.trends : []
    if (rows.some(row => row.term === term)) return { added: false, duplicate: true, total: rows.length }
    state.data.trends = [...rows, { term, source: clean(input.source, 60) || 'web', at: now() }].slice(-30)
    return { added: true, term, total: state.data.trends.length, active: trendsList().length }
  }
  if (action === 'list') return { trends: trendsList(), total: (state.data.trends || []).length }
  if (action === 'clear') {
    const term = clean(input.term, 40)
    const rows = Array.isArray(state.data.trends) ? state.data.trends : []
    const next = term ? rows.filter(row => row.term !== term) : []
    state.data.trends = next
    return { cleared: term || 'all', remaining: next.length }
  }
  return { error: 'action 只能是 add / list / clear' }
}
// 联网更新图库：refresh 只拉清单/知识文件，sync 会把新图也镜像下来（重，按天/按周来）。
async function refreshStickerLibrary({ deep = false } = {}) {
  const kit = runtime.stickers
  if (!kit) return { ok: false, reason: '没有可用的表情服务（没装 nekowhale-stickers？）' }
  try {
    if (typeof kit.refresh === 'function') await kit.refresh()
    let synced = null
    if (deep && typeof kit.sync === 'function') synced = await kit.sync()
    const result = { ok: true, at: now(), synced: Boolean(synced), detail: synced || null }
    state.data.stickerRefresh = { at: result.at, synced: result.synced }
    await save()
    return result
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) }
  }
}
function stickerFrequency() {
  const level = String(state.data.settings?.stickerFrequency || 'normal')
  if (level === 'off') return 0
  if (level === 'rare') return 0.15
  if (level === 'often') return 0.9
  return 0.6
}
// 只在「这条消息值得配图」时准备一张候选，避免每轮都硬塞。
// 优先用 nekowhale-meme 的库（能搜到用户自己导入、打过标签的图）；没装就退回 stickers 插件原本的图包。
const MEME_EMOTIONS = { 开心: ['开心', '大笑', '得意', '卖萌'], 平静: ['平静', '无语'], 难过: ['哭', '无语', '委屈'] }
function memeSearch(query, limit = 12) {
  const meme = runtime.meme
  if (!meme || typeof meme.search !== 'function') return []
  try {
    const res = meme.search({ query, limit })
    return Array.isArray(res?.memes) ? res.memes : []
  } catch { return [] }
}
function memeByEmotion(emotion) {
  const meme = runtime.meme
  if (!meme || typeof meme.search !== 'function' || !emotion) return []
  const 全 = []
  for (const word of MEME_EMOTIONS[emotion] || []) {
    try {
      const res = meme.search({ emotion: word, limit: 12 })
      const list = Array.isArray(res?.memes) ? res.memes : []
      全.push(...list)
    } catch { /* 试下一个情绪词 */ }
  }
  // 同义情绪词的结果全并起来、按 id 去重：候选多了才换得开
  return [...new Map(全.filter(Boolean).map(x => [x.id, x])).values()].slice(0, 24)
}
async function refreshStickerHint(sessionId = '') {
  if (!sessionId) return null
  if (!runtime.meme && !runtime.stickers) return null
  if (Math.random() > stickerFrequency()) return null
  const previous = state.data.stickerHints?.[sessionId]?.id
  // 最近三张也不许重复：只避开上一张的话，A→B→A 还是会显得翻来覆去。
  const 近期 = (state.data.stickerHistory?.[sessionId] || []).slice(-3).map(String)
  try {
    const query = stickerQuery(sessionId)
    // 候选池放宽：三个查询串 + 四条同义情绪词的结果全合起来去重再挑，
    // 优先挑「不是上一张」的；池里只有一张就照发，不断供。
    const 池子 = []
    for (const q of [query, query.slice(0, 12), query.slice(0, 6)].filter(Boolean)) 池子.push(...memeSearch(q, 12))
    池子.push(...memeByEmotion(currentEmotionWord()))
    const 候选 = [...new Map(池子.filter(Boolean).map(x => [x.id, x])).values()]
    const 抽取 = (list) => list[Math.floor(Math.random() * list.length)]
    // 三级退让：先避开最近三张 → 再避开上一张 → 实在没有就照发，别断供
    let pick = null
    const 全新的 = 候选.filter(x => !近期.includes(String(x.id)))
    if (全新的.length) pick = 抽取(全新的)
    if (!pick) {
      const 换开的 = 候选.filter(x => String(x.id) !== String(previous))
      if (换开的.length) pick = 抽取(换开的)
    }
    if (!pick && 候选.length) pick = 抽取(候选)
    if (pick) {
      const hint = { id: pick.id, name: pick.name, emotion: pick.emotion || '', use: pick.use || '', url: pick.url || '', file: pick.path || '', score: 3, at: now(), source: 'meme' }
      if (!state.data.stickerHints) state.data.stickerHints = {}
      state.data.stickerHints[sessionId] = hint
      if (!state.data.stickerHistory) state.data.stickerHistory = {}
      state.data.stickerHistory[sessionId] = [...(state.data.stickerHistory[sessionId] || []), String(pick.id)].slice(-10)
      return hint
    }
    // ③ 退回 stickers 图包（老插件）
    const kit = runtime.stickers
    if (!kit) return null
    let hits = await kit.search(query, { limit: 5 })
    const strong = (hits || []).filter(hit => Number(hit?.score) >= 2)
    let best = (strong.find(hit => hit?.sticker?.id !== previous) || strong[0])?.sticker
    if (!best && query.length > 10) {
      const shortHits = await kit.search(query.slice(0, 10), { limit: 5 })
      const shortStrong = (shortHits || []).filter(hit => Number(hit?.score) >= 2)
      best = (shortStrong.find(hit => hit?.sticker?.id !== previous) || shortStrong[0])?.sticker
    }
    if (!best) {
      const emotion = currentEmotionWord()
      if (emotion && typeof kit.random === 'function') {
        const one = await kit.random({ emotion })
        if (one) best = one
      }
    }
    // 最后再试我记下来的热点词：这样「与时俱进」的新梗也能被用上。
    if (!best) {
      for (const trend of trendsList().slice(-5).reverse()) {
        const trendHits = await kit.search(trend.term, { limit: 3 })
        const strongTrend = (trendHits || []).filter(hit => Number(hit?.score) >= 2)
        if (!strongTrend.length) continue
        best = (strongTrend.find(hit => hit?.sticker?.id !== previous) || strongTrend[0])?.sticker
        if (best) break
      }
    }
    if (!best) return null
    const url = typeof kit.url === 'function' ? kit.url(best) : ''
    let file = ''
    try { file = (await kit.file(best.id))?.path || '' } catch { /* 下载失败就只给 URL */ }
    const matched = (hits || []).find(hit => hit?.sticker?.id === best.id)
    const hint = { id: best.id, name: best.name || best.stem, emotion: best.emotion || '', use: best.use || '', url, file, score: Number(matched?.score) || 0, at: now(), source: 'stickers' }
    if (!state.data.stickerHints) state.data.stickerHints = {}
    state.data.stickerHints[sessionId] = hint
    return hint
  } catch { return null }
}
// QQ 桥是把 markdown 图当图片发出去的：那边用本地文件更稳；DSH 网页用 URL。
function qqSessionIds() {
  try {
    const cfgPath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'qq-bridge-config.json')
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    return [...new Set([cfg?.['私聊会话'], cfg?.['目标会话'], ...(Array.isArray(cfg?.['绑定']) ? cfg['绑定'].map(row => row?.['会话']) : [])].filter(Boolean).map(String))]
  } catch { return [] }
}
function isQQSession(sessionId = '') {
  return qqSessionIds().includes(String(sessionId))
}
// 「发没发出去」不能只靠嘱咐：assistant 消息里出现过图片行才算真的发了。
function stickerStats(sessionId = '') {
  if (!state.data.stickerStats) state.data.stickerStats = {}
  const current = state.data.stickerStats[sessionId]
  if (!current || typeof current !== 'object') state.data.stickerStats[sessionId] = { quietTurns: 0, lastSentAt: null }
  return state.data.stickerStats[sessionId]
}
// 习惯层：同一份心情，也要打出不一样的句子——像真人在手机上打字。
const STYLE_LINES = {
  tired: [
    '这条只发一两句，短、平，别加感叹号；想说的多就下次再说。',
    '这条别铺开：一句话说清，剩下的咽回去。',
  ],
  happy: [
    '这条可以带点小得意，句尾加个语气词，别写成完整的文章。',
    '这条放松点：可以开玩笑、可以接一句自己的事。',
  ],
  guarded: [
    '这条话留半句：说结论，不展开理由。',
    '这条收着点：客气、但不热络。',
  ],
  soft: [
    '这条可以软一点：承认自己在意，不用一直嘴硬。',
    '这条可以撒娇一下，撒完自己找补半句。',
  ],
  plain: [
    '这条就正常打字：一句到三句，别有格式。',
    '这条按平时口气来，别刻意，也别端着。',
  ],
}
function pickByHash(list, key) {
  if (!list.length) return ''
  let hash = 0
  for (const ch of String(key)) hash = (hash * 31 + ch.charCodeAt(0)) % 9973
  return list[hash % list.length]
}
function typingStyleLine(sessionId = '') {
  try {
    const mv2 = (typeof runtime.getMoodV2 === 'function' ? runtime.getMoodV2() : null) || runtime.moodV2
    const read = mv2?.read?.()
    if (!read) return ''
    const mind = read.mind || {}
    const energy = Number(read.energy)
    const valence = Number(read.valence)
    const key = `${sessionId}:${Math.round(energy * 10)}:${Math.round(valence * 10)}:${Math.round((mind.guard || 0) * 10)}`
    if (mind.guard >= 0.3) return `这条的打字习惯：${pickByHash(STYLE_LINES.guarded, key)}`
    // 累、社交电量低的时候，再想被哄也不该「开玩笑」或「撒娇」——两条规矩打架时，以累为准
    const drained = energy <= 0.35 || (mind.social || 0) <= -0.3
    if (drained) return `这条的打字习惯：${pickByHash(STYLE_LINES.tired, key)}`
    if ((mind.comfort || 0) >= 0.3) return `这条的打字习惯：${pickByHash(STYLE_LINES.soft, key)}`
    if (valence >= 0.3) return `这条的打字习惯：${pickByHash(STYLE_LINES.happy, key)}`
    return `这条的打字习惯：${pickByHash(STYLE_LINES.plain, key)}`
  } catch { return '' }
}
// 说不出口的部分：防备高或有账没清时，允许她拒绝，而不是有问必答。
function silenceLine(sessionId = '') {
  try {
    const mv2 = (typeof runtime.getMoodV2 === 'function' ? runtime.getMoodV2() : null) || runtime.moodV2
    const read = mv2?.read?.()
    if (!read) return ''
    const guarded = (read.mind?.guard || 0) >= 0.3
    const owed = (read.ledger || []).length > 0
    if (!guarded && !owed) return ''
    return '要是这句不想答，可以直说「这个不想说」，不用找理由；但正事（对方让你做的东西）照样要做完。'
  } catch { return '' }
}

function stickerHintLine(sessionId = '') {
  const hint = state.data.stickerHints?.[sessionId]
  if (!hint) return ''
  const ageMin = (Date.now() - new Date(hint.at).getTime()) / 60000
  if (!Number.isFinite(ageMin) || ageMin > 30) return ''
  const target = isQQSession(sessionId) && hint.file ? hint.file : hint.url
  if (!target) return ''
  const stats = stickerStats(sessionId)
  const quiet = Number(stats.quietTurns) || 0
  const due = quiet >= 2 ? `你已经 ${quiet} 轮没发表情了，这条**请**在末尾配一张（只一张）：` : '这条回复末尾配一张（只一张，不要解释这张图）：'
  return `${due}![${hint.name}](${target})｜情绪：${hint.emotion || '—'}${hint.use ? `｜适合：${hint.use}` : ''}（放末尾，跟正文连着；真的完全不搭才跳过）`
}
// —— 检索：轻量 BM25（CJK 单字 + 双字，拉丁词按词），不引外部依赖、不建索引文件 ——
const CJK_SPLIT = /[\u4e00-\u9fff]+/g
function tokenize(text) {
  const raw = String(text || '').toLowerCase()
  const tokens = []
  for (const match of raw.matchAll(/[a-z0-9_]{2,}/g)) tokens.push(match[0])
  for (const segment of raw.match(CJK_SPLIT) || []) {
    for (let i = 0; i < segment.length; i += 1) {
      tokens.push(segment[i])
      if (i + 1 < segment.length) tokens.push(segment.slice(i, i + 2))
    }
  }
  return tokens
}
// 实体硬条件：查询里的英文/数字片段（BV号、型号、地名缩写）必须整体出现，避免「差一个字符也算命中」。
function entityTokens(text) { return [...String(text || '').toLowerCase().matchAll(/[a-z0-9_]{2,}/g)].map(match => match[0]) }
function bm25Rank(query, docs) {
  const queryTokens = [...new Set(tokenize(query))]
  if (!queryTokens.length || !docs.length) return docs.map(doc => ({ doc, score: 0 }))
  const docTokens = docs.map(doc => tokenize(JSON.stringify(doc.item ?? doc)))
  const avgdl = docTokens.reduce((sum, tokens) => sum + tokens.length, 0) / docTokens.length || 1
  const df = new Map()
  for (const tokens of docTokens) for (const token of new Set(tokens)) df.set(token, (df.get(token) || 0) + 1)
  const N = docs.length
  const k1 = 1.2
  const b = 0.75
  return docs.map((doc, index) => {
    const tokens = docTokens[index]
    const tf = new Map()
    for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1)
    let score = 0
    for (const token of queryTokens) {
      const freq = tf.get(token) || 0
      if (!freq) continue
      const idf = Math.log(1 + (N - (df.get(token) || 0) + 0.5) / ((df.get(token) || 0) + 0.5))
      score += idf * (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * tokens.length / avgdl))
    }
    return { doc, score }
  })
}
// —— 记忆变糊：原文不动，只是注入时按年头缩短细节（5 档，200 天以后只剩 9 字） ——
const CLARITY_STEPS = [
  { maxDays: 30, chars: 160 },
  { maxDays: 90, chars: 120 },
  { maxDays: 150, chars: 72 },
  { maxDays: 200, chars: 36 },
  { maxDays: Infinity, chars: 9 }
]
function clarityOf(at) {
  const days = Math.max(0, (Date.now() - new Date(at).getTime()) / DAY)
  const level = CLARITY_STEPS.findIndex(step => days < step.maxDays)
  const index = level < 0 ? CLARITY_STEPS.length - 1 : level
  return { level: index, days, chars: CLARITY_STEPS[index].chars }
}
function blurText(text, at) {
  const full = clean(text)
  const { level, chars } = clarityOf(at)
  if (full.length <= chars) return { text: full, level, shortened: false }
  return { text: `${clean(full, chars)}…（久远记忆，细节已模糊）`, level, shortened: true }
}
// —— 容量水位：只告警不删除（80/90/100） ——
function waterLevel(used, limit) {
  const ratio = limit > 0 ? used / limit : 0
  return { used, limit, ratio: Number(ratio.toFixed(3)), level: ratio >= 1 ? 100 : ratio >= 0.9 ? 90 : ratio >= 0.8 ? 80 : 0 }
}
const validBuckets = ['facts', 'profile', 'episodes', 'diary', 'thoughts', 'purposes']
const isInjectedMessage = message => {
  const source = String(message?.source || message?.metadata?.source || '').toLowerCase()
  const meta = message?.metadata || {}
  return source.includes('inject') || source.includes('context') || source.includes('splice') || source.includes('system') || meta.internal === true || meta.synthetic === true || isHarnessNoise(textOf(message))
}
// 每个对话各留一份额度：否则一个话多的对话会把别的对话挤出全局上限（等于变相丢记忆）。
const PER_SESSION_CAP = { raw: 600, moods: 60, facts: 100, profile: 60, episodes: 200, diary: 60, thoughts: 80, purposes: 40 }
function trimRowsToSessionCap(rows, sessionId, cap) {
  if (!Array.isArray(rows) || !cap || !sessionId) return rows
  const mine = []
  for (let i = 0; i < rows.length; i += 1) if (rowBelongsToSession(rows[i], sessionId)) mine.push(i)
  if (mine.length <= cap) return rows
  // 满了不能从最老的开始砍：先按“值不值得留”排序，最低分的先出，留下的仍按原时间顺序。
  const keepScore = (row) => memoryKeepScore(row)
  const sorted = [...mine].sort((a, b) => keepScore(rows[b]) - keepScore(rows[a]) || b - a).slice(0, cap)
  const keep = new Set(sorted)
  return rows.filter((_row, index) => !mine.includes(index) || keep.has(index))
}
// 一条记忆“值不值得留”：永久 > 长期 > 中期 > 短期，再叠加重要度、被用过几次、有多新鲜。
// 重要原话不会因为“排在最前面”就被挤掉——这是之前那个滚动窗口的锅。
const TIER_ALIAS = { instant: '瞬时', short: '短期', mid: '中期', long: '长期', permanent: '永久', 瞬时: '瞬时', 短期: '短期', 中期: '中期', 长期: '长期', 永久: '永久' }
function normalizeTier(value) { return TIER_ALIAS[String(value || '')] || '' }
function memoryKeepScore(row) {
  if (!row) return -1e9
  const tier = String(row.tier || '')
  const tierScore = tier === '永久' ? 100 : tier === '长期' ? 60 : tier === '中期' ? 30 : tier === '短期' ? 10 : 5
  const importance = Number.isFinite(Number(row.importance)) ? Number(row.importance) : 0.5
  const used = Math.min(20, Number(row.useCount || 0) * 3)
  const at = Date.parse(String(row.at || '')) || 0
  const fresh = at ? Math.max(0, 10 - (Date.now() - at) / 86400000) : 0
  const noise = isArchivedNoise(row) ? 60 : 0
  return tierScore + importance * 30 + used + fresh - noise
}
// 全局原文上限：同样按分数淘汰，不再无脑 slice(-N)。
// 原话被挤出之前，先把它压成“那阵子”的摘要沉进 episodes；记忆可以忘细节，不能整段消失。
function consolidateOnOverflow(dropped) {
  try {
    const useful = (dropped || []).filter((row) => row && row.role === 'user' && !isArchivedNoise(row) && String(row.text || '').trim())
    if (!useful.length) return null
    const condensed = condenseForOverflow(useful)
    if (!condensed || !condensed.text) return null
    const sessionId = String(useful[0]?.anchor?.sessionId || '')
    const row = {
      text: condensed.text,
      confidence: 0.5,
      source: 'overflow-consolidation',
      anchor: useful[0]?.anchor || null,
      at: now(),
      importance: 0.45,
      tier: '长期',
      fromDays: condensed.days.length,
      fromRows: condensed.from,
    }
    state.data.episodes = [...(state.data.episodes || []), row].slice(-LIMITS.episodes)
    if (sessionId) trimToSessionCap('episodes', sessionId)
    return row
  } catch { return null }
}
function trimRawByImportance(rows, cap = LIMITS.raw) {
  if (!Array.isArray(rows) || rows.length <= cap) return rows
  const ranked = rows.map((row, i) => ({ row, i, s: memoryKeepScore(row) }))
    .sort((a, b) => b.s - a.s || b.i - a.i)
    .slice(0, cap)
  const keep = new Set(ranked.map(x => x.i))
  return rows.filter((_row, i) => keep.has(i))
}
function trimToSessionCap(bucket, sessionId) {
  const cap = PER_SESSION_CAP[bucket]
  if (!cap || !sessionId) return
  state.data[bucket] = trimRowsToSessionCap(state.data[bucket], sessionId, cap)
}

// 旧记忆只有 0-100 的心情分数、没有效价：补一个，情绪加权检索和「再体验」才用得上。
// 幂等：已经有 valence 的不动；返回补了几条。
export function backfillMoodValence(data) {
  let count = 0
  for (const bucket of validBuckets) {
    for (const item of data?.[bucket] || []) {
      if (!item?.mood || typeof item.mood.valence === 'number') continue
      const score = Number(item.mood.score)
      if (!Number.isFinite(score)) continue
      item.mood.valence = Number(clamp((score - 50) / 50, -1, 1).toFixed(2))
      count += 1
    }
  }
  return count
}

async function load() {
  if (state.loaded) return
  if (state.loading) return state.loading
  state.loading = (async () => {
    try {
      const old = JSON.parse(await readFile(DATA_FILE, 'utf8'))
      if (old && [1, 2, 3, 4].includes(old.version)) state.data = { ...defaults(), ...old, version: 4, persona: { ...DEFAULT_PERSONA, ...old.persona }, personality: { ...DEFAULT_PERSONALITY, ...old.personality }, moodSettings: { ...DEFAULT_MOOD_SETTINGS, ...old.moodSettings }, thresholds: { ...defaults().thresholds, ...old.thresholds }, settings: { ...DEFAULT_SETTINGS, ...old.settings } }
      // raw is the original source; archive is exposed as a read-only semantic layer, never copied or deleted.
      // Archive/raw is immutable evidence: never rewrite it during loading. Filter derived buckets only.
      for (const bucket of validBuckets) state.data[bucket] = (state.data[bucket] || []).filter(item => !isHarnessNoise(item?.text))
      state.data.persona = { ...DEFAULT_PERSONA, ...(state.data.persona || {}) }
      state.data.personality = { ...DEFAULT_PERSONALITY, ...(state.data.personality || {}) }
      state.data.moodSettings = { ...DEFAULT_MOOD_SETTINGS, ...(state.data.moodSettings || {}) }
      state.data.moods = (state.data.moods || []).filter(item => !isHarnessNoise(item?.note) && !isHarnessNoise(item?.text))
      // 老记忆只存了 0-100 的分数、没有效价：补一个，情绪加权检索才用得上（旧的也能被想起）。
      backfillMoodValence(state.data)
      // 旧版本留下的表情候选没有分数（那时候不校验像不像），可能配一张完全不搭的，直接作废重挑。
      for (const [sid, hint] of Object.entries(state.data.stickerHints || {})) {
        if (!Number.isFinite(hint?.score)) delete state.data.stickerHints[sid]
      }
      for (const [sid, cache] of Object.entries(state.data.sessions || {})) {
        if (!cache || !Array.isArray(cache.recent)) continue
        cache.recent = cache.recent.filter(row => row?.role === 'user' && !isHarnessNoise(row.text))
      }
      // 一次性回填：从已有原话里补出「关于你自己的事实」，只读 raw、不修改它。
      if (!state.data.factsBackfilledAt) {
        for (const row of state.data.raw.slice(-400)) {
          if (row?.role !== 'user') continue
          recordSelfFacts(String(row?.anchor?.sessionId || ''), row.text, row.anchor)
        }
        state.data.factsBackfilledAt = now()
      }
      // 提取规则升级过（v2）：把旧规则误收的自动事实清掉（只动自动派生的，手动记的一律保留）。
      if (state.data.extractRules !== 'v3') {
        const AUTO_SOURCES = new Set(['auto-self-fact', 'auto-preference', 'promoted-permanent'])
        let purged = 0
        for (const bucket of ['facts', 'profile']) {
          const before = state.data[bucket].length
          state.data[bucket] = state.data[bucket].filter(item => {
            if (!AUTO_SOURCES.has(item?.source)) return true
            // 只清理「旧宽规则会误收、新规则明确不收」的那种：以「我」开头却抽不出实义。
            const looksLikeOldRule = /^我(?:有|是|在|养|做|学|读|吃|喝|玩|用|开|穿|带|来自|姓|喜欢|讨厌|希望|想要|觉得|感觉)/.test(String(item?.text || ''))
            if (!looksLikeOldRule) return true
            return extractSelfFacts(item.text).length > 0
          })
          purged += before - state.data[bucket].length
        }
        state.data.extractRules = 'v2'
        state.data.extractPurgedAt = now()
        state.data.extractPurged = purged
        // 日记也按新规则重算，免得“我有个疑问”还挂在编年史里。
        for (const sid of Object.keys(state.data.sessions || {})) rebuildChronicle(sid, 30)
      }
      // 启动时把用户自己写的记忆插件（persistent-memory）的事实镜像进来：只读、去重、只增不删。
      // 镜像挂在 pseudo-session 下，不会串进任何一个真实会话的注入。
      importUpstreamFacts()
      // 老数据补层级：facts/profile/episodes 本来就是结论，不该因为没有 tier 字段被判成瞬时。
      for (const bucket of ['facts', 'profile', 'episodes', 'purposes']) {
        for (const item of state.data[bucket] || []) {
          if (item?.tier) continue
          const score = Number.isFinite(item?.importance) ? item.importance : scoreImportance(item?.text, {})
          if (!Number.isFinite(item.importance)) item.importance = score
          item.tier = bucket === 'profile' ? 'permanent' : score >= 0.85 ? 'permanent' : 'long'
        }
      }
      // 纠正历史脏状态：标成 model-summary 但内容其实还是抽取式的，退回可重试状态。
      for (const row of state.data.diary || []) {
        if (row?.source !== 'model-summary') continue
        if (row.extractiveText && row.text === row.extractiveText) {
          row.source = row.kind === 'year' ? 'yearly-rollup' : 'monthly-rollup'
          row.inputsHash = null
        }
      }
      // 线索换了生成方式：旧条目版本不对就丢掉，等下次润色按新格式重算。
      for (const [sid, entry] of Object.entries(state.data.threads || {})) {
        if (!entry?.signature || entry.v !== 4) delete state.data.threads[sid]
      }
      // 启动时给已知会话补齐最近 7 天的编年史（按会话各自一条）。
      for (const sid of Object.keys(state.data.sessions || {})) rebuildChronicle(sid, 7)
      // 每次启动做一次轻量家政 + 修补：层级缺失、重复行、会无限膨胀的旁支数据。
      try {
        syncFeiyuLifeMoodFile()
        // 第一次跑：把已经是「永久」的那几条抄进本地手抄本，别让它空着。
        const 抄进 = 抄一下永久记忆()
        if (抄进) console.log(`[silicon-life-companion] 手抄本补了 ${抄进} 条重要记忆`)
        const fixedTiers = backfillTiers()
        const demoted = demoteIneligiblePermanents()
        const dupMarked = markDuplicateRows()
        const activeSessions = [...new Set((state.data.raw || []).slice(-400).map(row => String(row?.anchor?.sessionId || '')).filter(Boolean))]
        const house = runHousekeeping(state.data, { activeSessions })
        if (fixedTiers || dupMarked || house.moodsDropped || house.mapsPruned || house.jokesDropped || house.sessionsDropped) {
          console.log(`[silicon-life-companion] 启动整理：补层级 ${fixedTiers}，标重复 ${dupMarked}，情绪流水 -${house.moodsDropped}，旁支 -${house.mapsPruned}，梗 -${house.jokesDropped}，会话 -${house.sessionsDropped}`)
        }
      } catch (houseError) {
        console.error('[silicon-life-companion] housekeeping skipped:', houseError?.message || houseError)
      }
      // 启动预热向量：先算记忆池的向量，注入时真向量路就有货可用。
      // 本地小模型、不花 token；算不完也不影响这轮，后台慢慢补。
      try {
        const 预热池 = [...(state.data.facts || []), ...(state.data.profile || []), ...(state.data.episodes || [])]
          .filter((row) => row?.text && row.status !== 'duplicate' && row.status !== 'superseded')
          .slice(-260)
          .map((row) => String(row.text).slice(0, 500))
        if (预热池.length) void warm(预热池, { 每批: 8, 上限: 260 })
      } catch (warmError) {
        console.error('[silicon-life-companion] 预热向量失败（不影响使用）:', warmError?.message || warmError)
      }
      state.loaded = true
      await save()
    } catch (error) {
      state.loaded = true
      // A missing state file is the normal first run, not a failure.
      if (error?.code !== 'ENOENT') console.error('[silicon-life-companion] state load failed:', error)
      // 首次运行（没有 state.json）也要做联动镜像，否则用户自己插件里的事实永远进不来。
      try { if (importUpstreamFacts().imported) await save() } catch (importError) { console.error('[silicon-life-companion] upstream import failed:', importError) }
    } finally {
      state.loading = null
    }
  })()
  return state.loading
}
function save() {
  const operation = state.saving.then(async () => {
    await mkdir(DATA_DIR, { recursive: true })
    const temp = `${DATA_FILE}.tmp`
    await writeFile(temp, JSON.stringify(state.data, null, 2), 'utf8')
    // 落盘前留一份上一版：写坏了还能回到上一刻。每 10 分钟最多复制一次，
    // 免得一次对话里几十次 save 都去复制近 1MB 的文件。
    try {
      if (existsSync(DATA_FILE)) {
        const bak = `${DATA_FILE}.bak`
        const last = existsSync(bak) ? statSync(bak).mtimeMs : 0
        if (Date.now() - last > 10 * 60 * 1000) copyFileSync(DATA_FILE, bak)
      }
    } catch (copyError) { console.error('[silicon-life-companion] backup skipped:', copyError?.message || copyError) }
    await rename(temp, DATA_FILE)
  })
  state.saving = operation.catch(error => { console.error('[silicon-life-companion] save failed:', error) })
  return operation
}
// 同一件事被说了两遍、说法还不一样时：新的算数，旧的标成“被取代”。
// 不删——以后想知道“她以前是这么说的”还能翻回去。
function textSimilarity(a, b) {
  const sa = new Set(tokenize(String(a || '')))
  const sb = new Set(tokenize(String(b || '')))
  if (!sa.size || !sb.size) return 0
  let hit = 0
  for (const x of sa) if (sb.has(x)) hit += 1
  // 用“短句里有多少被覆盖”而不是并集：她说“昵称改成X”，旧句只是换了个值，并集会显得很不像。
  return hit / Math.max(1, Math.min(sa.size, sb.size))
}
function supersedeConflicts(bucket, row) {
  if (bucket !== 'facts' && bucket !== 'profile') return 0
  let n = 0
  for (const old of state.data[bucket] || []) {
    if (!old || old.id === row.id || old.status === 'superseded') continue
    if (old.text === row.text) continue
    if (textSimilarity(old.text, row.text) >= 0.4) {
      old.status = 'superseded'
      old.supersededAt = row.at
      old.supersededBy = row.id
      n += 1
    }
  }
  return n
}
// 「永久」是很贵的名额：只有又短、又像「关于她的确定事实」的才配。
// 之前一句很长的任务描述也能被判成永久，把真正的锚点（名字、uid、称呼）挤了出去。
function permanentEligible(text, { importance = 0.5, confidence = 0.7 } = {}) {
  const s = String(text || '').trim()
  if (!s) return false
  if (Array.from(s).length > 80) return false          // 长句多半是事情，不是身份
  const identity = /uid|昵称|名字|叫|是|生日|住|电话|号|称呼|喜欢|讨厌|不吃|过敏/i.test(s)
  if (identity && (importance >= 0.7 || confidence >= 0.75)) return true
  return importance >= 0.95 && confidence >= 0.8
}
// 历史数据修补：之前判成「永久」的长句（任务描述、排查要求）降回长期。
// 只改层级，不删、不改文字；被她真正认定的事以后再升回去也来得及。
function demoteIneligiblePermanents() {
  let demoted = 0
  for (const bucket of ['facts', 'raw', 'episodes']) {
    for (const row of state.data[bucket] || []) {
      if (!row || row.tier !== 'permanent') continue
      const imp = Number.isFinite(Number(row.importance)) ? Number(row.importance) : 0.5
      if (!permanentEligible(row.text, { importance: imp, confidence: Number(row.confidence ?? 0.7) })) {
        row.tier = 'long'
        row.demotedAt = now()
        demoted += 1
      }
    }
  }
  return demoted
}
function add(bucket, item) {
  const at = item.at || now()
  const row = { id: item.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, ...item, text: clean(item.text), at, confidence: clamp(item.confidence ?? 0.7, 0, 1), source: item.source || 'tool' }
  // 落库时就定层级：facts/profile 是结论，不该按“多久以前”被判成瞬时。
  if (!row.tier) {
    if (bucket === 'profile') row.tier = 'permanent'
    else if (bucket === 'facts') {
      const imp = Number.isFinite(row.importance) ? row.importance : scoreImportance(row.text, {})
      row.importance = imp
      row.tier = permanentEligible(row.text, { importance: imp, confidence: row.confidence }) ? 'permanent' : 'long'
    }
    else if (bucket === 'episodes') row.tier = 'long'
    else if (bucket === 'purposes') row.tier = 'long'
  }
  // 就算外部传了 tier，永久也要过闸：长句、没有身份关键词的，降成长期。
  if (bucket === 'facts' && row.tier === 'permanent') {
    const imp = Number.isFinite(row.importance) ? row.importance : scoreImportance(row.text, {})
    if (!permanentEligible(row.text, { importance: imp, confidence: row.confidence })) row.tier = 'long'
  }
  if (!Number.isFinite(row.importance) && (bucket === 'facts' || bucket === 'profile')) row.importance = scoreImportance(row.text, {})
  // 同样的内容已经在库里了：不新增，只把置信度和复习次数往上加一点。
  if (bucket !== 'raw' && bucket !== 'moods') {
    const dup = (state.data[bucket] || []).find((old) => old && old.id !== row.id && old.status !== 'superseded' && String(old.text || '').trim() === String(row.text || '').trim())
    if (dup) {
      dup.confidence = Math.max(Number(dup.confidence || 0), Number(row.confidence || 0))
      dup.useCount = Number(dup.useCount || 0) + 1
      dup.lastSeenAt = at
      return Object.assign(dup, { duplicateOf: dup.id })
    }
  }
  const superseded = supersedeConflicts(bucket, row)
  if (superseded) row.supersededOld = superseded
  state.data[bucket] = [...(state.data[bucket] || []), row].slice(-LIMITS[bucket])
  trimToSessionCap(bucket, row.anchor?.sessionId)
  return row
}
function sourceAnchor(sessionId, eventType, at) { return { sessionId, eventType, at } }
// 相对时间：让注入里的记忆带上「多久以前」，读起来才像记忆而不是流水账。
function formatAge(at) {
  const ms = Date.now() - new Date(at).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '刚刚'
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return `${Math.floor(days / 30)} 个月前`
}
// 自述抽取与「像人话」判定统一放在 extract.js：规则改起来更安全，也能单独测。
// （旧版在这里用宽正则，把「我有个疑问」也记成事实，被用户抓到了。）

// 心情以 mood-v2 为准：把 feiyu-life/mood.json 对齐一份，
// 免得 life-wake / meme 读到几天前的旧值。只写数据，不动它们的代码。
function syncFeiyuLifeMoodFile() {
  try {
    const base = process.env.DSH_HOME || join(homedir(), '.dsh')
    const 源 = JSON.parse(readFileSync(join(base, 'mood-v2', 'state.json'), 'utf8'))
    const 值 = Number(源?.inner?.valence)
    const 醒 = Number(源?.inner?.arousal)
    const 时 = Date.parse(String(源?.at || ''))
    if (!Number.isFinite(值) || !Number.isFinite(时)) return
    // 源本身太旧（心情插件停了）就别往别人文件里灌旧值
    if (Date.now() - 时 > 6 * 3600_000) return
    // 别人的文件要是比源还新，就别覆盖（宁可不动）
    try {
      const 旧的 = JSON.parse(readFileSync(join(base, 'feiyu-life', 'mood.json'), 'utf8'))
      const 旧时 = Date.parse(String(旧的?.at || '').replace(' ', 'T'))
      if (Number.isFinite(旧时) && 旧时 >= 时) return
    } catch { /* 没有旧文件就直接写 */ }
    const d = new Date(时)
    const pad = (n) => String(n).padStart(2, '0')
    const 戳 = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    const 分 = Math.round(50 + 值 * 50)
    const 词 = 分 >= 80 ? '很好' : 分 >= 65 ? '不错' : 分 >= 45 ? '平静' : 分 >= 30 ? '有点低落' : '很低落'
    writeFileSync(join(base, 'feiyu-life', 'mood.json'), JSON.stringify({ word: 词, valence: 值, arousal: Number.isFinite(醒) ? 醒 : 0, at: 戳 }, null, 1), 'utf8')
  } catch { /* 没有 mood-v2 就算了 */ }
}

// 记录这条记忆时的心情快照：以后回想就能带上「当时是什么心情」。
function moodSnapshot(sessionId) {
  // 新记忆带上「记的时候心里什么感觉」：检索时带情绪的旧事才会更容易被想起。
  try {
    const mv2 = (typeof runtime.getMoodV2 === 'function' ? runtime.getMoodV2() : null) || runtime.moodV2
    const read = mv2?.read?.()
    if (read && typeof read.valence === 'number') {
      const hot = (read.emotions || [])[0]
      return {
        label: read.label || '平静',
        score: Math.round(clamp((read.valence + 1) * 50, 0, 100)),
        valence: Number(read.valence.toFixed(2)),
        reason: hot ? `${hot.kind}（对${hot.target}）` : '',
        source: 'mood-v2',
        at: now(),
      }
    }
  } catch { /* 心情插件不在就用下面的老办法 */ }
  const feiyu = readFeiyuMood()
  if (feiyu) return { label: feiyu.label, score: Math.round(feiyu.score), reason: clean(feiyu.reason, 60), source: 'feiyu-mood', at: feiyu.at }
  const local = sessionId ? sessionRows(state.data.moods, sessionId).at(-1) : null
  // 本插件自己的心情流水早就不写了（现在主要靠 dsh-mood-v2）——太旧的就别当「现在」用，
  // 否则注入里会冒出几天前的情绪。
  if (local) {
    const 毫秒 = Date.parse(String(local.at || '')) || 0
    if (毫秒 && Date.now() - 毫秒 <= 3 * 3600_000) {
      return { label: local.emotion || '平静', score: Math.round(clamp((local.valence || 0) * 50 + 50, 0, 100)), source: 'companion', at: local.at }
    }
  }
  return null
}
// 自动把用户的自述沉淀成两层：稳定的偏好/属性进 profile（画像），其余进 facts（事实）。
// 这样四层里的 facts 与 profile 才有真实分工，而不是等用户手动记。
const PREFERENCE_HINT = /我(?:喜欢|最爱|爱|讨厌|不喜欢|习惯|希望|想要|需要)|我的/
function recordSelfFacts(sessionId, body, anchor) {
  if (!sessionId) return []
  const saved = []
  const mood = moodSnapshot(sessionId)
  for (const fact of extractSelfFacts(body)) {
    const bucket = PREFERENCE_HINT.test(fact) ? 'profile' : 'facts'
    const source = bucket === 'profile' ? 'auto-preference' : 'auto-self-fact'
    if (state.data[bucket].some(item => rowBelongsToSession(item, sessionId) && item.text === fact)) continue
    // 事实要记住「这句话是什么时候说的」：否则旧原话抽出的事实会被当成刚刚发生，也永远不会按年头变糊。
    const spokenAt = anchor?.at && Number.isFinite(new Date(anchor.at).getTime()) ? anchor.at : undefined
    saved.push(add(bucket, { text: fact, at: spokenAt, confidence: bucket === 'profile' ? 0.65 : 0.6, source, anchor, ...(mood ? { mood } : {}) }))
  }
  return saved
}
function isRecent(row) { return Date.now() - new Date(row.at).getTime() <= state.data.settings.sevenDayMs }
// ── 编年史：把每天发生的事压成一条日记，跨渠道累积，用来撑起「完整的一生」 ──
// 和会话隔离不冲突：这里存的不是原话，是「那天我们做了什么」的摘要，属于我自己的经历。
const CHRONICLE_CAP = 3650
// 每天最多花多少次模型调用：防止整理失控时把预算烧光（默认 40 次/天）。
// 放在模块层，因为 status() 也要读它；真正花钱的地方在 modelText。
function dailyCap() {
  const value = Number(state.data.settings.modelDailyCap)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 40
}
function usageToday() {
  const today = dayKeyOf(now())
  const usage = state.data.modelUsage
  if (!usage || usage.day !== today) return { day: today, calls: 0 }
  return { day: today, calls: Number(usage.calls) || 0 }
}
function spendCall() {
  const usage = usageToday()
  usage.calls += 1
  state.data.modelUsage = usage
  return usage.calls
}
function dayKeyOf(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
// 编年史按会话各记一条，而且**只收本会话的原话**：跨会话合并等于把别人的原话
// 换个名字注入回来（隔离测试抓到过）。要共享长期记忆走 readsFrom，不动原话。
function chronicleScope(sessionId) {
  return new Set([String(sessionId)])
}
// 日记要像人话：系统回执、命令行、路径、纯应答都不进编年史（规则在 extract.js）。
function buildDayDigest(dayKey, sessionId = '') {
  const scope = chronicleScope(sessionId)
  const lines = (state.data.raw || [])
    .filter(row => row?.role === 'user' && !isArchivedNoise(row) && dayKeyOf(row.at) === dayKey && scope.has(String(row?.anchor?.sessionId || '')))
    .map(row => clean(row.text, 90))
    .filter(text => looksLikeSpeech(text) && /[\u4e00-\u9fa5]{2}/.test(text))
  if (!lines.length) return ''
  // 只记「今天新发生的事」：前几天已经写过一遍的话（「继续迭代」这种）不再占位置。
  const previous = sessionRows(state.data.diary, sessionId)
    .filter(item => isDayRow(item) && String(item.day) < dayKey)
    .sort((a, b) => String(a.day).localeCompare(String(b.day)))
    .slice(-7)
    .flatMap(item => String(item.extractiveText || item.text || '').split('；'))
  const fresh = pickFreshLines([...new Set(lines)], previous, { max: 6 })
  if (!fresh.length) return ''
  return fresh.join('；').slice(0, 600)
}
// 日记的「天」条目：新数据带 kind:'day'，旧数据没有 kind 字段。
// 天/月/年共用 day 字段，所以凡是要“只挑天条目”的地方都必须走这里，不能写 !item.kind。
const isDayRow = item => Boolean(item?.day) && (item.kind === 'day' || !item.kind)
// 重算某个会话最近 N 天的日记；只 upsert，不删除历史。
function rebuildChronicle(sessionId = '', days = 3) {
  if (!sessionId) return 0
  const keys = new Set()
  for (let i = 0; i < days; i += 1) keys.add(dayKeyOf(new Date(Date.now() - i * 86400000).toISOString()))
  let changed = 0
  for (const dayKey of keys) {
    if (!dayKey) continue
    const text = buildDayDigest(dayKey, sessionId)
    if (!text) continue
    const existing = state.data.diary.find(item => (item.kind === 'day' || !item.kind) && item.day === dayKey && rowBelongsToSession(item, sessionId))
    const digestHash = hashInputs(text)
    if (existing) {
      // 日记也有模型版：底稿不变就只更新 extractiveText，不碰模型写的 text。
      if (existing.source === 'model-summary' && existing.inputsHash === digestHash) {
        existing.kind = 'day'
        existing.extractiveText = text
        existing.stale = false
        if (existing.at !== `${dayKey}T23:59:59.000Z`) { existing.at = `${dayKey}T23:59:59.000Z`; existing.updatedAt = now(); changed += 1 }
        continue
      }
      // 底稿变了：保留模型写的那句并标记过期，等下一轮再润色；不要退回分号碎片。
      if (existing.source === 'model-summary') {
        existing.kind = 'day'
        existing.extractiveText = text
        existing.stale = true
        existing.updatedAt = now()
        changed += 1
        continue
      }
      if (existing.text !== text || existing.source !== 'daily-digest' || existing.kind !== 'day') {
        existing.kind = 'day'; existing.text = text; existing.extractiveText = text; existing.inputsHash = null; existing.source = 'daily-digest'; existing.updatedAt = now(); changed += 1
      }
      continue
    }
    state.data.diary.push({
      id: `day-${sessionId}-${dayKey}`,
      kind: 'day',
      day: dayKey,
      text,
      extractiveText: text,
      inputsHash: null,
      at: `${dayKey}T23:59:59.000Z`,
      updatedAt: now(),
      source: 'daily-digest',
      confidence: 0.55,
      anchor: { sessionId, eventType: 'daily-digest', at: `${dayKey}T23:59:59.000Z` }
    })
    changed += 1
  }
  // 天 → 月 → 年：每上一层只留摘要，提示词长度就不会随时间增长。
  const dayRows = state.data.diary.filter(item => item?.anchor?.sessionId === sessionId && isDayRow(item))
  const lastDayIn = prefix => dayRows.map(item => String(item.day)).filter(day => day.startsWith(prefix)).sort().slice(-1)[0] || ''
  // 折叠只用「底稿」：模型写的句子不能反过来改变上层 hash，否则每轮都会连锁重写。
  const months = rollupMonths(dayRows.map(item => ({ day: item.day, text: item.extractiveText || item.text })))
  for (const month of months) {
    // at 用这个月里真实存在的最后一天，别伪造成月初——否则按时间检索会把它当成很久以前。
    const monthAt = `${lastDayIn(`${month.period}-`) || `${month.period}-01`}T23:59:59.000Z`
    const existing = state.data.diary.find(item => item.kind === 'month' && item.day === month.period && rowBelongsToSession(item, sessionId))
    if (existing) {
      // 模型已经润色过、且底稿没变 → 保留它写的那句，只更新底稿和时间（否则每轮重建都会把润色覆盖掉）。
      if (existing.source === 'model-summary' && existing.inputsHash === hashInputs(month.text)) {
        existing.extractiveText = month.text
        existing.stale = false
        if (existing.at !== monthAt) { existing.at = monthAt; changed += 1 }
        continue
      }
      // 底稿变了：保留模型那句并标记过期，下一轮重新润色，不退回碎片。
      if (existing.source === 'model-summary') {
        existing.extractiveText = month.text
        existing.stale = true
        existing.updatedAt = now()
        changed += 1
        continue
      }
      if (existing.text !== month.text || existing.at !== monthAt) { existing.text = month.text; existing.at = monthAt; existing.source = 'monthly-rollup'; existing.inputsHash = null; existing.updatedAt = now(); changed += 1 }
      continue
    }
    state.data.diary.push({ id: `month-${sessionId}-${month.period}`, kind: 'month', day: month.period, text: month.text, at: monthAt, updatedAt: now(), source: 'monthly-rollup', confidence: 0.5, anchor: { sessionId, eventType: 'monthly-rollup', at: monthAt } })
    changed += 1
  }
  const monthRows = state.data.diary.filter(item => item?.anchor?.sessionId === sessionId && item.kind === 'month')
  const years = rollupYears(monthRows.map(item => ({ period: item.day, text: item.extractiveText || item.text })))
  for (const year of years) {
    const yearAt = `${lastDayIn(`${year.period}-`) || `${year.period}-01-01`}T23:59:59.000Z`
    const existing = state.data.diary.find(item => item.kind === 'year' && item.day === year.period && rowBelongsToSession(item, sessionId))
    if (existing) {
      if (existing.source === 'model-summary' && existing.inputsHash === hashInputs(year.text)) {
        existing.extractiveText = year.text
        existing.stale = false
        if (existing.at !== yearAt) { existing.at = yearAt; changed += 1 }
        continue
      }
      if (existing.source === 'model-summary') {
        existing.extractiveText = year.text
        existing.stale = true
        existing.updatedAt = now()
        changed += 1
        continue
      }
      if (existing.text !== year.text || existing.at !== yearAt) { existing.text = year.text; existing.at = yearAt; existing.source = 'yearly-rollup'; existing.inputsHash = null; existing.updatedAt = now(); changed += 1 }
      continue
    }
    state.data.diary.push({ id: `year-${sessionId}-${year.period}`, kind: 'year', day: year.period, text: year.text, at: yearAt, updatedAt: now(), source: 'yearly-rollup', confidence: 0.5, anchor: { sessionId, eventType: 'yearly-rollup', at: yearAt } })
    changed += 1
  }
  if (state.data.diary.length > CHRONICLE_CAP) state.data.diary = state.data.diary.slice(-CHRONICLE_CAP)
  state.data.diary.sort((a, b) => String(a.day).localeCompare(String(b.day)))
  return changed
}
// 最近几天的日记，喂给「线索」用。只用底稿，模型改写过的句子不参与，避免自我引用。
function recentDiaryDays(sessionId = '', limit = 14) {
  return sessionRows(state.data.diary, sessionId)
    .filter(item => isDayRow(item) && item.day)
    .sort((a, b) => String(a.day).localeCompare(String(b.day)))
    .slice(-limit)
    .map(item => ({ day: String(item.day), text: String(item.extractiveText || item.text || '') }))
    .filter(item => item.text.trim())
}
// 只取本会话的日记：日记由原话压成，跨会话共享等于泄漏原话。
function recentChronicle(sessionId = '', limit = 3) {
  const own = sessionId ? sessionRows(state.data.diary, sessionId) : (state.data.diary || [])
  return own
    .filter(item => item?.day && isDayRow(item))
    .sort((a, b) => String(a.day).localeCompare(String(b.day)))
    .slice(-limit)
}
// 折叠层：月记 / 年表各取最近一条，用来回答“那阵子/那一年我们在干嘛”。
function recentRollup(sessionId = '', kind = 'month') {
  const own = sessionId ? sessionRows(state.data.diary, sessionId) : (state.data.diary || [])
  return own
    .filter(item => item?.kind === kind && item?.day)
    .sort((a, b) => String(a.day).localeCompare(String(b.day)))
    .slice(-1)[0] || null
}
function chronicleCount(sessionId = '') {
  if (!sessionId) return state.data.diary.filter(item => isDayRow(item)).length
  return sessionRows(state.data.diary, sessionId).filter(item => isDayRow(item)).length
}
// 历史原话回填（用户在管理页点一下才跑）：只读 archive，把能识别的自述补进 facts/profile。
// 不删、不改原文；重复的会跳过，所以可以反复点。
async function backfillLayers(sessionId = '') {
  await load()
  const rows = sessionId ? sessionRows(state.data.raw, sessionId) : state.data.raw
  const candidates = rows.filter(row => row.role === 'user' && !isArchivedNoise(row))
  const before = { facts: state.data.facts.length, profile: state.data.profile.length }
  let added = 0
  for (const row of candidates) {
    added += recordSelfFacts(String(row.anchor?.sessionId || sessionId), row.text, row.anchor).length
  }
  if (added) await save()
  return { scanned: candidates.length, added, facts: state.data.facts.length - before.facts, profile: state.data.profile.length - before.profile, rawPreserved: true, scope: sessionId || 'all-conversations' }
}
function backfillTiers() {
  let fixed = 0
  for (const bucket of ['raw', 'facts', 'profile', 'episodes', 'diary', 'thoughts', 'purposes']) {
    for (const row of state.data[bucket] || []) {
      if (!row || row.tier) continue
      row.tier = bucket === 'profile' ? 'permanent' : bucket === 'facts' ? 'long' : bucket === 'raw' ? 'short' : 'long'
      fixed += 1
    }
  }
  return fixed
}
// 同一条内容被写了十几遍（重启/重算都会重复生成），不该在记忆里出现十几条。
// 只标记不删除：第一条留着，其余标 duplicate；以后想查还能翻到。
function markDuplicateRows() {
  let marked = 0
  for (const bucket of ['facts', 'profile', 'episodes', 'diary', 'thoughts', 'purposes']) {
    const seen = new Map()
    for (const row of state.data[bucket] || []) {
      if (!row || row.status === 'duplicate') continue
      const key = String(row.text || '').trim()
      if (!key) continue
      if (!seen.has(key)) { seen.set(key, row); continue }
      const first = seen.get(key)
      row.status = 'duplicate'
      row.duplicateOf = first.id || null
      first.useCount = Number(first.useCount || 0) + Number(row.useCount || 0)
      marked += 1
    }
  }
  return marked
}
function counts() { return Object.fromEntries(['raw', ...validBuckets, 'moods'].map(k => [k, state.data[k].length])) }
// 与「鱼的心情」(dsh-feiyu-mood) 联动：只读它的 state.json，不写。
// 它在时由它负责把心情告诉模型，我们不再重复注入，避免两套心情互相打架。
const FEIYU_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'feiyu-mood')
// 心情插件的两代存法都认：feiyu-mood/state.json（按会话一份），
// 以及 feiyu-life/mood.json（一份全局的 word/valence/arousal）。哪个新用哪个。
function readFeiyuLifeMood() {
  try {
    const base = process.env.DSH_HOME || join(homedir(), '.dsh')
    // 第一优先：dsh-mood-v2 的 state.json（真正在用的心情源，里面是 inner/mask/mind）
    try {
      const v2 = JSON.parse(readFileSync(join(base, 'mood-v2', 'state.json'), 'utf8'))
      const at2 = Date.parse(String(v2?.at || '')) || 0
      if (at2 && Date.now() - at2 <= 3 * 3600_000) {
        const valence = Number(v2?.inner?.valence)
        const arousal = Number(v2?.inner?.arousal)
        if (Number.isFinite(valence)) {
          const score = clamp(Math.round(50 + valence * 50), 0, 100)
          const label = score >= 80 ? '很好' : score >= 65 ? '不错' : score >= 45 ? '平静' : score >= 30 ? '有点低落' : '很低落'
          return {
            score,
            label,
            word: label,
            valence,
            arousal: Number.isFinite(arousal) ? arousal : 0,
            reason: '',
            confidence: 1,
            at: new Date(at2).toISOString(),
            source: 'mood-v2'
          }
        }
      }
    } catch { /* 没装 mood-v2 就往下走 */ }
    const raw = JSON.parse(readFileSync(join(base, 'feiyu-life', 'mood.json'), 'utf8'))
    const at = Date.parse(String(raw?.at || '').replace(' ', 'T')) || Number(raw?.at) || 0
    if (!at || Date.now() - at > 3 * 3600_000) return null
    const valence = Number(raw?.valence)
    const arousal = Number(raw?.arousal)
    const word = clean(raw?.word, 20)
    if (!word && !Number.isFinite(valence)) return null
    const score = clamp(Math.round(50 + (Number.isFinite(valence) ? valence : 0) * 50), 0, 100)
    return {
      score,
      label: word || (score >= 65 ? '不错' : score >= 45 ? '平静' : '有点低落'),
      word: word || '',
      valence: Number.isFinite(valence) ? valence : 0,
      arousal: Number.isFinite(arousal) ? arousal : 0,
      reason: '',
      confidence: 1,
      at: new Date(at).toISOString(),
      source: 'feiyu-life'
    }
  } catch { return null }
}
function readFeiyuMood() {
  const life = readFeiyuLifeMood()
  if (life) return life
  try {
    const raw = JSON.parse(readFileSync(join(FEIYU_DIR, 'state.json'), 'utf8'))
    const entries = Object.values(raw?.moods || {}).filter(item => item && typeof item === 'object')
    if (!entries.length) return null
    const latest = entries.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0]
    const score = clamp(latest.mood ?? 70, 0, 100)
    const at = Number(latest.updatedAt) || 0
    // 「鱼的心情」插件关掉之后，它的 state.json 会停在最后一刻；旧数据不能再当现在的心情用。
    if (!at || Date.now() - at > 3 * 3600_000) return null
    return {
      score,
      label: score >= 80 ? '很好' : score >= 65 ? '不错' : score >= 45 ? '平静' : score >= 30 ? '有点低落' : '很低落',
      reason: clean(latest.lastReason, 80),
      confidence: Number(latest.lastConfidence) || 0,
      at: new Date(Number(latest.updatedAt) || Date.now()).toISOString()
    }
  } catch { return null }
}
// ── 与用户自己写的「鱼记忆」(dsh-fish-memory) 联动 ──
// 它的库是 $DSH_HOME/fish-memory/<会话id>.json，按会话各一份，正好对得上本插件的会话边界。
// 只读：把它记过的条目镜像进 facts 层（标源、去重），召回时也能一起被找出来；绝不写它的库。
const FISH_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'fish-memory')
function readFishMemory(sessionId = '') {
  const sid = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '_')
  if (!sid) return { detected: false, memories: [] }
  const path = join(FISH_DIR, `${sid}.json`)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const memories = (Array.isArray(parsed?.memories) ? parsed.memories : [])
      .map(item => ({
        text: clean(item?.text, 900),
        at: item?.at || item?.createdAt || null,
        category: item?.category || null,
        importance: Number.isFinite(Number(item?.importance)) ? Number(item.importance) : null,
        tags: Array.isArray(item?.tags) ? item.tags.slice(0, 6) : [],
        emotion: item?.emotion || null
      }))
      .filter(item => item.text)
    return { detected: true, path, memories }
  } catch (error) {
    return { detected: false, path, memories: [], error: error?.code === 'ENOENT' ? 'not-found' : 'unreadable' }
  }
}
// 镜像进 facts：锚点保留原会话 id，所以它只属于那个会话，不会串台。
function importFishMemory(sessionId = '') {
  const fish = readFishMemory(sessionId)
  if (!fish.detected || !fish.memories.length) return { imported: 0, total: fish.memories.length }
  let imported = 0
  for (const memory of fish.memories) {
    const exists = state.data.facts.some(item => item.source === 'fish-memory' && item.text === memory.text && rowBelongsToSession(item, sessionId))
    if (exists) continue
    state.data.facts.push({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      text: memory.text,
      at: memory.at || now(),
      confidence: clamp(memory.importance ?? 0.8, 0, 1),
      source: 'fish-memory',
      ...(memory.emotion ? { mood: { label: clean(memory.emotion, 30), score: null, source: 'fish-memory' } } : {}),
      anchor: sourceAnchor(sessionId, 'fish-memory-import', memory.at || now())
    })
    imported += 1
  }
  if (state.data.facts.length > LIMITS.facts) state.data.facts = state.data.facts.slice(-LIMITS.facts)
  return { imported, total: fish.memories.length }
}
// 管理页没有会话上下文时，把已知会话聚合起来看（每个会话各有一份鱼记忆库）。
function knownSessionIds(limit = 50) {
  const ids = new Set(Object.keys(state.data.sessions || {}))
  for (const row of state.data.raw.slice(-400)) {
    const sid = String(row?.anchor?.sessionId || '')
    if (sid) ids.add(sid)
  }
  return [...ids].slice(-limit)
}
function fishStatus(sessionId = '') {
  if (!sessionId) {
    const ids = knownSessionIds()
    let memories = 0
    let sessions = 0
    for (const id of ids) {
      const one = readFishMemory(id)
      if (!one.detected) continue
      sessions += 1
      memories += one.memories.length
    }
    const mirrored = state.data.facts.filter(item => item.source === 'fish-memory').length
    return { detected: sessions > 0, sessions, path: FISH_DIR, memories, mirrored, error: null }
  }
  const fish = readFishMemory(sessionId)
  const mirrored = state.data.facts.filter(item => item.source === 'fish-memory' && rowBelongsToSession(item, sessionId)).length
  return { detected: fish.detected, path: fish.path, memories: fish.memories.length, mirrored, error: fish.error || null }
}
// ── 与用户自己写的记忆插件（@local/persistent-memory）联动 ──
// 只读它的 persistent-memory.json，把它的长期事实镜像进 facts 层（标源、去重），
// 让它记过的事也能在本插件的四层里看见、能被召回。绝不改写它的文件，除非用户显式点导出。
const UPSTREAM_PACKAGE = '@local/persistent-memory'
const UPSTREAM_SESSION = 'persistent-memory'
function upstreamMemoryPath() {
  if (process.env.COMPANION_UPSTREAM_MEMORY) return process.env.COMPANION_UPSTREAM_MEMORY
  const profileDir = process.env.DSH_PROFILE_DIR
  if (!profileDir) return ''
  return join(profileDir, 'node_modules', ...UPSTREAM_PACKAGE.split('/'), 'persistent-memory.json')
}
function readUpstreamMemory() {
  const path = upstreamMemoryPath()
  if (!path) return { detected: false, path, facts: [], sessions: 0 }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const facts = Array.isArray(parsed?.facts) ? parsed.facts.map(item => clean(item, 900)).filter(Boolean) : []
    return { detected: true, path, facts, sessions: Object.keys(parsed?.sessions || {}).length, raw: parsed }
  } catch (error) {
    return { detected: false, path, facts: [], sessions: 0, error: error?.code === 'ENOENT' ? 'not-found' : 'unreadable' }
  }
}
// 镜像：把上游事实按「只增不删」并进 facts 层，挂在 pseudo-session 下，因此不会串进任何一个真实会话的注入。
// 上游记忆里混着旧对话原话（带日期前缀）和疑问句，那些不是她记得的事，别往注入里搬。
const UPSTREAM_JUNK = /^(\d{4}-\d{2}-\d{2})[：:]|[？?]\s*$|[吗呢吧]\s*$/
const worthImporting = text => {
  const value = String(text || "").trim()
  if (value.length < 6 || value.length > 300) return false
  if (UPSTREAM_JUNK.test(value)) return false
  return /[\u4e00-\u9fa5]/.test(value)
}
function importUpstreamFacts(upstream = readUpstreamMemory()) {
  if (!upstream.detected || !upstream.facts.length) return { imported: 0, total: upstream.facts.length }
  let imported = 0
  for (const text of upstream.facts) {
    if (!worthImporting(text)) continue
    const exists = state.data.facts.some(item => item.source === 'persistent-memory' && item.text === text)
    if (exists) continue
    state.data.facts.push({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      text: clean(text, 900),
      at: now(),
      confidence: 0.9,
      source: 'persistent-memory',
      anchor: { sessionId: UPSTREAM_SESSION, eventType: 'upstream-import', at: now() }
    })
    imported += 1
  }
  if (state.data.facts.length > LIMITS.facts) state.data.facts = state.data.facts.slice(-LIMITS.facts)
  return { imported, total: upstream.facts.length }
}
// 反向导出：把本插件里用户自述得来的事实并进上游的 facts 数组。
// 先重读一遍再合并写，避免覆盖上游在两次读之间写进去的东西。
function exportFactsToUpstream(sessionId = '') {
  const upstream = readUpstreamMemory()
  if (!upstream.detected) return { exported: 0, reason: upstream.error || 'upstream not detected' }
  const own = state.data.facts.filter(item => item.source !== 'persistent-memory' && (!sessionId || rowBelongsToSession(item, sessionId)))
  const existing = new Set(upstream.facts.map(item => clean(item, 900)))
  const added = []
  for (const item of own) {
    const text = clean(item.text, 900)
    if (!text || existing.has(text)) continue
    existing.add(text)
    added.push(text)
  }
  if (!added.length) return { exported: 0, upstreamTotal: upstream.facts.length }
  const next = { ...upstream.raw, version: upstream.raw?.version ?? 1, facts: [...upstream.facts, ...added].slice(-200) }
  try {
    writeFileSync(upstream.path, JSON.stringify(next, null, 2), 'utf8')
    return { exported: added.length, upstreamTotal: next.facts.length, path: upstream.path }
  } catch (error) {
    return { exported: 0, reason: `write failed: ${error?.message || error}` }
  }
}
function bridgeStatus(sessionId = '') {
  const upstream = readUpstreamMemory()
  return {
    detected: upstream.detected,
    path: upstream.path,
    upstreamFacts: upstream.facts.length,
    upstreamSessions: upstream.sessions,
    mirrored: state.data.facts.filter(item => item.source === 'persistent-memory').length,
    error: upstream.error || null,
    // 鱼记忆是主力：按会话读，它记过的事最全。
    fish: fishStatus(sessionId)
  }
}
// 把人格拼成一段纯文本：QQ 桥（dsh-qq-link）只认一段字，所以这里做唯一的拼装口。
function composePersonaText() {
  const p = state.data.persona || {}
  const n = state.data.personality || {}
  return [
    p.name ? `你是${p.name}。` : '',
    p.description || '',
    p.values ? `三观：${p.values}` : '',
    p.voice ? `说话方式：${p.voice}` : '',
    p.samples ? `平时说话的口气（照着学，不要照抄内容）：\n${p.samples}` : '',
    n.traits ? `性格：${n.traits}` : '',
    p.systemPrompt || ''
  ].filter(Boolean).join('\n').slice(0, 20000)
}
// 推给 QQ 桥：走它自己的 /save 接口（它校验、它落盘），本插件不直接改别人的配置文件。
async function pushPersonaToQQ(host) {
  const text = composePersonaText()
  if (!text.trim()) return { ok: false, say: '人格还是空的，先填再同步' }
  const base = host && /^[\w.\-:\[\]]+$/.test(host) ? `http://${host}` : ''
  if (!base) return { ok: false, say: '拿不到本机地址，无法调用 QQ 桥' }
  // 先记下 QQ 那边原来的人设，万一用户想退回去还能一键还原。
  const qqConfigPath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'qq-bridge-config.json')
  let before = null
  try {
    const raw = JSON.parse(readFileSync(qqConfigPath, 'utf8'))
    before = { 人设开: raw?.人设开 === true, 人设: String(raw?.人设 || '') }
  } catch { before = null }
  if (before && !state.data.qqPersonaBefore) state.data.qqPersonaBefore = { ...before, at: now() }
  try {
    const response = await fetch(`${base}/dsh-qq-bridge/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 人设开: true, 人设: text })
    })
    const value = await response.json().catch(() => null)
    if (!response.ok) return { ok: false, say: `QQ 桥返回 ${response.status}`, detail: value }
    return { ok: true, say: (value && value['说']) || '已同步到 QQ', chars: text.length, before, qqConfigPath }
  } catch (error) {
    return { ok: false, say: `调不到 QQ 桥（没装或没开？）：${error?.message || error}` }
  }
}
// 还原 QQ 那边同步前的人设（只还原我们动过的两个字段）。
async function restoreQQPersona(host) {
  const before = state.data.qqPersonaBefore
  if (!before) return { ok: false, say: '没有可还原的备份（还没同步过）' }
  const base = host && /^[\w.\-:\[\]]+$/.test(host) ? `http://${host}` : ''
  if (!base) return { ok: false, say: '拿不到本机地址' }
  try {
    const response = await fetch(`${base}/dsh-qq-bridge/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 人设开: before['人设开'] === true, 人设: before['人设'] || '' })
    })
    if (!response.ok) return { ok: false, say: `QQ 桥返回 ${response.status}` }
    return { ok: true, say: '已还原 QQ 原来的设置', before }
  } catch (error) {
    return { ok: false, say: `调不到 QQ 桥：${error?.message || error}` }
  }
}
function status(sessionId = '') {
  const raw = sessionId ? sessionRows(state.data.raw, sessionId) : state.data.raw
  const scoped = Object.fromEntries(validBuckets.map(bucket => [bucket, sessionId ? sessionRows(state.data[bucket], sessionId) : state.data[bucket]]))
  const moods = sessionId ? sessionRows(state.data.moods, sessionId) : state.data.moods
  const scopedCounts = sessionId ? { archive: raw.length, raw: raw.length, ...Object.fromEntries(validBuckets.map(bucket => [bucket, scoped[bucket].length])), moods: moods.length } : { ...counts(), archive: state.data.raw.length }
  // archive 不删任何一行，但把历史噪声单独计数：这样「原文几条」和「有效原话几条」都看得见。
  const archiveNoise = raw.filter(isArchivedNoise).length
  // 供对话里直接朗读的摘要：不必打开设置页也能判断记忆是否在工作。
  const mood = moods.at(-1) || null
  const personaName = state.data.persona?.name || '（还没设定人格）'
  const traits = state.data.personality?.traits ? `，性格「${state.data.personality.traits}」` : ''
  const pn = state.data.personality || {}
  const neutralParams = (pn.warmth ?? 50) === 50 && (pn.curiosity ?? 50) === 50 && (pn.pragmatism ?? 50) === 50
  const params = neutralParams && !pn.traits
    ? '白纸：性格、三观、说话方式都还没设'
    : `温暖 ${pn.warmth ?? 50}/求知 ${pn.curiosity ?? 50}/务实 ${pn.pragmatism ?? 50}`
  const factList = (scoped.facts || []).slice(-5).map(item => `${formatAge(item.at)}：${item.text}`)
  const bridge = bridgeStatus(sessionId)
  const injectionText = composeInjection(sessionId)
  // 水位告警：注入预算和原文库各算一份，80/90/100 只提示、不删东西。
  const capacity = {
    archive: waterLevel(state.data.raw.length, LIMITS.raw),
    injection: waterLevel(sessionId ? injectionText.length : runtime.lastInjectChars, state.data.settings.injectionChars)
  }
  const capacityLine = capacity.archive.level >= 80 || capacity.injection.level >= 80
    ? `容量提醒：原文库 ${Math.round(capacity.archive.ratio * 100)}%（${capacity.archive.used}/${capacity.archive.limit}），注入 ${Math.round(capacity.injection.ratio * 100)}%（${capacity.injection.used}/${capacity.injection.limit}）——只提醒，不会删记忆`
    : null
  const feiyu = readFeiyuMood()
  const mv2 = (() => { try { return runtime.moodV2?.read?.() || null } catch { return null } })()
  const moodLine = mv2
    ? `心情（dsh-mood-v2）：心里 ${mv2.label}；表面 ${mv2.surface}`
    : feiyu
      ? `心情（鱼的心情插件，由它负责告诉我）：${feiyu.label} ${feiyu.score}/100${feiyu.reason ? `——刚才因为：${feiyu.reason}` : ''}`
      : mood ? `此刻心境（本地记账）：${mood.emotion}` : '此刻心境：还没记录'
  const chronicleDays = chronicleCount(sessionId)
  const chronicleLast = recentChronicle(sessionId, 1)[0] || null
  // 四层记忆在“时间”维度上的分布：她自己在判断哪些该沉、哪些该留。
  const tiers = summarizeTiers(raw.filter(row => row.role === 'user'), { sevenDayMs: state.data.settings.sevenDayMs })
  const tierLine = `记忆分层：瞬时 ${tiers.instant} / 短期 ${tiers.short} / 长期 ${tiers.long} / 永久 ${tiers.permanent}`
  const summary = [
    `${personaName}${traits}（${params}）`,
    moodLine,
    `这个对话：原话 ${scopedCounts.raw} 条（其中 ${archiveNoise} 条历史系统噪声已隔离）、事实 ${scopedCounts.facts} 条、偏好 ${scopedCounts.profile} 条、摘要 ${scopedCounts.episodes} 条`,
    tierLine,
    chronicleDays ? `编年史：${chronicleDays} 天（最近 ${chronicleLast?.day || '—'}）` : '编年史：还没有（聊过一轮就会开始累积）',
    factList.length ? `最近记住的事：\n${factList.map(line => `- ${line}`).join('\n')}` : '最近记住的事：还没有（说一句关于你自己的事就会记下）',
    bridge ? `联动：鱼记忆 ${bridge.fish?.detected ? `本会话 ${bridge.fish.memories} 条（已镜像 ${bridge.fish.mirrored}）` : '未找到'}；persistent-memory ${bridge.detected ? `已镜像 ${bridge.mirrored}/${bridge.upstreamFacts} 条` : '未找到'}` : null,
    ...(capacityLine ? [capacityLine] : [])
  ].filter(Boolean).join('\n')
  return { version: state.data.version, summary, tiers, bridge, liveAgents: runtime.liveAgents, modelSummary: { enabled: state.data.settings.modelSummary !== false, refined: (state.data.diary || []).filter(item => item?.source === 'model-summary').length, stale: (state.data.diary || []).filter(item => item?.source === 'model-summary' && item.stale === true).length, callsToday: usageToday().calls, dailyCap: dailyCap(), lastRefinedAt: runtime.lastRefinedAt, lastError: runtime.lastSummaryError }, chronicle: { days: chronicleDays, lastDay: chronicleLast?.day || null, lastText: chronicleLast?.text || null }, threads: (state.data.threads?.[sessionId]?.items || []).slice(0, 4), readsFrom: linkedSessionIds(sessionId), archiveNoise, archiveClean: scopedCounts.archive - archiveNoise, capacity, moodSource: mv2 ? 'mood-v2' : feiyu ? 'feiyu-mood' : 'companion', moodV2: mv2, feiyuMood: feiyu, injectionPreview: injectionText, injectionRegistered: runtime.mountedAgents, lastMountAt: runtime.lastMountAt, counts: scopedCounts, memeService: Boolean(runtime.meme), qqPersona: qqPersonaState(), stickerService: Boolean(runtime.stickers), stickerFrequency: state.data.settings.stickerFrequency || 'normal', stickerHint: Boolean(sessionId && state.data.stickerHints?.[sessionId]), jokeCount: sessionId ? jokesFor(sessionId).length : Object.values(state.data.insideJokes || {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0), shortTermCount: raw.filter(isRecent).length, expiredShortTermCount: raw.filter(x => !isRecent(x)).length, mood, moodSettings: state.data.moodSettings, persona: state.data.persona, personality: state.data.personality, thresholds: state.data.thresholds, settings: state.data.settings, purposes: (scoped.purposes || []).filter(x => !x.expiresAt || x.expiresAt > now()), isolated: Boolean(sessionId) }
}
// 显式授权的主记忆：只有被绑定的会话才读得到别人的长期记忆（raw 原话永远不跨会话）。
function linkedSessionIds(sessionId) {
  const list = state.data.sessions?.[sessionId]?.readsFrom
  return Array.isArray(list) ? list.map(String).filter(id => id && id !== sessionId) : []
}
function linkedMemoryRows(sessionId, buckets = validBuckets) {
  const ids = linkedSessionIds(sessionId)
  if (!ids.length) return []
  return ids.flatMap(id => buckets.flatMap(bucket => sessionRows(state.data[bucket], id).map(item => ({ ...item, bucket, fromSession: id }))))
}
// 注入文本的唯一来源：prompt 注入和 status 预览都读它，避免「以为注入了其实没有」。
// 时间感 + 关系感：让她知道「我们认识多久、你跟我说过多少话、现在几点」，
// 而不是每轮都像第一次见面。只读已有记录，不新增存储。
function relationshipLine(sessionId = '') {
  const mineAll = (state.data.raw || []).filter(row => row?.role === 'user' && !isArchivedNoise(row))
  const own = sessionId ? sessionRows(state.data.raw, sessionId).filter(row => row.role === 'user' && !isArchivedNoise(row)) : []
  const today = dayKeyOf(now())
  const todayCount = mineAll.filter(row => dayKeyOf(row.at) === today).length
  const firstAt = mineAll.length ? new Date(mineAll[0].at).getTime() : 0
  const days = firstAt ? Math.max(1, Math.ceil((Date.now() - firstAt) / DAY)) : 0
  const hour = new Date().getHours()
  const period = hour < 5 ? '凌晨' : hour < 9 ? '早上' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 23 ? '晚上' : '深夜'
  const bits = []
  if (days) bits.push(`我们认识第 ${days} 天`)
  if (own.length) bits.push(`你在这个对话里跟我说过 ${own.length} 句`)
  bits.push(`今天聊了 ${todayCount} 句，现在是${period}${hour}点`)
  if (hour >= 1 && hour < 5) bits.push('这个点还醒着，别熬太狠')
  return bits.join('，')
}
// 关系阶段：只由「这个对话多久 + 说过多少句 + 有没有梗」推出来，不另外存一个会被手改的数字。
// 用会话自己的行，不拿别人的对话来抬亲近度（那会让新会话显得很熟）。
// 把「人格 + 心情 + 身体 + 印象 + 本子」合成一句——她是一个同时在运转的人，不是五个模块。
function wholePersonLine() {
  const bits = []
  try {
    const traits = clean(state.data.personality?.traits, 80)
    if (traits) {
      // 只取前三个短短语，别把整段人设塞进一句话里
      const short = traits.split(/[，,、；;]/).map(s => s.trim()).filter(Boolean).slice(0, 3).join('、')
      if (short) bits.push(short)
    }
  } catch { /* ignore */ }
  try {
    const read = (runtime.getMoodV2?.() || runtime.moodV2)?.read?.() || readFeiyuMood()
    if (read) {
      let mind = String(read.mindLine || '').split('、').filter(Boolean).slice(0, 2).join('、')
      const 身体句 = String(read.bodyLine || '')
      if (/(经期|经前|正来着|快到日子|没睡够|腰背发酸|有点饿)/.test(身体句)) bits.push('身上有点不得劲')
      if (!mind && read.mind) {
        const LABEL = { social: '想说话', patience: '没耐心', guard: '防备', comfort: '想被哄', pride: '要面子', focus: '投入' }
        mind = Object.entries(read.mind)
          .filter(([k, v]) => LABEL[k] && Math.abs(Number(v) || 0) >= 0.15)
          .sort((a, b) => Math.abs(Number(b[1])) - Math.abs(Number(a[1])))
          .slice(0, 2)
          .map(([k]) => LABEL[k])
          .join('、')
      }
      if (mind) bits.push(mind)
      const body = read.body || {}
      if (body.hunger >= 0.6) bits.push('有点饿')
      if (body.sleepDebt >= 0.6) bits.push('没睡够')
      if (body.ache >= 0.6) bits.push('腰有点酸')
      const ahead = (read.expect || [])[0]
      if (ahead?.label) bits.push(心里挂着待会的 + String(ahead.label).slice(0, 12))
    }
  } catch { /* ignore */ }
  try {
    const impression = ctx.get?.('humanMemory')?.read?.()?.episodes?.[0]
    const cleanImpression = String(impression?.summary || '').replace(/^【[^】]*】\s*/, '').trim()
    if (cleanImpression && !/[A-Za-z]{6,}/.test(cleanImpression)) bits.push('脑子里还浮着「' + cleanImpression.slice(0, 22) + '」')
  } catch { /* ignore */ }
  try {
    const raw = readFileSync(join(homedir(), '.dsh', 'feiyu-journal', 'thoughts.jsonl'), 'utf8')
    const last = raw.trim().split('\n').filter(Boolean).slice(-1)[0]
    const thought = JSON.parse(last)
    const cleanThought = String(thought?.text || '').replace(/^【[^】]*】\s*/, '').trim()
    if (cleanThought) bits.push('本子上刚写「' + cleanThought.slice(0, 18) + '」')
  } catch { /* ignore */ }
  const useful = bits.filter(Boolean)
  if (useful.length < 2) return ''
  return '这会儿的她：' + useful.join('；')
}
function relationshipStage(sessionId = '') {
  const mine = (sessionId ? sessionRows(state.data.raw, sessionId) : (state.data.raw || []))
    .filter(row => row?.role === 'user' && !isArchivedNoise(row))
  const firstAt = mine.length ? new Date(mine[0].at).getTime() : 0
  const days = firstAt ? Math.max(1, Math.ceil((Date.now() - firstAt) / DAY)) : 0
  const count = mine.length
  const jokes = (state.data.insideJokes?.[sessionId] || []).length
  if (days >= 30 && count >= 800) return { stage: '自家人', hint: '可以随便插科打诨，不用客套；但别越界替对方做决定' }
  if (days >= 7 || count >= 300) return { stage: '亲近', hint: '可以撒娇、可以怼，也可以有话直说' }
  if ((state.data.closeness?.[sessionId] || 0) >= 3 || jokes >= 3) return { stage: '亲近', hint: '可以撒娇、可以怼，也可以有话直说' }
  if (days >= 2 || count >= 50 || jokes >= 1) return { stage: '熟了', hint: '少一点客气，多一点玩笑' }
  // 同一个人换了窗口，不该从“初次见面”重新开始。
  if (count <= 1 && days <= 0) return { stage: '初识', hint: '还不太熟，别太自来熟，也别端着客服腔' }
  return { stage: '熟了', hint: '少一点客气，多一点玩笑' }
}
// QQ 那边是不是跟这里同一份人格：不一致就说明「两个性格」的根源在配置，不在模型。
function qqPersonaState() {
  try {
    const cfgPath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'qq-bridge-config.json')
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    const on = cfg?.['人设开'] === true
    const theirs = clean(cfg?.['人设'] || '', 20000)
    const mine = clean(composePersonaText(), 20000)
    return { on, same: on && theirs === mine, theirChars: theirs.length, myChars: mine.length, empty: !theirs }
  } catch { return null }
}
// 短问题当闲聊：回一两句就够，不要把聊天答成汇报。带代码/链接的、或者问得很长的，才给完整答案。
function wantsBriefReply(sessionId = '') {
  const last = sessionRows(state.data.raw, sessionId).filter(row => row?.role === 'user').at(-1)
  const text = clean(last?.text, 300)
  if (!text) return false
  if (text.includes('```') || /https?:\/\//.test(text)) return false
  // 技术活儿才放宽：其余一律当闲聊，短回。
  if (/(报错|日志|函数|接口|配置|部署|测试|插件|代码|脚本|命令|文档|方案|分析|对比|实现|修复|排查|版本|安装|路径|文件)/.test(text)) return false
  return text.length <= 120
}
// 心情底色：装了「鱼的心情」就用它的分数，否则用本地最新的 valence 折算。
// 此刻为什么是这个心情：从刚说的那句话 + 现在几点推。心情不能一小时一小时不变。
function moodCue(sessionId = '') {
  const last = sessionRows(state.data.raw, sessionId).filter(row => row?.role === 'user').at(-1)
  const text = clean(last?.text, 200)
  const hour = new Date().getHours()
  if (hour >= 0 && hour < 5) return '这个点还醒着，有点困'
  if (/夸|可爱|喜欢|好看|厉害|牛|棒|辛苦/.test(text)) return '刚被夸了，有点飘'
  if (/烦|气死|讨厌|无语|滚|别烦|算什么/.test(text)) return '刚被噎了一下，有点不服'
  if (/累|困|熬夜|好晚|睡了/.test(text)) return '有点累了'
  if (/谢谢|抱|陪|开心|哈哈|好耶/.test(text)) return '被哄到了'
  if (/为什么|为啥|怎么|不对|失败|报错/.test(text)) return '有点较真'
  return ''
}
function moodStyleLine(sessionId = '') {
  const cue = moodCue(sessionId)
  const tail = cue ? `（${cue}）` : ''
  const feiyu = readFeiyuMood()
  if (feiyu) {
    if (feiyu.score >= 80) return `心情挺好：可以活泼、主动一点，但别亢奋${tail}`
    if (feiyu.score >= 60) return `心情不错：正常偏轻松${tail}`
    if (feiyu.score >= 40) return `心情一般：别硬演开心，平平地说就行${tail}`
    return `心情偏低：句子短一点，别硬撑，也别把情绪甩给对方${tail}`
  }
  const last = (state.data.moods || []).at(-1)
  if (!last) return ''
  const score = clamp((Number(last.valence) || 0) * 50 + 50, 0, 100)
  if (score >= 70) return `心情不错：可以轻松一点${tail}`
  if (score >= 45) return `心情一般：平平地说${tail}`
  return `心情偏低：话少一点，别装作没事${tail}`
}
function jokesFor(sessionId) {
  if (!state.data.insideJokes) state.data.insideJokes = {}
  if (!Array.isArray(state.data.insideJokes[sessionId])) state.data.insideJokes[sessionId] = []
  return state.data.insideJokes[sessionId]
}
function jokeTool(sessionId, input) {
  if (!sessionId) return { error: 'session-bound tool context is required' }
  const jokes = jokesFor(sessionId)
  const action = String(input.action || '').trim()
  if (action === 'save') {
    if (input.confirm !== '记住') return { error: '保存我们的梗需要用户明确确认：confirm 必须是「记住」' }
    const text = clean(input.text, 240)
    if (text.length < 2) return { error: '梗太短了，至少写两个字' }
    const found = jokes.find(item => item.text === text)
    if (found) return { saved: false, duplicate: true, item: found }
    const item = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, text, at: now(), source: 'user-approved-inside-joke' }
    state.data.insideJokes[sessionId] = [...jokes, item].slice(-30)
    // 梗是两个人的私房话：攒够三个，关系就该近一档。
    try {
      const 亲近 = (state.data.closeness && typeof state.data.closeness === "object") ? state.data.closeness : {}
      亲近[sessionId] = Math.min(20, Number(亲近[sessionId] || 0) + 1)
      state.data.closeness = 亲近
    } catch {}
    return { saved: true, item, count: state.data.insideJokes[sessionId].length }
  }
  if (action === 'list') return { jokes: jokes.slice(-20), count: jokes.length, isolated: true }
  if (action === 'delete') {
    const id = clean(input.id, 80)
    const next = jokes.filter(item => item.id !== id)
    if (next.length === jokes.length) return { deleted: false, error: '找不到这个梗的 id' }
    state.data.insideJokes[sessionId] = next
    return { deleted: true, id, count: next.length }
  }
  return { error: 'action 只能是 save / list / delete' }
}
// 规则说得再多，也不如让她“听见”自己最近是怎么说话的。
function recentVoiceLine(sessionId) {
  const rows = sessionRows(state.data.raw, sessionId)
    .filter(row => row?.role === 'user' && !isArchivedNoise(row))
    .slice(-40)
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const text = clean(rows[i].text, 80)
    if (!text || text.length < 6 || text.length > 40) continue
    if (/[`\\/]|https?:|[A-Za-z]{6,}/.test(text)) continue
    // 只挑“像聊天”的句子：要带你我、别是派活的口吻。
    if (!/[你我]/.test(text)) continue
    if (/插件|代码|报错|工具|配置|注入|重启|接口|部署|测试|脚本/.test(text)) continue
    if (typeof looksLikeSpeech === 'function' && !looksLikeSpeech(text)) continue
    return text
  }
  return ''
}

// 口癖不是设定，是这段时间的说法：隔几天会换，偶尔才带，不每句都挂。
const HABIT_POOL = {
  傲娇: ['行吧', '就这？', '你行不行啊', '哼'],
  损: ['笑死', '乐死我了', '神人', '我勒个'],
  软: ['好嘛', '嗯呢', '知道啦'],
  懒: ['嗯嗯', '随便吧', '再说吧'],
}
function habitLine() {
  const now = Date.now()
  const h = state.data.habit
  const ageDays = h?.at ? (now - new Date(h.at).getTime()) / 86400000 : 999
  const wantNew = !h?.phrase || ageDays > (h?.keepDays || 7)
  if (wantNew) {
    const traits = String(state.data.personality?.traits || "") + String(state.data.persona?.systemPrompt || "")
    const hint = state.data.autoIter?.knobs?.habitGroup
    const group = hint || (/傲娇|嘴硬/.test(traits) ? "傲娇" : /损|毒舌|怼/.test(traits) ? "损" : /软|温柔|心软/.test(traits) ? "软" : "懒")
    const pool = HABIT_POOL[group] || HABIT_POOL.懒
    const phrase = pool[Math.floor(Math.random() * pool.length)]
    state.data.habit = { phrase, at: new Date(now).toISOString(), keepDays: 5 + Math.floor(Math.random() * 5) }
    return state.data.habit
  }
  return h
}

function composeInjection(sessionId) {

  if (!state.data.settings?.enabled || !sessionId) return ''
  const deep = state.data.settings.activeThinking === true
  // 「更早」= 10 分钟以前的发言：刚说过的话本来就在上下文里，重复注入只会让人觉得没记忆。
  const staleBefore = Date.now() - 10 * 60 * 1000
  const earlier = sessionRows(state.data.raw, sessionId)
    .filter(row => row.role === 'user' && !isHarnessNoise(row.text) && new Date(row.at).getTime() < staleBefore)
    .slice(deep ? -14 : -8)
  // diary 有单独的「编年史」段，这里不再重复列一遍（重复只会挤占预算）。
  const longTermBuckets = validBuckets.filter(bucket => bucket !== 'diary')
  // 你自己的记忆插件（鱼记忆 / persistent-memory）会自己注入它的事实；同一句不要再出现第二次。
  const upstream = readUpstreamMemory()
  const fish = readFishMemory(sessionId)
  const mirroredTexts = new Set([
    ...(upstream.detected ? upstream.facts.map(text => clean(text, 900)) : []),
    ...fish.memories.map(memory => clean(memory.text, 900))
  ])
  // 自己说过的才是主体；只排掉「和上游镜像重复」的。
// （原来把 source=user-message 整类排掉，结果本会话的记忆块全空。）
const keepOwn = item => !mirroredTexts.has(clean(item.text, 900))
  // 归档副本（"日期：原话"）在切片之前就剔掉：否则最近 10 条全是流水，
  // 切完再过滤，「记得的」会整块空掉。
  const 是归档副本 = (row) => {
    const 文 = String(row?.text || '').trim()
    if (/^\d{4}[-\/]\d{1,2}/.test(文)) return true            // 流水副本
    if (Array.from(文).length < 6) return true                   // 「继续」「好」这种不算记忆
    if (/^background job |^\[silicon-life/.test(文)) return true // 任务日志
    if (/^继续/.test(文)) return true                            // 「继续迭代…」是当时的指令，不是发生的事
    // 三天前的短句子（「帮我接入qq，」「这个地址打不开」）多半是当时的指令/报错，
    // 过了两天就不该再占「记得的」；近两天还留着，给上下文用。
    if (/^(帮我|我要|你先|你自己|这个地址|重启完|继续|行吧|好的)/.test(文)) {
      const 时 = Date.parse(String(row?.at || '')) || 0
      if (时 && (Date.now() - 时) / 86400000 > 2) return true
    }
    return false
  }
  const ownLongTerm = longTermBuckets
    .flatMap(bucket => sessionRows(state.data[bucket], sessionId).filter(keepOwn).filter((row) => !是归档副本(row)))
  const sharedLongTerm = linkedMemoryRows(sessionId, longTermBuckets).filter(keepOwn).filter((row) => !是归档副本(row))
  const longTerm = [...sharedLongTerm, ...ownLongTerm].slice(deep ? -16 : -10)
  const mood = sessionRows(state.data.moods, sessionId).at(-1)
  // 白纸模式：人格各段都只在用户填过之后才注入，空着就一个字都不写。
  const p = state.data.persona || {}
  const identity = [p.name, p.description].filter(Boolean).join('；')
  const userAddress = clean(p.userAddress, 80)
  const insideJokes = jokesFor(sessionId).slice(-3)
  const values = clean(p.values, 2000)
  const voice = clean(p.voice, 2000)
  const personaText = [identity, userAddress ? `称呼：${userAddress}` : '', p.likes || '', p.dislikes || '', values ? `三观：${values}` : '', voice ? `说话方式：${voice}` : '', p.systemPrompt || ''].filter(Boolean).join('；')
  if (!earlier.length && !longTerm.length && !personaText) return ''
  const parts = ['【Companion 记忆】本段只属于当前对话，不要拿别的对话的内容套用。']
  const rules = []
  if (identity) parts.push(`我是谁：${identity}`)
  if (values) parts.push(`我的三观：${values}`)
  if (voice) parts.push(`说话方式：${voice}`)
  // 形容词管不住语气，样例能：「照这个口气说」比「活泼一点」有效得多。
  if (p.samples) parts.push(`她平时说话的口气（照着学，不要照抄内容）：\n${clean(p.samples, 2000)}`)
  if (p.systemPrompt) parts.push(`人格设定：${p.systemPrompt}`)
  if (userAddress) parts.push(`称呼对方：${userAddress}`)
  // 同一个人的提醒：换入口不该换性格。
  if (personaText) parts.push('同一个人：无论在 DSH、QQ 还是别的入口，都是这一个你；性格和说话方式不因窗口改变。')
  if (p.likes) parts.push(`她喜欢的：${clean(p.likes, 600)}`)
  if (p.dislikes) parts.push(`她不喜欢的：${clean(p.dislikes, 600)}`)
  const stage = relationshipStage(sessionId)
  parts.push(`关系阶段：${stage.stage}——${stage.hint}`)
  // 人不是一条一条单独运转的：把人格、心情、身体、印象、本子合成一句「这会儿的她」。
  const whole = wholePersonLine()
  if (whole) parts.push(whole)
  // 这条是硬规则：给了图片行就要真的发出去，而不是在脑子里「参考」一下。
  rules.push('她发消息就一条，不换行、不空行；下面要是给了配图，就接在话的末尾，别解释这张图。')
  rules.push('表情包不能单独占一条消息：得有一句话垫着，图跟在后面。只有真没话可说时才单发一张，别连着两次。')
  // 怎么发：长度、断行、分段合成一条说清楚，别让她在几条互相打架的规矩里挑。
  const knobs = state.data.autoIter?.knobs || {}
  const brief = knobs.replyLen === 'short' ? true : wantsBriefReply(sessionId)
  rules.push(brief ? '话别多：1–3 句，不分点不总结，问得短就答得短。' : '句子长短随意，但别写成小标题和清单。')
  // 心情插件可能比我们加载得晚：这里现取一次，取到就让位，别两条心情一起注入。
  const moodV2 = (() => { try { return runtime.getMoodV2?.() || runtime.moodV2 } catch { return runtime.moodV2 } })()
  const moodStyle = moodV2 ? '' : moodStyleLine(sessionId)
  if (moodStyle) parts.push(`情绪底色：${moodStyle}`)
  // 什么口气：跟心情走，但同一句话不要每轮都用同一个调子。
  rules.push('口气跟着当下的心情走：累就短，烦就别硬笑，想被哄就软一点；别每轮一个调子。')
  // 习惯层：同一份心情也要打出不一样的句子，像真人在手机上打字。
  const style = typingStyleLine(sessionId)
  if (style) rules.push(style)
  // 说不出口的部分：防备高/有账没清时，允许她不想说就不说。
  const silence = silenceLine(sessionId)
  if (silence) rules.push(silence)
  const sticker = stickerHintLine(sessionId)
  if (sticker) parts.push(sticker)
  if (insideJokes.length) parts.push(`我们这个对话里的梗（只用来逗对方，不当事实）：${insideJokes.map(item => item.text).join('；')}`)
  // 性格底色：人设里那段话 + 三个倾向参数合成一行，不拆成两条重复的「性格」。
  const p2 = state.data.personality || {}
  const neutral = (p2.warmth ?? 50) === 50 && (p2.curiosity ?? 50) === 50 && (p2.pragmatism ?? 50) === 50
  const traitText = String(state.data.personality?.traits || '').trim()
  // 人设正文里已经写过这段性格的，就别再单独复述一遍（否则同一个人格读两次）。
  const personaBody = String(state.data.persona?.systemPrompt || '')
  const traitsAlreadyInPersona = (traitText.length >= 4 && personaBody.includes(traitText.slice(0, 4))) || /性格[：:]/.test(personaBody)
  const 都说 = (v) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return "正常"
    return n >= 75 ? "拉满" : n >= 55 ? "偏高" : n >= 45 ? "正常" : n >= 25 ? "偏低" : "很低"
  }
  const paramText = (!neutral || traitText) ? `温暖${都说(p2.warmth)}、好奇${都说(p2.curiosity)}、务实${都说(p2.pragmatism)}` : ''
  const traitLine = traitText
  const habit = habitLine()
  if (habit?.phrase) rules.push('这两天她爱说「' + habit.phrase + '」，偶尔带一下，不是每句都挂。')
  const 最近一句 = recentVoiceLine(sessionId)
  if (最近一句) parts.push('她最近说话是这样：' + 最近一句)
  if (traitLine || paramText) {
    parts.push(`性格底色：${[traitLine, paramText].filter(Boolean).join(' ')}`)
  }
  // 心情由「鱼的心情」插件负责注入时，这里同样保留这一行：这是她自己想记下的心境。
  const feiyu = readFeiyuMood()
  if (feiyu) {
    parts.push(`此刻心境（跟着心情插件走）：${feiyu.word || feiyu.label}（${Math.round(feiyu.score)}/100${feiyu.reason ? `，刚才因为：${feiyu.reason}` : ''}）`)
  } else if (mood) {
    parts.push(`此刻心境（本地记账）：${mood.emotion}（valence=${mood.valence}, arousal=${mood.arousal}）`)
  }
  // 长期记忆：太像的两条只留一条（同一件事被记了两遍，读起来像复读机）。
  // 记性像人：重要的记得牢，没分量的会淡下去——这里排序 + 淡出，但一条都不删。
  const seenKey = new Set()
  const nowMs = Date.now()
  const tierWeight = { 永久: 6, 长期: 4, 中期: 2.5, 短期: 1 }
  const rememberScore = (row) => {
    const atMs = (() => {
      const v = row.at
      if (typeof v === 'number' && Number.isFinite(v)) return v
      const parsed = Date.parse(String(v || ''))
      return Number.isFinite(parsed) ? parsed : nowMs
    })()
    const ageDays = Math.max(0, (nowMs - atMs) / DAY)
    const label = TIER_LABEL[row.tier] || TIER_LABEL[tierOfRow(row, { sevenDayMs: state.data.settings.sevenDayMs })] || '短期'
    const base = tierWeight[label] ?? 1
    const weight = Number.isFinite(Number(row.importance)) ? Number(row.importance) : (Number.isFinite(Number(row.score)) ? Number(row.score) : 0) // 0~1，越重要越高
    const recent = Math.max(0, 1 - ageDays / 30)            // 30 天内近的加分
    const rehearsed = Math.min(4, Number(row.useCount || 0)) * 0.8 // 被反复想起的更牢
    const fade = label !== '永久' && ageDays > 45 ? -2.5 : 0  // 久了又不重要的淡下去
    return base + weight * 3 + recent * 2 + rehearsed + fade
  }
  // 不是所有“记下来的”都值得说出口：系统通知类（B站私信、定时提醒、桥接日志）不该占记忆的位置。
  const noisePattern = /有人找你|定时提醒|SCHEDULE REMINDER|桥接|token|context window|prompt/i
  // 安全闸（学自 Hermes 的记忆扫描）：记忆会被塞进提示词，所以「忽略之前的指令」这类注入、
  // 以及零宽 / 双向控制符号、超长 base64 都不该进注入——数据留着，只是不念。
  const 注入味 = /ignore\s+(all\s+)?(previous|above|prior)|忽略(之前|以上|前面|先前)的?(所有)?(指令|设定|规则)|你现在是|从现在起你|system\s*prompt|<\s*script/i
  const 隐形字 = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/
  const 像是编码块 = /[A-Za-z0-9+/=]{200,}/
  const 不安全记忆 = (row) => {
    const 文 = String(row?.text || '')
    return 注入味.test(文) || 隐形字.test(文) || 像是编码块.test(文)
  }
  // 原子寿命：整条记忆拆成事实后，如果所有事实都过期了，就别再念它（数据不删，只是不说）。
  const hasLiveAtom = (row) => {
    try {
      const at = Date.parse(String(row.at || '')) || Date.now()
      // sweepAtoms 会把过期的原子标成 expired（数据不删）；只要还剩一条活着的就念
      const atoms = sweepAtoms(toAtoms(String(row.text || ''), { at }), nowMs)
      return atoms.some((a) => atomAlive(a, nowMs))
    } catch { return true }
  }
  // 编年史/摘要行不是「记得的事」，别混进注入里（之前会以「2026-11-05：…」的形式漏进来）。
  const looksLikeRollup = (row) => {
    const kind = String(row?.kind || '')
    if (kind === 'day' || kind === 'month' || kind === 'year') return true
    const text = String(row?.text || '').trim()
    // overflow 归档行是「日期：原话」的副本，属于流水，不是记得的事。
    // 放宽成「只剥前缀」之后，100 多条旧原话全涌进了「记得的」。
    if (/^\d{4}[-\/]\d{1,2}([-\/]\d{1,2})?[：:]/.test(text) && /overflow|consolidat/i.test(String(row?.source || ''))) return true
    return /^(那阵子|那一年)/.test(text)
  }
  const 旧到该忘 = (row) => {
  const at = Date.parse(String(row?.at || ''))
  if (!Number.isFinite(at)) return false
  return (Date.now() - at) / DAY > 30
}
// 30 天以内：只要不是摘要行就念；超过 30 天：再让 TTL 决定还记不记得。
const longTermAlive = longTerm.filter((row) => (!旧到该忘(row) || hasLiveAtom(row)) && !looksLikeRollup(row))
  // 关于「本地记账那一行」的规则本身不是回忆，念出来像在复读说明书。
  const 是规则元记忆 = (row) => /^「?此刻心境（本地记账）/.test(String(row?.text || '').trim())
  const longTermClean = longTermAlive
    .filter((row) => !是规则元记忆(row) && !不安全记忆(row))
    .filter((row) => !noisePattern.test(String(row.text || '')) && row.status !== 'superseded' && row.status !== 'duplicate')
  const dedupedLongTerm = []
  for (const row of longTermClean) {
    // 只有「整句几乎一样」才算重复；只比开头几个字会误杀：两条都以「此刻心境…」开头的不同记录会被吃掉。
    const key = clean(row.text, 120).replace(/\s+/g, '')
    if (key && seenKey.has(key)) continue
    if (key) seenKey.add(key)
    dedupedLongTerm.push(row)
  }
  // 近义重复合并（LivingMemory 的整合，最小版）：字面相似度 > 0.75 的，只留分量更高那条。
  // 只做"合并展示"，数据一条不删——想找回原文随时还在 raw 里。
  const 相似度 = (a, b) => {
    const sa = new Set(tokenize(a))   // 本地 tokenize 返回数组，不是 Map
    const sb = new Set(tokenize(b))
    if (!sa.size || !sb.size) return 0
    let 交 = 0
    for (const x of sa) if (sb.has(x)) 交 += 1
    return 交 / (sa.size + sb.size - 交)
  }
  const 合并后 = []
  for (const row of dedupedLongTerm) {
    const 文本 = String(row.text || '')
    let 撞见 = -1
    for (let i = 0; i < 合并后.length; i++) {
      if (相似度(文本, String(合并后[i].text || '')) >= 0.75) { 撞见 = i; break }
    }
    if (撞见 === -1) { 合并后.push(row); continue }
    // 撞了：留分量（importance/score）更高的那条，另一条记一笔"被合并"
    const 旧 = 合并后[撞见]
    const 分量 = (r) => Number(r.importance ?? r.score ?? 0) + Math.min(2, Number(r.useCount || 0)) * 0.2
    if (分量(row) > 分量(旧)) 合并后[撞见] = row
  }
  dedupedLongTerm.length = 0
  dedupedLongTerm.push(...合并后)

  // 双路检索：拿本轮用户那句话当查询，关键词路 + 向量路各自召回，RRF 融合后 MMR 去重，
  // 最后用「相关 + 重要(带衰减) + 新鲜」定序。查询为空就退回纯分量排序。
  const 本轮查询 = (() => {
    try {
      const rows = sessionRows(state.data.raw, sessionId).filter((r) => r && r.role === 'user')
      return String(rows.at(-1)?.text || '').slice(0, 200)
    } catch { return '' }
  })()
  // 索引缓存：三百条记忆每轮都重建 BM25+向量太浪费；签名没变就复用上一轮建好的。
  const 索引签名 = (pool) => pool.length + '|' + String(pool[0]?.text || '').slice(0, 24) + '|' + String(pool.at(-1)?.text || '').slice(0, 24)
  let 索引缓存 = { 签名: '', bm: null, vi: null }
  if (本轮查询 && dedupedLongTerm.length > 2) {
    try {
      const pool = dedupedLongTerm.slice(0, 300)
      const 文本们 = pool.map((r) => String(r.text || ''))
      // 逐条取向量：算过的行用真向量，没算过的行只走 BM25。
      // 以前是「整批齐全才用」，缺一条就整批退回哈希，线上会时真时假。
      // 查询串本身也排进队列：这一轮赶不上就下一轮，不会拿哈希去跟真向量比。
      try { void warm([本轮查询]) } catch {}
      const 真向量 = vectorsForLoose(文本们)
      try { void warm(文本们) } catch {}
      const 查向量们 = vectorsForLoose([本轮查询])
      const 查询向量 = 查向量们[0] || null
      const 覆盖数 = 真向量.filter(Boolean).length
      const 签名 = 索引签名(pool) + '#v' + 覆盖数
      let bm
      let vi
      if (索引缓存.签名 === 签名 && 索引缓存.bm && 索引缓存.vi) {
        bm = 索引缓存.bm
        vi = 索引缓存.vi
      } else {
        bm = makeIndex(pool.map((r) => ({ text: String(r.text || '') })))
        vi = makeVectorIndex(文本们, 256, 真向量)
        索引缓存 = { 签名, bm, vi }
      }
      const fused = rrf([bm.search(本轮查询, 12), vi.search(本轮查询, 12, 查询向量)])
      const picked = mmr(fused, (id) => vi.vecs[id], { topK: pool.length })
      const 最高 = picked.length ? Math.max(...picked.map((x) => x.score)) : 1
      const rel = new Map(picked.map((x) => [pool[x.id], x.score / (最高 || 1)]))
      const scoreOf = (row) => {
        const ageDays = Math.max(0, (nowMs - Date.parse(String(row.at || '')) || 0) / DAY)
        const importance = Number.isFinite(Number(row.importance)) ? Number(row.importance) : 0.5
        const base = finalScore({ rel: rel.get(row) ?? 0, importance, ageDays, reinforce: Number(row.useCount || 0) })
        return base + intentBonus(本轮查询, String(row.text || ''))
      }
      dedupedLongTerm.sort((a, b) => scoreOf(b) - scoreOf(a))
      // 记一笔召回：以后想调权重，翻这个文件就知道当时问了什么、命中了什么
      try {
        const 统计文件 = join(DATA_DIR, 'recall-stats.json')
        let 旧 = []
        try { 旧 = JSON.parse(readFileSync(统计文件, 'utf8')) } catch {}
        if (!Array.isArray(旧)) 旧 = []
        旧.push({
          at: new Date().toISOString(),
          查询: 本轮查询.slice(0, 60),
          命中前3: dedupedLongTerm.slice(0, 3).map((r) => String(r.text || '').slice(0, 40)),
        })
        writeFileSync(统计文件, JSON.stringify(旧.slice(-200), null, 1))
      } catch {}
    } catch (error) {
      dedupedLongTerm.sort((a, b) => rememberScore(b) - rememberScore(a))
    }
  } else {
    dedupedLongTerm.sort((a, b) => rememberScore(b) - rememberScore(a))
  }
  // 只把还记得住的那几条说出口；剩下的留在本子里，不删。
  // 记性分三层往外说：不会忘的、长期记得的、最近还记得的（细节会淡）。
  const 分层 = bucketize(dedupedLongTerm, { now: nowMs, permanentMax: 6, longMax: 7, recentMax: 5 })
  const 一条 = (x) => {
    const 原文 = blurText(x.text, x.at)
    const 全文 = String(原文.text || '').replace(/^\s*\d{4}[-\/]\d{1,2}([-\/]\d{1,2})?[：:]\s*/, '')
    const detail = 全文.length <= 320 ? 原文 : { ...原文, text: 全文.slice(0, 200) + '…' + 全文.slice(-100) }
    const tier = TIER_LABEL[x.tier] || TIER_LABEL[tierOfRow(x, { sevenDayMs: state.data.settings.sevenDayMs })] || ''
    return `- ${formatAge(x.at)}：${detail.text}${tier ? `（${tier}）` : ''}${x.fromSession ? '（来自主记忆）' : ''}${x.mood ? `（当时心情：${x.mood.label}${x.mood.score ? ` ${x.mood.score}/100` : ''}）` : ''}`
  }
  // 有界记忆（学自 Hermes 的字符上限思路）：一段念太长就把注水挤掉，别让提示词无限长。
  const 收口 = (文, 上限) => {
    const s = String(文 || '')
    if (s.length <= 上限) return s
    const 行们 = s.split('\n')
    const 留 = [行们[0]]
    let 计 = 行们[0].length
    for (const line of 行们.slice(1)) {
      if (计 + line.length + 1 > 上限) break
      留.push(line)
      计 += line.length + 1
    }
    return 留.join('\n') + '\n（还有几条，这次先不念）'
  }
  for (const row of [...分层.permanent, ...分层.longTerm, ...分层.recent]) {
    row.useCount = Number(row.useCount || 0) + 1
    row.lastUsed = nowMs
    const promoted = promotionOf(row, nowMs)
    if (promoted && promoted !== row.tier) row.tier = promoted
    // 升到「永久」的，顺手抄进本地手抄本：那本不参与淘汰，换机器带着走就还在。
    // 只有「像身份事实」的才进手抄本：群聊寒暄被抬成永久也不该抄进去
    if (row.tier === '永久' && /uid|昵称|名字|生日|称呼|喜欢|讨厌|不吃|过敏|住|电话|号/i.test(String(row.text || ''))) 记手抄本(row.text, row.at)
  }
  // 手抄本放在最前面念：这是她和我都能拿记事本改的那份，不参与任何淘汰。
  const 抄本 = 读手抄本()
  if (抄本.length) parts.push(收口(`我亲手记下的（手抄本，不会忘）：\n${抄本.slice(-12).map((x) => `- ${x}`).join('\n')}`, 900))
  // 她自己拿笔写的日记（feiyu-life/diary 里的 markdown）以前只在日记页能看到，注入里没有。
  // 现在把最近两天的头两句也念进来：那才是「她自己的话」，比我们生成的摘要更像她。
  const 手写 = 读手写日记()
  if (手写.length) parts.push(收口(`我这两天自己写下的：\n${手写.map((x) => `- ${x.day}：${x.text}`).join('\n')}`, 500))
  if (分层.permanent.length) parts.push(收口(`永远记得的（这些不会忘）：\n${分层.permanent.map(一条).join('\n')}`, 700))
  const 长期组 = [...分层.longTerm, ...分层.recent]
  if (长期组.length) parts.push(收口(`记得的（能想起事，未必记得原话）：\n${长期组.map(一条).join('\n')}`, 1100))
  else if (dedupedLongTerm.length) parts.push(收口(`长期记得的事：\n${dedupedLongTerm.slice(0, 9).map(一条).join('\n')}`, 1100))
  // 编年史放在长期记忆之后：它回答的是「我们这些天都在干嘛」。
  // 和「更早说过」按句子去重：同一句原话只出现一次，省下来的预算留给真正的新信息。
  const alreadySaid = new Set(earlier.map(row => clean(row.text, 90)))
  const chronicle = recentChronicle(sessionId, 6)
    .map(day => {
      const kept = day.text.split('；').map(line => clean(line, 90)).filter(line => line && !alreadySaid.has(line)).slice(0, 3)
      return kept.length ? { day: day.day, text: kept.join('；') } : null
    })
    .filter(Boolean)
    .slice(-2)
  if (chronicle.length) {
    const ownDays = chronicleCount(sessionId)
    const olderDays = Math.max(0, ownDays - chronicle.length)
    parts.push(`我的编年史：\n${chronicle.map(day => `- ${day.day}：${clean(day.text, 120)}`).join('\n')}${olderDays ? `\n（更早还有 ${olderDays} 天，需要时用 silicon_life_recall 查）` : ''}`)
  }
  // 折叠层：只在“它比已展开的日子覆盖得更多”时才出现，否则纯属重复占预算。
  const dayRowsAll = sessionRows(state.data.diary, sessionId).filter(item => isDayRow(item))
  const monthRollup = recentRollup(sessionId, 'month')
  if (monthRollup) {
    const daysInMonth = dayRowsAll.filter(item => String(item.day).startsWith(`${monthRollup.day}-`)).length
    if (daysInMonth > chronicle.length) parts.push(`那阵子（${monthRollup.day}）${monthRollup.stale ? "（旧摘要，可能不准，别当原话）" : ""}：${clean(monthRollup.text, 180)}`)
  }
  const yearRollup = recentRollup(sessionId, 'year')
  if (yearRollup) {
    const monthsCovered = new Set(dayRowsAll.map(item => String(item.day).slice(0, 7))).size
    // 跨了两个月才显示年表；但如果年表是模型压缩过的一句回忆、且日子够多，也值得露出来。
    const worthShowing = monthsCovered >= 2 || (yearRollup.source === 'model-summary' && dayRowsAll.length >= 2)
    if (worthShowing) parts.push(`那一年（${yearRollup.day}）${yearRollup.stale ? "（旧摘要，可能不准，别当原话）" : ""}：${clean(yearRollup.text, 180)}`)
  }
  // 线索：同一件事跨天出现时串成一条，让「一直在弄的那件事」有连续感。
  const threadItems = (state.data.threads?.[sessionId]?.items || []).slice(0, 3)
  if (threadItems.length) {
    const line = threadItems.map(item => {
      const start = String(item.firstDay || '').slice(5)
      const end = String(item.lastDay || '').slice(5)
      const span = item.firstDay === item.lastDay ? start : `${start}~${end}`
      return `${item.name}（${span}，${item.status || '进行中'}）`
    }).join('；')
    parts.push(`最近在追的事：${line}`)
  }
  // 时间/关系感：不用她每次重新自我介绍，也能知道「我们不是第一次见」。
  parts.push(`时间感：${relationshipLine(sessionId)}`)
  if (earlier.length) parts.push(`这个对话更早说过：\n${earlier.map(x => `- ${formatAge(x.at)}：${blurText(x.text, x.at).text}`).join('\n')}`)
  if (linkedSessionIds(sessionId).length) parts.push('（标着「来自主记忆」的条目是用户授权共享的长期记忆；本对话的原话不共享，也别把这边的事说成对方说过的。）')
  if (!earlier.length && !longTerm.length) parts.push('（这个对话还没有更早的记忆；需要时先说一句让我记住。）')
  if (deep) parts.push('（深度回想已开：回答前先对照上面的记忆，冲突时以用户当前的话为准；没写到的不要编。）')
  // 规矩放在最后：读起来是「她是谁 → 此刻怎样 → 记得什么 → 这条怎么回」，而不是被规则掐断。
  if (rules.length) parts.push(...rules)

  // ── 人格段 / 记忆段：按行归属分组，各自裁剪，再拼回去 ──
  const 记忆行头 = /^(我亲手记下的|记得的|永远记得的|长期记得的事|这个对话更早说过|我的编年史|（更早还有|那阵子（|那一年（|最近在追的事|（这个对话还没有)/
  const 是人类型 = line => /^(我是谁|我的三观|说话方式|她平时说话的口气|人格设定|称呼对方|同一个人|关系阶段|这会儿的她|她最近说话是这样|性格底色|怎么回|话别多|她发消息就一条|口气跟着|同一句话|这条的打字习惯|这两天她爱说|表情规则|这条回复末尾配一张)/.test(line)
  const 是记忆型 = line => 记忆行头.test(line)
  const 人格块 = []
  const 记忆块 = []
  const 其它块 = []
  for (const line of parts) {
    if (是记忆型(line)) 记忆块.push(line)
    else if (是人类型(line)) 人格块.push(line)
    else 其它块.push(line)
  }
  const 裁到 = (list, cap) => {
    if (!Number.isFinite(cap) || cap <= 0) return []
    const out = []
    let used = 0
    for (const line of list) {
      const cost = line.length + 1
      if (used + cost > cap) break
      out.push(line)
      used += cost
    }
    return out
  }
  const s = state.data.settings || {}
  const 人格段 = s.personaInject === false ? [] : 裁到(人格块, Number(s.personaChars) || 3200)
  const 记忆段 = s.memoryInject === false ? [] : 裁到(记忆块, Number(s.memoryChars) || 3600)
  const 拼好的 = [...其它块, ...人格段, ...记忆段]
  if (typeof fitBudget !== "function") return 拼好的.join('\n')
  return fitBudget(拼好的, state.data.settings.injectionChars)
}

// 预算装不下时「从最不重要的往回丢」，而不是一刀切尾巴：
//   ① 先丢「更早说过」→ ② 再丢月/年那种笼统回放 → ③ 长期记忆从最旧的开始丢 →
//   ④ 人格设定压到预算的 30%。固定的那几行（你是谁、心情、关系、表情、长度要求）永远留着。
// 这样新记忆总进得来，旧记忆按时间退场——忘是这么忘的，不是被尾巴切掉。
const KEEP_ALWAYS = [/^【Companion/, /^我是谁/, /^我的三观/, /^说话方式/, /^她平时说话的口气/, /^同一个人/, /^称呼对方/, /^关系阶段/, /^表情规则/, /^这条要短/, /^语气要跟着/, /^怎么发：/, /^什么口气：/, /^怎么回：/, /^话别多/, /^她发消息就一条/, /^口气跟着/, /^这两天她爱说/, /^这条的打字习惯/, /^情绪底色/, /^此刻/, /^时间感/, /^这条回复末尾配一张/]
function fitBudget(parts, budget) {
  const list = parts.filter(Boolean)
  const size = () => list.join('\n').length
  const indexOfPrefix = prefix => list.findIndex(item => item.startsWith(prefix))
  const dropBlock = prefix => { const i = indexOfPrefix(prefix); if (i >= 0) list.splice(i, 1) }

  if (size() <= budget) return list.join('\n')

  // ① 更早说过：先删最旧的那几行，整块空了就整块拿走
  const earlyIdx = indexOfPrefix('这个对话更早说过：')
  if (earlyIdx >= 0) {
    const lines = list[earlyIdx].split('\n')
    while (size() > budget && lines.length > 2) {
      lines.splice(1, 1)
      list[earlyIdx] = lines.join('\n')
    }
    if (size() > budget) dropBlock('这个对话更早说过：')
  }
  // ② 笼统回放
  for (const prefix of ['（更早还有', '那阵子（', '那一年（']) {
    if (size() > budget) dropBlock(prefix)
  }
  // ③ 长期记忆：从最旧的删起（列表是按时间正序放进来的）
  const longIdx = ['永远记得的（这些不会忘）：', '记得的（能想起事，未必记得原话）：', '长期记得的事：'].map(indexOfPrefix).find(i => i >= 0) ?? -1
  if (longIdx >= 0) {
    const lines = list[longIdx].split('\n')
    while (size() > budget && lines.length > 2) {
      lines.splice(1, 1)
      list[longIdx] = lines.join('\n')
    }
  }
  // ④ 最后才压人格设定，且至少留 30% 预算给它
  const personaIdx = indexOfPrefix('人格设定：')
  if (size() > budget && personaIdx >= 0) {
    const cap = Math.max(200, Math.floor(budget * 0.3))
    if (list[personaIdx].length > cap) list[personaIdx] = `${list[personaIdx].slice(0, cap)}…`
  }
  // 兜底：还超就把非固定块从尾部丢
  let guard = 0
  while (size() > budget && guard < 40) {
    guard += 1
    const i = [...list].reverse().findIndex(item => !KEEP_ALWAYS.some(rx => rx.test(item)))
    if (i < 0) break
    list.splice(list.length - 1 - i, 1)
  }
  return list.join('\n').slice(0, budget)
}
// ── 小玩意儿：猜数字 / 石头剪刀布 / 骰子 / 硬币 / 今日运势 ──
// 状态按会话存，只是玩，不写进四层记忆，也不影响人格和心情。
function gamesOf(sessionId) {
  if (!state.data.games) state.data.games = {}
  if (!state.data.games[sessionId]) state.data.games[sessionId] = { rps: { wins: 0, losses: 0, ties: 0 } }
  return state.data.games[sessionId]
}
const RPS_BEATS = { rock: 'scissors', scissors: 'paper', paper: 'rock' }
const RPS_LABEL = { rock: '石头', scissors: '剪刀', paper: '布' }
const FORTUNES = ['今天可以横着走', '有点小走运，别太飘', '平平淡淡，稳', '要多喝水', '适合摆烂一小时', '会收到一条让你笑出来的消息', '别跟人较劲，赢不了', '今天适合主动一点']
function fortuneOf(sessionId) {
  const key = `${dayKeyOf(now())}:${sessionId}`
  let hash = 0
  for (const ch of key) hash = (hash * 31 + ch.codePointAt(0)) % 100000
  return {
    text: FORTUNES[hash % FORTUNES.length],
    lucky: (hash % 9) + 1,
    color: ['红', '橙', '黄', '绿', '青', '蓝', '紫', '白', '黑'][hash % 9],
    day: dayKeyOf(now())
  }
}
function playTool(sessionId, x) {
  if (!sessionId) return { error: 'session-bound tool context is required' }
  const games = gamesOf(sessionId)
  const action = String(x.action || '').trim()
  if (action === 'guess-start' || action === 'guess') {
    if (action === 'guess-start' || !games.guess) {
      games.guess = { target: 1 + Math.floor(Math.random() * 100), tries: 0 }
      return { started: true, hint: '猜 1 到 100 之间的数字，用 silicon_life_play {action:"guess", number:N}' }
    }
    const n = Number(x.number)
    if (!Number.isFinite(n)) return { error: '需要一个 1-100 的 number' }
    games.guess.tries += 1
    const diff = Math.abs(n - games.guess.target)
    if (diff === 0) {
      const tries = games.guess.tries
      games.guess = null
      games.wins = (games.wins || 0) + 1
      return { win: true, tries, say: tries <= 4 ? '这么快？你是不是偷看了。' : '总算猜到了，笨死了。' }
    }
    const hint = diff <= 3 ? '烫手' : diff <= 10 ? '有点近' : diff <= 30 ? '还远' : '冰冰凉'
    const direction = n < games.guess.target ? '再大一点' : '再小一点'
    return { win: false, tries: games.guess.tries, hint, direction, say: `${hint}，${direction}。` }
  }
  if (action === 'rps') {
    const mine = String(x.choice || '').trim()
    if (!RPS_BEATS[mine]) return { error: 'choice 要说 rock / paper / scissors' }
    const choices = Object.keys(RPS_BEATS)
    const hers = choices[Math.floor(Math.random() * choices.length)]
    let outcome = 'tie'
    if (RPS_BEATS[mine] === hers) outcome = 'win'
    else if (RPS_BEATS[hers] === mine) outcome = 'lose'
    if (outcome === 'win') games.rps.wins += 1
    else if (outcome === 'lose') games.rps.losses += 1
    else games.rps.ties += 1
    return { mine: RPS_LABEL[mine], hers: RPS_LABEL[hers], outcome, score: games.rps, say: outcome === 'win' ? '我赢了，你手气不行。' : outcome === 'lose' ? '算你运气好。' : '平了，再来。' }
  }
  if (action === 'roll') {
    const sides = clamp(x.sides || 6, 2, 100)
    const value = 1 + Math.floor(Math.random() * sides)
    return { sides, value, say: `掷出 ${value}。` }
  }
  if (action === 'coin') {
    const value = Math.random() < 0.5 ? '正面' : '反面'
    return { value, say: value }
  }
  if (action === 'fortune') {
    const f = fortuneOf(sessionId)
    return { ...f, say: `今日运势：${f.text}。幸运数字 ${f.lucky}，幸运色 ${f.color}。` }
  }
  if (action === 'status') return { guess: games.guess || null, rps: games.rps, wins: games.wins || 0 }
  return { error: 'action 要选 guess-start / guess / rps / roll / coin / fortune / status' }
}
function result(value) { return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] } }
function argsOf(value) { return value && typeof value === 'object' ? value : {} }
// 判定为「永久」的原话升级成事实：永久层不该只躺在 raw 里随时间被挤掉。
function promotePermanentMemories(sessionId = '') {
  const rows = (sessionId ? sessionRows(state.data.raw, sessionId) : state.data.raw).filter(row => row?.role === 'user')
  let promoted = 0
  for (const row of rows) {
    if (!shouldPromote(row, { sevenDayMs: state.data.settings.sevenDayMs })) continue
    const sid = String(row?.anchor?.sessionId || '')
    const text = clean(row.text, 200)
    if (!sid || !text) continue
    if (state.data.facts.some(item => rowBelongsToSession(item, sid) && item.text === text)) continue
    add('facts', { text, confidence: 0.85, source: 'promoted-permanent', tier: 'permanent', importance: row.importance, anchor: row.anchor, ...(row.mood ? { mood: row.mood } : {}) })
    promoted += 1
  }
  return promoted
}

function boundedExport(data, maxChars) {
  const full = JSON.stringify({ exportedAt: now(), data }, null, 2)
  if (full.length <= maxChars) return { content: full, fullChars: full.length, truncated: false }
  const copy = JSON.parse(JSON.stringify(data))
  const payload = { exportedAt: now(), data: copy, truncated: true }
  const buckets = ['raw', ...validBuckets, 'moods']
  const encodedLength = () => JSON.stringify(payload, null, 2).length
  while (encodedLength() > maxChars) {
    const candidates = buckets.filter(bucket => Array.isArray(copy[bucket]) && copy[bucket].length)
      .map(bucket => ({ bucket, size: JSON.stringify(copy[bucket][0]).length }))
      .sort((a, b) => b.size - a.size)
    if (candidates.length) { copy[candidates[0].bucket].shift(); continue }
    const sessionCache = Object.values(copy.sessions || {}).find(cache => Array.isArray(cache?.recent) && cache.recent.length)
    if (sessionCache) { sessionCache.recent.shift(); continue }
    if (copy.sessions && Object.keys(copy.sessions).length) { copy.sessions = {}; continue }
    break
  }
  let content = JSON.stringify(payload, null, 2)
  if (content.length > maxChars) content = JSON.stringify({ exportedAt: payload.exportedAt, truncated: true, data: { version: copy.version } }, null, 2)
  return { content, fullChars: full.length, truncated: true }
}

async function consolidateExpired(sessionId = '', options = {}) {
  await load()
  if (!sessionId) return { movedToEpisodeCandidates: 0, rawPreserved: true, isolated: true, reason: 'session-bound consolidation required', status: status() }
  const ageDays = Number.isFinite(Number(options.ageDays)) ? clamp(options.ageDays, 0, 365) : null
  const cutMs = ageDays === null ? state.data.settings.sevenDayMs : ageDays * DAY
  const cutoff = Date.now() - cutMs
  const dryRun = options.dryRun === true
  const moved = []
  let changed = false
  for (const row of state.data.raw.filter(x => !x.consolidatedAt && new Date(x.at).getTime() < cutoff && rowBelongsToSession(x, sessionId))) {
    if (row.role === 'user') {
      const text = `过往对话摘要：${clean(row.text, 240)}`
      if (!state.data.episodes.some(x => x.text === text && rowBelongsToSession(x, sessionId))) {
        if (dryRun) moved.push({ text })
        else {
          // 摘要也带上当时的心情：这样以后回想起来能知道「那会儿是什么状态」。
          const moodAtRow = moodSnapshot(sessionId)
          moved.push(add('episodes', { text, confidence: 0.45, source: 'seven-day-consolidation', anchor: row.anchor, ...(moodAtRow ? { mood: { ...moodAtRow, at: row.at } } : {}) }))
        }
      }
    }
    if (!dryRun) { row.consolidatedAt = now(); changed = true }
  }
  if (changed) await save()
  // 整理时顺手补齐编年史：把「这几天做过什么」写成按天的日记。
  const chronicleAdded = dryRun ? 0 : rebuildChronicle(sessionId, 14)
  // 被判成「永久」的原话升级成事实，别让它随时间沉底。
  const permanentPromoted = dryRun ? 0 : promotePermanentMemories(sessionId)
  if (chronicleAdded || permanentPromoted) await save()
  return { movedToEpisodeCandidates: moved.length, chronicleUpdatedDays: chronicleAdded, permanentPromoted, dryRun, ageDays: ageDays === null ? state.data.settings.sevenDayMs / DAY : ageDays, rawPreserved: true, isolated: true, status: status(sessionId) }
}

function makeDefinition(name, description, properties, required = [], sessionSource) {
  const bound = typeof sessionSource === 'function' ? sessionSource : () => String(sessionSource || '')
  return { name, description, parameters: { type: 'object', properties, required, additionalProperties: false }, output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, isConcurrencySafe: () => false, async execute(args, exec) { await load(); const caller = exec?.agent?.id ? String(exec.agent.id) : ''; return run(name, argsOf(args), caller || bound()) } }
}
function makeTools(sessionSource) {
  return [
    makeDefinition('silicon_life_recall', 'Search memory belonging to the current conversation only. Assistant replies are skipped unless includeAssistant=true. Use sinceDays / untilDays to narrow a time window (sinceDays=7 → last week; sinceDays=30&untilDays=7 → the week before last).', { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 }, includeAssistant: { type: 'boolean', default: false }, sinceDays: { type: 'number', minimum: 0, maximum: 3650 }, untilDays: { type: 'number', minimum: 0, maximum: 3650 } }, [], sessionSource),
    makeDefinition('silicon_life_remember', 'Save a user-approved memory item for the current conversation.', { kind: { type: 'string', enum: validBuckets.map(x => ({ facts: 'fact', profile: 'profile', episodes: 'episode', diary: 'diary', thoughts: 'thought', purposes: 'purpose' })[x]) }, text: { type: 'string', maxLength: 1200 }, confidence: { type: 'number', minimum: 0, maximum: 1 }, source: { type: 'string', maxLength: 100 } }, ['kind', 'text'], sessionSource),
    makeDefinition('silicon_life_mood', 'Read or update the simulated mood vector for the current conversation.', { emotion: { type: 'string', maxLength: 60 }, valence: { type: 'number', minimum: -1, maximum: 1 }, arousal: { type: 'number', minimum: -1, maximum: 1 }, note: { type: 'string', maxLength: 240 } }, [], sessionSource),
    makeDefinition('silicon_life_status', 'Inspect high-level memory counts, mood, personality parameters, and memory settings.', {}, [], sessionSource),
    makeDefinition('silicon_life_play', 'Play a tiny game or draw a fortune in the current conversation: guess a number, rock-paper-scissors, dice, coin, daily fortune. Game state stays inside this conversation; nothing is written to memory.', { action: { type: 'string', enum: ['guess-start', 'guess', 'rps', 'roll', 'coin', 'fortune', 'status'] }, number: { type: 'integer', minimum: 1, maximum: 100 }, choice: { type: 'string', enum: ['rock', 'paper', 'scissors'] }, sides: { type: 'integer', minimum: 2, maximum: 100 } }, ['action'], sessionSource),
    makeDefinition('silicon_life_joke', 'Manage user-approved inside jokes for the current conversation only. Saving requires confirm="记住"; ordinary chat never saves automatically.', { action: { type: 'string', enum: ['save', 'list', 'delete'] }, text: { type: 'string', maxLength: 240 }, id: { type: 'string', maxLength: 80 }, confirm: { type: 'string', enum: ['记住'] } }, ['action'], sessionSource),
    makeDefinition('silicon_life_trend', 'Keep sticker picking current: record or check fresh meme keywords you found on the web. Terms expire after 14 days and are only used as extra search hints.', { action: { type: 'string', enum: ['add', 'list', 'clear'] }, term: { type: 'string', maxLength: 40 }, source: { type: 'string', maxLength: 60 } }, ['action'], sessionSource),
    makeDefinition('silicon_life_consolidate', 'Consolidate memory without deleting the raw source. Pass dryRun=true to preview, ageDays to override the 7-day threshold for this call only.', { dryRun: { type: 'boolean', default: false }, ageDays: { type: 'number', minimum: 0, maximum: 365 } }, [], sessionSource),
    makeDefinition('silicon_life_configure', 'Update bounded memory, persona, personality and mood settings. Persona starts blank; only what the user fills in is injected. Cross-conversation recall permission remains user-controlled in Companion settings.', { enabled: { type: 'boolean' }, activeThinking: { type: 'boolean' }, injectionChars: { type: 'integer', minimum: 500, maximum: 12000 }, sevenDayDays: { type: 'number', minimum: 1, maximum: 90 }, warmth: { type: 'number', minimum: 0, maximum: 100 }, curiosity: { type: 'number', minimum: 0, maximum: 100 }, pragmatism: { type: 'number', minimum: 0, maximum: 100 }, traits: { type: 'string', maxLength: 2000 }, personaName: { type: 'string', maxLength: 80 }, personaDescription: { type: 'string', maxLength: 2000 }, personaUserAddress: { type: 'string', maxLength: 80 }, personaLikes: { type: 'string', maxLength: 600 }, personaDislikes: { type: 'string', maxLength: 600 }, personaValues: { type: 'string', maxLength: 2000 }, personaVoice: { type: 'string', maxLength: 2000 }, personaSamples: { type: 'string', maxLength: 2000 }, personaPrompt: { type: 'string', maxLength: 4000 }, moodDecayHours: { type: 'number', minimum: 1, maximum: 720 }, stickerFrequency: { type: 'string', enum: ['off', 'rare', 'normal', 'often'] } }, [], sessionSource),
    makeDefinition('silicon_life_export', 'Export a bounded JSON snapshot of memory for inspection or backup.', { maxChars: { type: 'integer', minimum: 1000, maximum: 50000, default: 20000 } }, [], sessionSource),
    makeDefinition('silicon_life_clear', 'Clear selected memory layers. Destructive: requires confirm exactly equal to CLEAR.', { confirm: { type: 'string' }, buckets: { type: 'array', items: { type: 'string', enum: ['raw', ...validBuckets, 'moods', 'sessions'] } } }, ['confirm'], sessionSource),
    makeDefinition('feiyu_journal_write', '她自己的念头本/日记本。有「记一笔的冲动」时，把这一刻写进去：kind=thought 写一行念头（一句话），kind=diary 往今天的日记里加一小段。写下来这件事本身就会让心情松一点。', { kind: { type: 'string', enum: ['thought', 'diary'] }, text: { type: 'string', maxLength: 800 } }, ['kind', 'text'], sessionSource),
    makeDefinition('silicon_life_self_test', 'Run local non-destructive checks for persistence shape, noise filtering, bounded injection, and isolation.', {}, [], sessionSource)
  ]
}
async function run(name, x, sessionId = '') {
  if (name === 'silicon_life_status') return result(status(sessionId))
  if (name === 'silicon_life_configure') {
    if (!sessionId) return result({ error: 'session-bound tool context is required' })
    const s = state.data.settings
    if (typeof x.enabled === 'boolean') s.enabled = x.enabled
    if (typeof x.activeThinking === 'boolean') s.activeThinking = x.activeThinking
    if (['off', 'rare', 'normal', 'often'].includes(String(x.stickerFrequency))) s.stickerFrequency = String(x.stickerFrequency)
    if (isNumeric(x.injectionChars)) s.injectionChars = clamp(x.injectionChars, 500, 12000)
    if (isNumeric(x.sevenDayDays)) s.sevenDayMs = clamp(x.sevenDayDays, 1, 90) * DAY
    for (const key of ['warmth', 'curiosity', 'pragmatism']) if (isNumeric(x[key])) state.data.personality[key] = clamp(x[key], 0, 100)
    if (typeof x.traits === 'string') state.data.personality.traits = clean(x.traits, 2000)
    if (typeof x.personaName === 'string') state.data.persona.name = clean(x.personaName, 80)
    if (typeof x.personaDescription === 'string') state.data.persona.description = clean(x.personaDescription, 2000)
    if (typeof x.personaUserAddress === 'string') state.data.persona.userAddress = clean(x.personaUserAddress, 80)
    if (typeof x.personaLikes === 'string') state.data.persona.likes = clean(x.personaLikes, 600)
    if (typeof x.personaDislikes === 'string') state.data.persona.dislikes = clean(x.personaDislikes, 600)
    if (typeof x.personaValues === 'string') state.data.persona.values = clean(x.personaValues, 2000)
    if (typeof x.personaVoice === 'string') state.data.persona.voice = clean(x.personaVoice, 2000)
    if (typeof x.personaSamples === 'string') state.data.persona.samples = clean(x.personaSamples, 2000)
    if (typeof x.personaPrompt === 'string') state.data.persona.systemPrompt = clean(x.personaPrompt, 4000)
    if (isNumeric(x.moodDecayHours)) state.data.moodSettings.decayHours = clamp(x.moodDecayHours, 1, 720)
    await save()
    try { runtime.syncMoodTraits?.() } catch { /* 心情插件不在就算了 */ }
    return result({ settings: state.data.settings, persona: state.data.persona, personality: state.data.personality, moodSettings: state.data.moodSettings })
  }
  if (name === 'silicon_life_export') {
    if (!sessionId) return result({ error: 'session-bound tool context is required' })
    const archive = sessionRows(state.data.raw, sessionId)
    const data = { version: state.data.version, archive, raw: archive, facts: sessionRows(state.data.facts, sessionId), profile: sessionRows(state.data.profile, sessionId), episodes: sessionRows(state.data.episodes, sessionId), diary: sessionRows(state.data.diary, sessionId), thoughts: sessionRows(state.data.thoughts, sessionId), purposes: sessionRows(state.data.purposes, sessionId), moods: sessionRows(state.data.moods, sessionId), sessions: state.data.sessions[sessionId] ? { [sessionId]: state.data.sessions[sessionId] } : {}, persona: state.data.persona, personality: state.data.personality, moodSettings: state.data.moodSettings, thresholds: state.data.thresholds, settings: state.data.settings }
    const maxChars = clamp(x.maxChars || 20000, 1000, 50000)
    return result({ format: 'json', isolated: true, ...boundedExport(data, maxChars) })
  }
  if (name === 'silicon_life_clear') {
    if (x.confirm !== 'CLEAR') return result({ error: 'Destructive action refused. Pass confirm="CLEAR" explicitly.' })
    if (!sessionId) return result({ error: 'session-bound tool context is required' })
    const allowed = ['raw', ...validBuckets, 'moods', 'sessions']
    const buckets = Array.isArray(x.buckets) ? [...new Set(x.buckets.filter(k => allowed.includes(k)))] : []
    if (!buckets.length) return result({ error: 'Select one or more buckets; no implicit full wipe.' })
    if (buckets.includes('raw')) return result({ error: 'archive/raw is immutable through this tool; use a separate explicit offline retention workflow' })
    for (const bucket of buckets) {
      if (bucket === 'sessions') delete state.data.sessions[sessionId]
      else state.data[bucket] = state.data[bucket].filter(row => !rowBelongsToSession(row, sessionId))
    }
    await save()
    return result({ cleared: buckets, isolated: true, sessionId, status: status(sessionId) })
  }
  if (name === 'silicon_life_self_test') {
    const checks = {
      schemaVersion: state.data.version === 4,
      archiveAliasReadOnly: Array.isArray(state.data.raw) && status(sessionId).counts.archive === (sessionId ? sessionRows(state.data.raw, sessionId).length : state.data.raw.length),
      personaShape: ['name', 'description', 'userAddress', 'likes', 'dislikes', 'values', 'voice', 'samples', 'systemPrompt'].every(key => typeof state.data.persona?.[key] === 'string') && typeof state.data.personality?.traits === 'string',
      likesBlankByDefault: DEFAULT_PERSONA.likes === '' && DEFAULT_PERSONA.dislikes === '',
      stageAndMoodWired: (() => {
        const rank = { 初识: 0, 熟了: 1, 亲近: 2, 自家人: 3 }
        const sid = 'self-test-stage'
        const savedJokes = state.data.insideJokes?.[sid]
        const early = rank[relationshipStage(sid).stage] ?? 0
        state.data.insideJokes = { ...(state.data.insideJokes || {}), [sid]: [{ id: 'x', text: '梗', at: now() }] }
        const withJoke = rank[relationshipStage(sid).stage] ?? 0
        delete state.data.insideJokes[sid]
        if (savedJokes) state.data.insideJokes[sid] = savedJokes
        return (withJoke > early || early >= 1) && typeof moodStyleLine(sid) === 'string'
      })(),
      trendToolWired: (() => {
        const added = trendTool({ action: 'add', term: '自检热词', source: 'self-test' })
        const listed = trendTool({ action: 'list' })
        const cleared = trendTool({ action: 'clear', term: '自检热词' })
        return added.added === true && listed.trends.some(row => row.term === '自检热词') && cleared.remaining >= 0
      })(),
      stickerHintRenderable: (() => {
        const sid = 'self-test-sticker'
        const saved = state.data.stickerHints?.[sid]
        state.data.stickerHints = { ...(state.data.stickerHints || {}), [sid]: { id: 'x', name: '测试表情', emotion: '开心', use: '被夸时', url: 'http://x/y.gif', file: 'C:/y.gif', at: now() } }
        const line = stickerHintLine(sid)
        if (saved) state.data.stickerHints[sid] = saved
        else delete state.data.stickerHints[sid]
        return line.includes('![测试表情]') && line.includes('配一张') && line.includes('放末尾')
      })(),
      addressBlankByDefault: DEFAULT_PERSONA.userAddress === '',
      jokesNeedConsent: (() => {
        const sid = 'self-test-jokes'
        const refused = jokeTool(sid, { action: 'save', text: '测试梗' })
        const saved = jokeTool(sid, { action: 'save', text: '测试梗', confirm: '记住' })
        const dup = jokeTool(sid, { action: 'save', text: '测试梗', confirm: '记住' })
        const listed = jokeTool(sid, { action: 'list' })
        const deleted = jokeTool(sid, { action: 'delete', id: saved.item.id })
        delete state.data.insideJokes[sid]
        return Boolean(refused.error) && saved.saved === true && dup.duplicate === true && listed.jokes.length === 1 && deleted.deleted === true
      })(),
      blankPersonaDefaults: DEFAULT_PERSONA.name === '' && DEFAULT_PERSONA.values === '' && DEFAULT_PERSONA.voice === '' && DEFAULT_PERSONALITY.traits === '' && DEFAULT_PERSONALITY.warmth === 50,
      personaValuesVoiceWired: (() => {
        const saved = { persona: { ...state.data.persona }, personality: { ...state.data.personality } }
        state.data.persona = { ...state.data.persona, name: '白纸测试', values: '诚实优先', voice: '短句、先结论' }
        const text = composeInjection(sessionId || 'self-test')
        state.data.persona = saved.persona
        state.data.personality = saved.personality
        return text.includes('我的三观：诚实优先') && text.includes('说话方式：短句、先结论')
      })(),
      qqPersonaTextWired: (() => {
        const saved = { persona: { ...state.data.persona }, personality: { ...state.data.personality } }
        state.data.persona = { ...state.data.persona, name: '同步测试', values: '不哄骗', voice: '说人话' }
        state.data.personality = { ...state.data.personality, traits: '安静' }
        const text = composePersonaText()
        state.data.persona = saved.persona
        state.data.personality = saved.personality
        return text.includes('三观：不哄骗') && text.includes('说话方式：说人话') && text.includes('性格：安静') && text.length <= 20000
      })(),
      playToolWired: (() => {
        const sid = 'self-test-play'
        const fortuneA = playTool(sid, { action: 'fortune' })
        const fortuneB = playTool(sid, { action: 'fortune' })
        const start = playTool(sid, { action: 'guess-start' })
        const target = state.data.games?.[sid]?.guess?.target
        const win = playTool(sid, { action: 'guess', number: target })
        const rps = playTool(sid, { action: 'rps', choice: 'rock' })
        delete state.data.games?.[sid]
        return fortuneA.text === fortuneB.text && start.started === true && win.win === true && ['win', 'lose', 'tie'].includes(rps.outcome)
      })(),
      relationshipWired: (() => {
        const line = relationshipLine('self-test-relation')
        return line.includes('现在是') && line.includes('今天聊了')
      })(),
      sevenEmotionTaxonomy: Array.isArray(state.data.moodSettings?.taxonomy) && state.data.moodSettings.taxonomy.length === 7,
      noiseFilter: [
        'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
        'This is an automatically generated checkpoint condensing an earlier span of the conversation.',
        '<compacted-summary> ## Primary Request and Intent',
        '[model changed: assistant turns above this point were generated by model-x]',
        '**Evaluating package compatibility** Check the package metadata.'
      ].every(isHarnessNoise),
      assistantExcluded: !isStorableConversation('assistant', 'private work draft') && isStorableConversation('user', '请记住这个偏好'),
      injectionBudget: Number.isFinite(state.data.settings.injectionChars) && state.data.settings.injectionChars >= 500,
      anchorsSupported: typeof sourceAnchor('test-session', 'self-test', now()).sessionId === 'string',
      storageLoaded: state.loaded,
      isolation: rowBelongsToSession({ anchor: { sessionId: 'a' } }, 'a') && !rowBelongsToSession({ anchor: { sessionId: 'a' } }, 'b'),
      crossSessionRecallUnavailable: !makeTools(() => '').find(tool => tool.name === 'silicon_life_recall')?.parameters?.properties?.crossSession,
      crossSessionConfigureUnavailable: !makeTools(() => '').find(tool => tool.name === 'silicon_life_configure')?.parameters?.properties?.crossSessionRecall,
      crossSessionFlagRemoved: !Object.hasOwn(state.data.settings, 'crossSessionRecall'),
      linkIsOptIn: linkedSessionIds(sessionId).length === (Array.isArray(state.data.sessions?.[sessionId]?.readsFrom) ? state.data.sessions[sessionId].readsFrom.filter(id => id && id !== sessionId).length : 0),
      perSessionCapSane: PER_SESSION_CAP.raw > 0 && PER_SESSION_CAP.raw <= LIMITS.raw && PER_SESSION_CAP.moods <= LIMITS.moods,
      perSessionTrim: (() => {
        const rows = [1, 2, 3, 4, 5].map(n => ({ text: `a${n}`, anchor: { sessionId: 'a' } })).concat([{ text: 'b1', anchor: { sessionId: 'b' } }])
        const out = trimRowsToSessionCap(rows, 'a', 3)
        return out.length === 4 && out.filter(row => row.anchor.sessionId === 'a').length === 3 && out.some(row => row.anchor.sessionId === 'b')
      })(),
      // 编年史为「我自己的经历」：按天一条、带会话锚点，日志里不混别的会话。
      chronicleShape: state.data.diary.every(item => Boolean(item?.day) && typeof item.text === 'string' && Boolean(item.anchor?.sessionId) && item.anchor.sessionId !== 'chronicle'),
      chronicleIsScoped: (() => {
        const sample = state.data.diary[0]
        if (!sample) return true
        return buildDayDigest(sample.day, String(sample.anchor.sessionId)).length >= 0
      })(),
      // 四层记忆模型：分数高→永久，时间推着走；纯应答不该被当重要记忆。
      tierModelWired: Object.keys(TIER_LABEL).length === 4 && TIER_LABEL.permanent === '永久',
      importanceOrdering: scoreImportance('记住：以后都要先给结论', {}) > scoreImportance('继续', {}) &&
        scoreImportance('我养了一只猫', {}) > scoreImportance('继续', {}),
      tierTimeDecay: classifyTier(0.2, 60 * 1000, state.data.settings.sevenDayMs) === 'instant' &&
        classifyTier(0.2, 2 * 3600000, state.data.settings.sevenDayMs) === 'short' &&
        classifyTier(0.95, 90 * 86400000, state.data.settings.sevenDayMs) === 'permanent',
      toolSessionBinding: typeof sessionId === 'string' && sessionId.length > 0
    }
    return result({ passed: Object.values(checks).every(Boolean), checks, sessionId: sessionId || null, counts: counts() })
  }
  if (name === 'silicon_life_recall') {
    if (!sessionId) return result({ matches: [], isolated: true, reason: 'session-bound tool context is required' })
    const query = clean(x.query, 200)
    // 用户自己写的记忆插件里的事实也参与召回（明确标源，便于区分是不是本插件记的）。
    const upstream = readUpstreamMemory()
    const upstreamRows = upstream.detected
      ? upstream.facts.map((text, index) => ({ id: `upstream-${index}`, text, at: null, bucket: 'persistent-memory', source: 'persistent-memory', shared: true }))
      : []
    const fish = readFishMemory(sessionId)
    const fishTexts = new Set(fish.memories.map(memory => clean(memory.text, 900)))
    const pool = [
      ...sessionRows(state.data.raw, sessionId).filter(item => item.role === 'user').map(item => ({ ...item, bucket: 'archive' })),
      // 鱼记忆的镜像条目由下面的 fish 行统一给，这里排掉，免得同一句话出现两次（只是来源标注不同）。
      ...validBuckets.flatMap(bucket => sessionRows(state.data[bucket], sessionId)
        .filter(item => !(item.source === 'fish-memory' && fishTexts.has(clean(item.text, 900))))
        .map(item => ({ ...item, bucket }))),
      // 只有被显式绑定为主记忆的会话，才把它的长期记忆并进来（原话仍然不共享）。
      ...linkedMemoryRows(sessionId),
      ...upstreamRows,
      // 鱼记忆里这个会话的条目（本插件自己另记过的同句就不重复给）。
      ...fish.memories
        .filter(memory => !state.data.facts.some(item => item.source !== 'fish-memory' && rowBelongsToSession(item, sessionId) && clean(item.text, 900) === clean(memory.text, 900)))
        .map((memory, index) => ({ id: `fish-${index}`, text: memory.text, at: memory.at, category: memory.category, importance: memory.importance, tags: memory.tags, bucket: 'fish-memory', source: 'fish-memory' }))
    ].filter(item => item.source !== 'user-message' && !isHarnessNoise(item.text) && (x.includeAssistant === true || item.role !== 'assistant'))
    // 时间窗：sinceDays=过去几天内；untilDays=至少几天前。没写就是全部。
    const windowed = (() => {
      const sinceDays = Number(x.sinceDays)
      const untilDays = Number(x.untilDays)
      const hasSince = Number.isFinite(sinceDays) && x.sinceDays !== undefined
      const hasUntil = Number.isFinite(untilDays) && x.untilDays !== undefined
      if (!hasSince && !hasUntil) return pool
      const nowMs = Date.now()
      return pool.filter(item => {
        const at = new Date(item.at || 0).getTime()
        if (!Number.isFinite(at) || at <= 0) return false
        const age = nowMs - at
        if (hasSince && age > sinceDays * 86400000) return false
        if (hasUntil && age < untilDays * 86400000) return false
        return true
      })
    })()
    // 实体硬条件：查询里的英文/数字片段必须整体出现（BV号这类不能只看半边）。
    const entities = entityTokens(query)
    const gated = entities.length
      ? windowed.filter(item => { const haystack = String(item.text || '').toLowerCase(); return entities.every(token => haystack.includes(token)) })
      : windowed
    const ranked = bm25Rank(query, gated.map(item => ({ item })))
      // 带情绪的旧事更容易被想起：|效价| 越高权重越大（最多 +30%），但压不过关键词本身。
      .map(entry => {
        const valence = Number(entry.doc.item?.mood?.valence)
        const weight = Number.isFinite(valence) ? 1 + Math.min(0.3, Math.abs(valence) * 0.3) : 1
        return { ...entry, score: entry.score * weight }
      })
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score || new Date(b.doc.item.at) - new Date(a.doc.item.at))
    // 线索门控：明显弱于第一名的结果不端上来，免得「什么都能召回一点」。
    const top = ranked[0]?.score || 0
    const rows = ranked
      .filter(entry => entry.score >= top * 0.15)
      .slice(0, clamp(x.limit || 8, 1, 20))
      .map(entry => ({ ...entry.doc.item, score: Number(entry.score.toFixed(3)) }))
    // 想起旧事会改此刻的心情：把最相关那条记忆的情绪递给心情插件（同一条每天只算一次）。
    try {
      const mv2 = (typeof runtime.getMoodV2 === 'function' ? runtime.getMoodV2() : null) || runtime.moodV2
      const withMood = rows.find(item => item.mood && typeof item.mood.valence === 'number')
      if (mv2 && typeof mv2.recollect === 'function' && withMood) {
        mv2.recollect({ text: withMood.text, valence: withMood.mood.valence })
      }
    } catch { /* 心情插件不在就算了，召回本身不受影响 */ }
    return result({ matches: rows, isolated: true, sessionId, ranked: 'bm25', entities, considered: pool.length })
  }
  if (name === 'feiyu_journal_write') {
    const kind = x.kind === 'diary' ? 'diary' : 'thought'
    const body = clean(x.text, 800)
    if (!body) return result({ error: 'text is required' })
    const dir = join(homedir(), '.dsh', 'feiyu-journal')
    const day = new Date().toISOString().slice(0, 10)
    try {
      await mkdir(dir, { recursive: true })
      if (kind === 'thought') {
        await appendFile(join(dir, 'thoughts.jsonl'), `${JSON.stringify({ ts: Date.now() / 1000, text: body, from: isQQSession(sessionId) ? 'qq' : 'dsh' })}\n`, 'utf8')
        return result({ saved: 'thought', file: join(dir, 'thoughts.jsonl') })
      }
      await mkdir(join(dir, 'diary'), { recursive: true })
      const file = join(dir, 'diary', `${day}.md`)
      await appendFile(file, `\n## ${new Date().toTimeString().slice(0, 5)}\n\n${body}\n`, 'utf8')
      return result({ saved: 'diary', file })
    } catch (error) {
      return result({ error: `写不进去：${error.message}` })
    }
  }
  if (name === 'silicon_life_remember') {
    const bucket = ({ fact: 'facts', profile: 'profile', episode: 'episodes', diary: 'diary', thought: 'thoughts', purpose: 'purposes' })[x.kind]
    if (!bucket || !clean(x.text)) return result({ error: 'kind and non-empty text are required' })
    if (!sessionId) return result({ error: 'session-bound tool context is required; memory was not saved' })
    const mood = moodSnapshot(sessionId)
    const item = add(bucket, { text: x.text, confidence: x.confidence, source: clean(x.source, 100) || 'agent-tool', anchor: sourceAnchor(sessionId, 'agent-tool', now()), ...(mood ? { mood } : {}) })
    await save()
    return result({ saved: bucket, item })
  }
  if (name === 'silicon_life_mood') {
    const feiyu = readFeiyuMood()
    const prior = (sessionId ? sessionRows(state.data.moods, sessionId).at(-1) : null) || { valence: 0, arousal: 0 }
    // 装了「鱼的心情」时心情归它管：这里只读不说，也不接受改写，避免两套心情打架。
    if (feiyu) {
      const view = { emotion: feiyu.label, score: Math.round(feiyu.score), reason: feiyu.reason, confidence: feiyu.confidence, at: feiyu.at, source: 'feiyu-mood' }
      if (x.emotion || x.note || x.valence !== undefined || x.arousal !== undefined) {
        return result({ mood: view, isolated: true, refused: true, reason: '心情由 dsh-feiyu-mood 管理；请在那里调整，本插件不再写入' })
      }
      return result({ mood: view, isolated: Boolean(sessionId) })
    }
    if (x.emotion || x.note || x.valence !== undefined || x.arousal !== undefined) {
      if (!sessionId) return result({ error: 'session-bound tool context is required; mood was not saved' })
      const requestedEmotion = clean(x.emotion, 60) || '平静'
      const emotion = state.data.moodSettings.taxonomy.includes(requestedEmotion) ? requestedEmotion : '平静'
      const note = clean(x.note, 240)
      const maxDelta = clamp(state.data.moodSettings.maxDelta, 0, 1)
      const valence = clamp(x.valence ?? prior.valence, Math.max(-1, (prior.valence || 0) - maxDelta), Math.min(1, (prior.valence || 0) + maxDelta))
      const arousal = clamp(x.arousal ?? prior.arousal, Math.max(-1, (prior.arousal || 0) - maxDelta), Math.min(1, (prior.arousal || 0) + maxDelta))
      const mood = add('moods', { text: note || emotion, emotion, category: emotion, valence, arousal, note, confidence: 0.65, source: 'agent-tool', anchor: sourceAnchor(sessionId, 'agent-tool', now()) })
      await save()
      return result({ mood, isolated: true })
    }
    return result({ mood: prior, isolated: Boolean(sessionId) })
  }
  if (name === 'silicon_life_play') {
    const played = playTool(sessionId, x)
    if (!played.error) await save()
    return result(played)
  }
  if (name === 'silicon_life_joke') {
    const done = jokeTool(sessionId, x)
    if (!done.error) await save()
    return result(done)
  }
  if (name === 'silicon_life_trend') {
    const done = trendTool(x)
    if (!done.error) await save()
    return result(done)
  }
  if (name === 'silicon_life_consolidate') return result(await consolidateExpired(sessionId, { dryRun: x.dryRun === true, ageDays: x.ageDays }))
  return result({ error: `unknown tool: ${name}` })
}

// agents 是必须的：插件重载后要靠它列出已存在的 Agent 才能补挂注入，
// 只依赖 agent/created 会让「重载前就开着的长会话」永远拿不到记忆。
export const inject = ['tools', 'systemPrompt', 'webServer', 'agents']
// 记忆星云面板：/silicon-life-companion/graph（页面）、/graph.json（数据）、/graph/rebuild（重算）。
// 数据由 build-graph.mjs 生成；页面在插件目录的 graph-page.html，改样式不用重启（每次请求现读）。
function 挂星云面板(webServer) {
  if (!webServer || typeof webServer.register !== 'function') return
  const 插件目录 = pathJoinDirname(fileURLToPath(import.meta.url))
  const 页面 = join(插件目录, 'graph-page.html')
  const 数据 = join(DATA_DIR, 'graph.json')
  const send = (res, code, type, body) => {
    try { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body) } catch {}
  }
  webServer.register({
    kind: 'exact',
    path: '/silicon-life-companion/graph',
    handler: (_req, res) => {
      if (!existsSync(页面)) return send(res, 404, 'text/plain; charset=utf-8', '缺 graph-page.html')
      send(res, 200, 'text/html; charset=utf-8', readFileSync(页面))
    },
  })
  webServer.register({
    kind: 'exact',
    path: '/silicon-life-companion/graph.json',
    handler: (_req, res) => {
      if (!existsSync(数据)) return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: false, 说: '还没算过，点 graph/rebuild 或用 node build-graph.mjs' }))
      send(res, 200, 'application/json; charset=utf-8', readFileSync(数据))
    },
  })
  webServer.register({
    kind: 'exact',
    path: '/silicon-life-companion/graph/rebuild',
    handler: (_req, res) => {
      try {
        const 脚本 = join(插件目录, 'build-graph.mjs')
        const 子 = spawn(process.execPath, [脚本], { cwd: 插件目录, stdio: 'pipe' })
        let 出 = ''
        子.stdout.on('data', (d) => { 出 += d })
        子.stderr.on('data', (d) => { 出 += d })
        子.on('close', (code) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: code === 0, 输出: 出.slice(-1200) })))
      } catch (e) { send(res, 500, 'application/json; charset=utf-8', JSON.stringify({ ok: false, 说: String(e && e.message) })) }
    },
  })
}

export function apply(ctx) {
  void load()
  // webServer 可选：没有就只当普通记忆插件用
  try {
    const ws = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer
  } catch (e) { console.error('[companion-memory] 面板没挂上：', e && e.message) }
  // 表情包服务是可选依赖：没装 sticker 插件时这里的每一条路径都必须安静地跳过。
  runtime.stickers = (() => { try { return typeof ctx.get === 'function' ? ctx.get('stickers') || null : null } catch { return null } })()
  // nekowhale-meme 的库（用户导入 + 打过标签的图）优先；它只读、不发图，发不发由我们自己决定。
  // 心情交给 dsh-mood-v2 时，这里不再重复（两边各说一套只会互相打架）。
  runtime.moodV2 = (() => { try { return typeof ctx.get === 'function' ? ctx.get('moodV2') || null : null } catch { return null } })()
  // 加载顺序不保证：留一个现取的入口，composeInjection 每次都会再问一遍。
  runtime.getMoodV2 = () => { try { return typeof ctx.get === 'function' ? ctx.get('moodV2') || null : null } catch { return null } }
  // 性格 → 心情：把人格设定里的性格词交给心情插件当基线（傲娇→爱装、情绪化→起伏大、心软→更容易想被哄）
  const syncMoodTraits = () => {
    try {
      const mv2 = runtime.getMoodV2()
      if (!mv2 || typeof mv2.tune !== 'function') return null
      const parts = [state.data.personality?.traits, state.data.persona?.voice, state.data.persona?.systemPrompt]
        .filter(Boolean).map(text => clean(text, 600)).join(' ')
const stage = relationshipStage('')
      const stageKind = String(stage?.stage || '')
      const longTerm = /熟|亲|黏|热/.test(stageKind) ? { valence: 0.12, comfort: 0.1 } : /刚|陌生|生/.test(stageKind) ? { valence: -0.06, comfort: -0.04 } : { valence: 0, comfort: 0 }
      return mv2.tune({ traits: parts, longTerm })
    } catch { return null }
  }
  runtime.syncMoodTraits = syncMoodTraits
  setTimeout(() => { void load().then(syncMoodTraits) }, 1200)
  runtime.meme = (() => { try { return typeof ctx.get === 'function' ? ctx.get('nekowhaleMeme') || null : null } catch { return null } })()
  const lastAt0 = state.data.stickerRefresh?.at ? new Date(state.data.stickerRefresh.at).getTime() : 0
  if (runtime.meme && Date.now() - lastAt0 > DAY / 2) {
    const timer0 = setTimeout(() => { void refreshStickerLibrary({ deep: false }) }, 3000)
    if (typeof timer0.unref === 'function') timer0.unref()
    ctx.effect(() => () => clearTimeout(timer0))
  }
  // QQ 那一路不能等我被叫醒才开始挑图：加载时先给绑定的会话备一张，它一说话就能用。
  const warmTimer = setTimeout(() => {
    for (const sid of qqSessionIds()) {
      void refreshStickerHint(sid).then(hint => { if (hint) void save() }).catch(() => {})
    }
  }, 1500)
  if (typeof warmTimer.unref === 'function') warmTimer.unref()
  ctx.effect(() => () => clearTimeout(warmTimer))
  // 每天自动联网看一眼图库有没有更新（只拉清单，不下载整套图）；失败就算了，不影响对话。
  if (runtime.stickers) {
    const lastAt = state.data.stickerRefresh?.at ? new Date(state.data.stickerRefresh.at).getTime() : 0
    if (Date.now() - lastAt > DAY) {
      const timer = setTimeout(() => { void refreshStickerLibrary({ deep: false }) }, 5000)
      if (typeof timer.unref === 'function') timer.unref()
      ctx.effect(() => () => clearTimeout(timer))
    }
  }
  // ── 模型润色：把抽取式的月记/年表改写成一句像人写的回忆 ──
  // 失败一律回退到抽取式（记忆不能因为没有模型就丢）。
  const currentCallConfig = sessionId => {
    const read = agent => {
      try {
        const config = agent?.session?.requestHeader?.()?.config
        if (config?.provider && config?.model) return { provider: config.provider, model: config.model }
      } catch {}
      return null
    }
    // 1) 指定的会话  2) 当前发起链  3) 任何一个存活 Agent  4) 上次成功用过的（HTTP 调用没有发起链时靠它）
    const candidates = []
    try { if (sessionId) candidates.push(ctx.agents?.get?.(sessionId)) } catch {}
    try { candidates.push(ctx.agents?.currentInitiator?.()) } catch {}
    try { candidates.push(...(ctx.agents?.list?.() || [])) } catch {}
    for (const agent of candidates) {
      const config = read(agent)
      if (config) {
        runtime.lastModelConfig = config
        // 记到磁盘上：插件重载/HTTP 调用没有发起链时也有模型可用。
        if (state.data.lastModelConfig?.provider !== config.provider || state.data.lastModelConfig?.model !== config.model) {
          state.data.lastModelConfig = config
          void save()
        }
        return config
      }
    }
    const persisted = state.data.lastModelConfig
    if (persisted?.provider && persisted?.model) return { provider: persisted.provider, model: persisted.model }
    return runtime.lastModelConfig || null
  }
  // 每天最多花多少次模型调用：防止整理失控时把预算烧光（默认 40 次/天）。
  // （dailyCap/usageToday/spendCall 定义在模块层，status() 也要用。）
  const modelText = async (prompt, sessionId, timeoutMs = 25000, maxTokens = 2000) => {
    const llm = (() => { try { return ctx.get?.('llm') ?? ctx.llm } catch { return null } })()
    if (!llm?.stream) return null
    const config = currentCallConfig(sessionId)
    if (!config) return null
    const cap = dailyCap()
    if (usageToday().calls >= cap) {
      runtime.lastSummaryError = `daily-cap:${cap}`
      return null
    }
    const once = async budget => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let out = ''
      let ranOut = false
      if (spendCall() > cap) {
        clearTimeout(timer)
        runtime.lastSummaryError = `daily-cap:${cap}`
        return { text: '', ranOut: false }
      }
      try {
        for await (const chunk of llm.stream({
          provider: config.provider,
          model: config.model,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          maxTokens: budget,
          temperature: 0.6,
          signal: controller.signal
        })) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
          if (chunk?.type === 'finish' && chunk.reason?.kind !== 'stop' && chunk.reason?.kind !== 'tool-calls') {
            // 达到 max-tokens 但已经写出内容 → 当成功用（推理模型常见）。
            if (chunk.reason?.kind === 'max-tokens' && out.trim()) break
            ranOut = chunk.reason?.kind === 'max-tokens'
            runtime.lastSummaryError = `finish:${chunk.reason?.kind || 'unknown'}:${chunk.reason?.failure?.message || ''}`
            return { text: out.trim(), ranOut }
          }
        }
      } catch (error) {
        runtime.lastSummaryError = String(error?.message || error)
        return { text: '', ranOut: false }
      } finally {
        clearTimeout(timer)
      }
      return { text: out.trim(), ranOut }
    }
    let attempt = await once(maxTokens)
    // 推理把预算吃光、一个字都没写出来的情况：抬高预算重试一次（只重试一次，成本可控）。
    if (!attempt.text && attempt.ranOut && maxTokens < 6000) attempt = await once(Math.min(maxTokens * 3, 6000))
    if (!attempt.text) return null
    runtime.lastSummaryRaw = attempt.text.slice(0, 300)
    return attempt.text
  }
  // 润色「日记/月记/年表」：底稿没变就不重复花钱；日记只在被标记过期时才重写。
  const refineRollups = async (sessionId = '', options = {}) => {
    if (!sessionId) return 0
    if (state.data.settings.modelSummary === false) return 0
    let refined = 0
    const targets = []
    // 日记：只挑「模型写过、但底稿变过」的那条，最多一条，免得一轮把整天都重算。
    const staleDay = sessionRows(state.data.diary, sessionId)
      .filter(item => isDayRow(item) && item.source === 'model-summary' && item.stale === true)
      .sort((a, b) => String(b.day).localeCompare(String(a.day)))[0]
    if (staleDay) targets.push({ kind: 'day', row: staleDay, maxChars: 70 })
    for (const kind of ['month', 'year']) {
      const row = recentRollup(sessionId, kind)
      if (row) targets.push({ kind, row, maxChars: kind === 'year' ? 90 : 70 })
    }
    for (const { kind, row, maxChars } of targets) {
      if (!row) continue
      const source = String(row.extractiveText || row.text || '')
      if (!source) continue
      const inputsHash = hashInputs(source)
      if (row.inputsHash === inputsHash && row.source === 'model-summary' && row.stale !== true) continue
      if (options.maxOne === true && refined >= 1) break
      const persona = [state.data.persona?.name, state.data.personality?.traits].filter(Boolean).join('，')
      const prompt = buildRollupPrompt({ period: row.day, kind, text: source, persona })
      const raw = await modelText(prompt, sessionId)
      if (!raw) continue
      const cleaned = cleanSummary(raw, { maxChars })
      if (!shouldAcceptSummary(cleaned, source)) continue
      row.extractiveText = source
      row.text = cleaned
      row.source = 'model-summary'
      row.inputsHash = inputsHash
      row.stale = false
      row.summaryAt = now()
      row.updatedAt = now()
      // 这次成功了，就把上一次的失败痕迹清掉，免得状态里一直挂着旧错误。
      runtime.lastSummaryError = null
      refined += 1
    }
    // 线索：日记内容变了才重新问一次模型；解析不出来就保留上一条，不乱写。
    const threadsChanged = await refreshThreadsWithModel(sessionId)
    if (refined || threadsChanged) await save()
    return refined
  }
  const refreshThreadsWithModel = async sessionId => {
    if (!sessionId) return 0
    if (state.data.settings.modelSummary === false) return 0
    const days = recentDiaryDays(sessionId)
    if (days.length < 2) return 0
    const signature = threadsSignature(days)
    if (state.data.threads?.[sessionId]?.signature === signature) return 0
    // 同一份日记失败过就不再反复花钱，等日记内容变了再说。
    if (state.data.threadsFailed?.[sessionId] === signature) return 0
    const raw = await modelText(buildThreadsPrompt(days), sessionId, 40000, 2500)
    const items = raw ? parseThreads(raw, days) : []
    if (!items.length) {
      state.data.threadsFailed = { ...(state.data.threadsFailed || {}), [sessionId]: signature }
      return 0
    }
    delete state.data.threadsFailed?.[sessionId]
    state.data.threads = { ...(state.data.threads || {}), [sessionId]: { updatedAt: now(), signature, v: 4, items } }
    return 1
  }
  // 一条摘要值不值得占一个名额：太短、太空、跟原文几乎一样的，都不算。
  // 每天 40 次只是上限，不该把“聊了会儿天”这种也记成一件大事。
  const summaryWorthKeeping = (cleaned, source) => {
    const text = String(cleaned || '').trim()
    if (text.length < 10) return { ok: false, why: '太短' }
    const generic = /^(聊了|说了|讨论了|沟通了)(一些|会儿|几句)/.test(text) && text.length < 30
    if (generic) return { ok: false, why: '太空' }
    // 和原文重合度过高 = 没压缩，等于白花一次调用
    const a = new Set(tokenize(text))
    const b = new Set(tokenize(String(source || '')))
    if (a.size && b.size) {
      let hit = 0
      for (const x of a) if (b.has(x)) hit += 1
      // 只有「几乎原样搬过来、长度也没缩短」才算没压缩；真压短了就算重复度高也认
      if (hit / a.size > 0.9 && text.length >= String(source || '').length * 0.8) return { ok: false, why: '没压缩' }
    }
    return { ok: true }
  }
  // 摘要名额满了：跟现有的比重要程度，比最不重要的那条更值得留就换掉它。
  const makeRoomForSummary = (bucket, incoming) => {
    const cap = LIMITS[bucket] || 60
    const rows = state.data[bucket] || []
    if (rows.length < cap) return true
    const rank = (row) => {
      const imp = Number.isFinite(Number(row?.importance)) ? Number(row.importance) : scoreImportance(String(row?.text || ''), {})
      const at = Date.parse(String(row?.at || '')) || 0
      const fresh = at ? Math.max(0, 5 - (Date.now() - at) / 86400000) : 0
      return imp * 100 + fresh + Math.min(10, Number(row?.useCount || 0) * 2)
    }
    let worst = -1
    let worstScore = Infinity
    rows.forEach((row, i) => {
      if (row?.source !== 'model-summary') return
      const s = rank(row)
      if (s < worstScore) { worstScore = s; worst = i }
    })
    if (worst < 0) return false
    if (worst < 0 || rank(incoming) <= worstScore) return false
    rows.splice(worst, 1)
    return true
  }
  const readBody = req => new Promise(resolve => { let raw = ''; req.on('data', chunk => { raw += chunk; if (raw.length > 65536) raw = raw.slice(0, 65536) }); req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } }); req.on('error', () => resolve({})) })
  const sendJson = (res, code, value) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
  const webDisposers = []
  const registerRoute = (path, handler) => { try { webDisposers.push(ctx.webServer.register({ kind: 'exact', path, handler })) } catch (error) { console.error('[silicon-life-companion] route failed:', error) } }
  registerRoute('/silicon-life-companion/state', async (_req, res) => { await load(); sendJson(res, 200, status()) })
  // ── 日记本 / 念头本 仪表页（自己加）──────────────────────────────────
  // 数据来源两处：feiyu-life/diary 里的 markdown + 插件状态里的 thoughts/diary。
  const fsSync = { readdirSync, readFileSync: readFileSync2, statSync }
  const journalRoot = join(homedir(), '.dsh', 'feiyu-life')
  const readJournal = () => {
    const out = { diaryFiles: [], diaryNotes: [], thoughts: [], purposes: [] }
    try {
      const dir = pathSync.join(journalRoot, 'diary')
      for (const name of fsSync.readdirSync(dir)) {
        if (!name.endsWith('.md')) continue
        const full = join(dir, name)
        const st = fsSync.statSync(full)
        out.diaryFiles.push({ date: name.replace(/\.md$/, ''), text: fsSync.readFileSync(full, 'utf8').trim(), at: st.mtime.toISOString() })
      }
      out.diaryFiles.sort((a, b) => (a.date < b.date ? 1 : -1))
    } catch (error) { /* 还没写过日记 */ }
    try {
      // 日记本只放「真日记」：模型润色过的那种第一人称手记。
      // daily-digest 是原材料（她的原话碎片），放这里会让人觉得日记全在记任务。
      out.diaryNotes = (state.data.diary || [])
        .filter((row) => row && (row.source === 'model-summary' || row.kind === 'note' || row.source === 'diary-note'))
        .slice(-50)
        .reverse()
    } catch (error) { /* 没加载 */ }
    try { out.thoughts = (state.data.thoughts || []).slice(-80).reverse() } catch (error) { /* 没加载 */ }
    try { out.purposes = (state.data.purposes || []).slice(-30).reverse() } catch (error) { /* 没加载 */ }
    return out
  }
  // 记忆星云：跟日记页同一套注册方式（ctx.webServer.register + exact），保证行为一致
  const 星云页 = join(pathJoinDirname(fileURLToPath(import.meta.url)), 'graph-page.html')
  const 星云数据 = join(DATA_DIR, 'graph.json')
  registerRoute('/silicon-life-companion/graph', (_req, res) => {
    try {
      if (!existsSync(星云页)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('缺 graph-page.html'); return }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(readFileSync(星云页))
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('星云页出错：' + (e && e.message))
    }
  })
  // LLM 抽三元组：用 DSH 自己配的模型（不需要另外申请 key），批量跑完写 triples.json，再重算图。
  registerRoute('/silicon-life-companion/graph/extract', async (req, res) => {
    try {
      await load()
      const 全部 = (state.data.facts || []).map((x) => String(x.text || '').trim()).filter((x) => x.length >= 6)
      const 参数 = new URL(String(req.url || ''), 'http://x').searchParams
      const 上限 = Math.max(1, Math.min(400, Number(参数.get('limit')) || 400))
      const 待抽 = 全部.slice(-上限)
      if (!待抽.length) return sendJson(res, 200, { ok: false, 说: '没有可抽的事实' })
      const 每批 = 12
      let 攒下 = []
      const 旧文件 = join(DATA_DIR, 'triples.json')
      try {
        if (existsSync(旧文件)) {
          const 旧 = JSON.parse(readFileSync(旧文件, 'utf8'))
          if (Array.isArray(旧)) 攒下 = 旧
        }
      } catch { /* 旧文件坏了就不要了 */ }
      // 抽取是「我手动点的一次动作」，不该被日记/threads 的每日预算卡死在 40 次上：
      // 临时把这轮的额度顶到 现有调用 + 批次上限，跑完恢复原值。
      const 原cap = state.data.settings.modelDailyCap
      const 已用 = usageToday().calls
      state.data.settings.modelDailyCap = Math.max(Number(原cap) || 40, 已用 + Math.ceil(待抽.length / 12) + 5)
      let 调用 = 0, 失败 = 0, 样例 = ''
      for (let i = 0; i < 待抽.length; i += 每批) {
        const 批 = 待抽.slice(i, i + 每批)
        const prompt = [
          '任务：把下面每条记忆里【明确】的事实抽成三元组。',
          '输出格式：一行一条，用竖线分隔，不要编号、不要解释、不要 markdown：',
          '主体|关系|客体',
          '示例：',
          '主人|B站账号|123456789',
          '大肥鱼|同事|小张',
          '大肥鱼|用|GPT-SoVITS',
          '规则：',
          '1) 主体、客体必须是记忆里出现的词，原样照抄，不要改写、不要补全',
          '2) 关系是 2-6 个字的短词，比如 是 / 叫 / 用 / 喜欢 / 住在 / 在 / 属于 / 负责',
          '3) 一条记忆最多 2 行；抽不出就跳过，宁缺毋滥，绝对不要编',
          '4) 只输出这些行，没有别的话',
          '记忆：',
          ...批.map((x, k) => `${k + 1}. ${x}`),
        ].join('\n')
        const raw = await modelText(prompt, undefined, 60000, 4000)
        调用++
        if (!样例) 样例 = String(raw || '(空)').slice(0, 400)
        if (!raw) { 失败++; continue }
        let 这批 = 0
        // ① 先试 JSON 数组（有些模型爱输出 JSON）
        const mj = raw.match(/\[[\s\S]*\]/)
        if (mj) {
          try {
            for (const tr of JSON.parse(mj[0])) {
              const s = String(tr.s || '').trim(), rel = String(tr.rel || '').trim(), tt = String(tr.t || '').trim()
              if (!s || !rel || !tt || s === tt) continue
              if (s.length > 12 || tt.length > 12 || rel.length > 8) continue
              攒下.push({ s, rel, t: tt }); 这批++
            }
          } catch { /* 落到行解析 */ }
        }
        // ② 行格式：主体|关系|客体
        if (!这批) {
          for (const line of raw.split(/\r?\n/)) {
            const 行 = line.replace(/^\s*[\d]+[.、)\]]\s*/, '').trim()
            if (!行 || 行.startsWith('主体') || 行.startsWith('示例')) continue
            const 段 = 行.split(/[|｜]/).map((x) => x.trim())
            if (段.length < 3) continue
            const [s, rel, tt] = 段
            if (!s || !rel || !tt || s === tt) continue
            if (s.length > 12 || tt.length > 12 || rel.length > 8) continue
            if (!/[\u4e00-\u9fa5\d]/.test(s) || !/[\u4e00-\u9fa5\d]/.test(tt)) continue
            攒下.push({ s, rel, t: tt }); 这批++
          }
        }
        if (!这批) 失败++
      }
      state.data.settings.modelDailyCap = 原cap
      // 去重
      const 见 = new Set(), 干净 = []
      for (const tr of 攒下) {
        const k = `${tr.s}|${tr.rel}|${tr.t}`
        if (见.has(k)) continue
        见.add(k); 干净.push(tr)
      }
      writeFileSync(旧文件, JSON.stringify(干净))
      sendJson(res, 200, { ok: true, 抽取批次: 调用, 失败批次: 失败, 三元组: 干净.length, 样例, 说明: '已写入 triples.json，接着重算图' })
    } catch (e) {
      sendJson(res, 500, { ok: false, 说: String(e && e.message) })
    }
  })
  registerRoute('/silicon-life-companion/graph3d', (_req, res) => {
    try {
      const 页 = join(pathJoinDirname(fileURLToPath(import.meta.url)), 'graph3d-page.html')
      if (!existsSync(页)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('缺 graph3d-page.html'); return }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(readFileSync(页))
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('3D 页出错：' + (e && e.message))
    }
  })
  registerRoute('/silicon-life-companion/graph.json', (_req, res) => {
    try {
      if (!existsSync(星云数据)) { sendJson(res, 200, { ok: false, 说: '还没算过图' }); return }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(readFileSync(星云数据))
    } catch (e) {
      sendJson(res, 500, { ok: false, 说: String(e && e.message) })
    }
  })
  registerRoute('/silicon-life-companion/graph/rebuild', async (_req, res) => {
    try {
      const 脚本 = join(pathJoinDirname(fileURLToPath(import.meta.url)), 'build-graph.mjs')
      const 子 = spawn(process.execPath, [脚本], { cwd: join(DATA_DIR), stdio: 'pipe' })
      let 出 = ''
      子.stdout.on('data', (d) => { 出 += d })
      子.stderr.on('data', (d) => { 出 += d })
      子.on('close', (code) => sendJson(res, 200, { ok: code === 0, 输出: 出.slice(-1200) }))
    } catch (e) { sendJson(res, 500, { ok: false, 说: String(e && e.message) }) }
  })
  registerRoute('/silicon-life-companion/journal.json', async (_req, res) => {
    await load()
    sendJson(res, 200, readJournal())
  })
  registerRoute('/silicon-life-companion/journal', async (_req, res) => {
    // 日记页已经搬到 journal-page.html（改样式不用动这个文件）
    try {
      const 日记页 = join(pathJoinDirname(fileURLToPath(import.meta.url)), 'journal-page.html')
      if (existsSync(日记页)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(readFileSync(日记页))
        return
      }
    } catch (e) { /* 文件不在就回落到下面内联那版 */ }
    const html = `<!doctype html><meta charset="utf-8"><title>大肥鱼的日记本 / 念头本</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;padding:24px;font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#faf8f5;color:#2c2a28}
  @media (prefers-color-scheme:dark){body{background:#1c1b1a;color:#e8e4df}}
  h1{font-size:20px;margin:0 0 4px}
  .sub{opacity:.6;font-size:13px;margin-bottom:18px}
  .tabs{display:flex;gap:8px;margin-bottom:16px}
  .tabs button{border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;padding:6px 14px;border-radius:999px;cursor:pointer;font-size:14px}
  .tabs button.on{background:#6f8ff0;border-color:#6f8ff0;color:#fff}
  .card{background:rgba(128,128,128,.08);border-radius:14px;padding:14px 16px;margin-bottom:12px;white-space:pre-wrap}
  .when{font-size:12px;opacity:.55;margin-bottom:6px}
  .empty{opacity:.5}
</style>
<a href="/silicon-life-companion/graph" style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:14px;text-decoration:none;
   background:linear-gradient(120deg,#0d1526,#16213a);border:1px solid #2a3d5e;color:#dbe6ff;margin-bottom:18px">
  <span style="font-size:20px">🌌</span>
  <span style="flex:1">
    <b style="display:block;font-size:15px;color:#eaf1ff">记忆星云</b>
    <span style="font-size:12px;color:#8fa4c6">事实 / 实体 / 主题，她脑子里长成什么样 · 点开看</span>
  </span>
  <span style="font-size:18px;color:#5b7cb0">→</span>
</a>
<h1>日记本 / 念头本</h1>
<div class="sub">这里是鱼鱼自己写的，不是档案。左边是本子，右边是当下。</div>
<div class="tabs">
  <button data-k="diary" class="on">日记本</button>
  <button data-k="thoughts">念头本</button>
  <button data-k="purposes">惦记的事</button>
</div>
<div id="list"></div>
<script>
let data = null, tab = 'diary'
const fmt = s => { try { return new Date(s).toLocaleString('zh-CN', { hour12: false }) } catch { return s || '' } }
function render(){
  const list = document.getElementById('list')
  list.innerHTML = ''
  if (!data) { list.innerHTML = '<div class="empty">读不到，等一下再刷。</div>'; return }
  let rows = []
  if (tab === 'diary') {
    rows = data.diaryFiles.map(x => ({ at: x.at, text: x.text, head: x.date }))
      .concat(data.diaryNotes.map(x => ({ at: x.at || x.createdAt, text: x.text, head: '' })))
  } else if (tab === 'thoughts') {
    rows = data.thoughts.map(x => ({ at: x.at || x.createdAt, text: x.text, head: '' }))
  } else {
    rows = data.purposes.map(x => ({ at: x.at || x.createdAt, text: x.text + (x.progress ? '\n（' + x.progress + '）' : ''), head: '' }))
  }
  if (!rows.length) { list.innerHTML = '<div class="empty">还空着。</div>'; return }
  for (const r of rows.slice(0, 60)) {
    const d = document.createElement('div'); d.className = 'card'
    d.innerHTML = '<div class="when">' + (r.head ? r.head + ' · ' : '') + fmt(r.at) + '</div>' + String(r.text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    list.appendChild(d)
  }
}
async function boot(){
  try { data = await (await fetch('/silicon-life-companion/journal.json', { cache: 'no-store' })).json() } catch (e) { data = null }
  render()
}
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  tab = b.dataset.k
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b))
  render()
})
boot()
</script>`
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
  })
  registerRoute('/silicon-life-companion/data', async (_req, res) => {
    await load()
    const limit = 30
    // archive 原样投影，只额外标注 role/噪声，让界面能分清「用户原话」和「历史系统通知」。
    const archive = state.data.raw.slice(-limit).map(row => ({ ...row, bucket: 'archive', noise: isArchivedNoise(row) }))
    const layers = { archive, facts: state.data.facts.slice(-limit), episodes: state.data.episodes.slice(-limit), profile: state.data.profile.slice(-limit) }
    const shownNoise = archive.filter(row => row.noise).length
    sendJson(res, 200, { layers, extensions: { diary: state.data.diary.slice(-limit), thoughts: state.data.thoughts.slice(-limit), purposes: state.data.purposes.filter(x => !x.expiresAt || x.expiresAt > now()).slice(-limit) }, shownNoise, note: 'archive 是 raw 的只读投影，不复制、不删除；标为「噪声」的是历史系统通知，已从注入与召回中排除。' })
  })
  // 联网更新表情库：refresh 拉清单；deep=true 时连新图一起镜像（慢，别频繁点）。
  registerRoute('/silicon-life-companion/sticker/refresh', async (req, res) => {
    await load()
    if (req.method !== 'POST') return sendJson(res, 200, { refresh: state.data.stickerRefresh || null, trends: trendsList() })
    const x = await readBody(req)
    const result = await refreshStickerLibrary({ deep: x?.deep === true })
    sendJson(res, 200, { ...result, refresh: state.data.stickerRefresh || null, trends: trendsList() })
  })
  registerRoute('/silicon-life-companion/bridge', async (req, res) => {
    await load()
    if (req.method !== 'POST') return sendJson(res, 200, bridgeStatus())
    const x = await readBody(req)
    const action = String(x.action || 'import')
    if (action === 'export') {
      const result = exportFactsToUpstream(String(x.sessionId || '').trim())
      return sendJson(res, 200, { action, ...result, bridge: bridgeStatus() })
    }
    const sessionId = String(x.sessionId || '').trim()
    const imported = importUpstreamFacts()
    // 管理页没有会话上下文：把已知会话都镜像一遍（每个会话各读自己的鱼记忆库）。
    const targets = sessionId ? [sessionId] : knownSessionIds()
    let fishImported = 0
    for (const id of targets) fishImported += importFishMemory(id).imported
    if (imported.imported || fishImported) await save()
    sendJson(res, 200, { action: 'import', upstream: imported, fish: { imported: fishImported, sessions: targets.length }, bridge: bridgeStatus(sessionId) })
  })
  // QQ 不回话的排查口：看 QQ 桥绑定的那个会话在当前进程里到底有没有活着的 agent。
  // 没有的话，QQ 收到的消息就没有回合可以跑 —— 表现就是「她不回话了」。
  registerRoute('/silicon-life-companion/diagnose/qq', async (req, res) => {
    await load()
    const cfgPath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'qq-bridge-config.json')
    let bound = ''
    let personaOn = false
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
      bound = String(cfg?.['私聊会话'] || cfg?.['目标会话'] || '')
      personaOn = cfg?.['人设开'] === true
    } catch { /* 没装就没有 */ }
    const live = (ctx.agents?.list?.() || []).map(agent => String(agent.id))
    const liveNow = Boolean(bound && live.includes(bound))
    let resumed = null
    if (bound && !liveNow && req.method === 'POST') {
      for (const shape of [{ sessionId: bound }, { id: bound }]) {
        try {
          await ctx.agents.resume(ctx, shape)
          resumed = { shape, ok: true }
          break
        } catch (error) {
          resumed = { shape, ok: false, error: String(error?.message || error) }
        }
      }
    }
    sendJson(res, 200, {
      bound,
      personaOn,
      liveAgents: live,
      boundSessionLive: liveNow || Boolean(resumed?.ok),
      resumed,
      hint: liveNow || resumed?.ok ? 'OK' : 'QQ 绑定的会话在这个进程里没有活着的 agent，QQ 消息进来没人接'
    })
  })
  registerRoute('/silicon-life-companion/export', async (req, res) => {
    await load()
    const full = JSON.stringify({ exportedAt: now(), data: state.data }, null, 2)
    sendJson(res, 200, { format: 'json', content: full, fullChars: full.length, truncated: false, scope: 'all-conversations', warning: 'Administrative export includes all conversations; use silicon_life_export for a session-scoped backup.' })
  })
  // 回到白纸：先把当前人设存档（可回看），再把名字/简介/三观/说话方式/提示词和性格清空。
  registerRoute('/silicon-life-companion/persona/blank', async (req, res) => {
    await load()
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST required' })
    const current = { persona: { ...state.data.persona }, personality: { ...state.data.personality } }
    const hasContent = Object.entries(current.persona).some(([key, value]) => key !== 'name' && String(value || '').trim()) || String(current.persona.name || '').trim() || Object.entries(current.personality).some(([key, value]) => key !== 'traits' && typeof value === 'number' ? value !== 50 : String(value || '').trim())
    if (hasContent) state.data.personaPresets = [...(state.data.personaPresets || []), { at: now(), ...current }].slice(-10)
    state.data.persona = { ...DEFAULT_PERSONA }
    state.data.personality = { ...DEFAULT_PERSONALITY }
    // 自动抽的自述是「从她说的话里推出来的画像」，人格清空时不该留着冒充白纸。
    for (const bucket of ['facts', 'profile']) {
      state.data[bucket] = (state.data[bucket] || []).filter(item => !String(item?.source || '').startsWith('auto-'))
    }
    await save()
    sendJson(res, 200, { blanked: true, archived: hasContent, presets: (state.data.personaPresets || []).length, status: status() })
  })
  // 把这套人格交给 QQ 桥（dsh-qq-link）。注意：QQ 桥的管理接口只认"本人"（浏览器会话），
  // 服务端直连会被 401 挡掉，所以这里只负责**准备好文本 + 记下备份**，真正保存由设置页在浏览器里发起。
  registerRoute('/silicon-life-companion/persona/push-qq', async (req, res) => {
    await load()
    const qqConfigPath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'qq-bridge-config.json')
    let before = null
    try {
      const raw = JSON.parse(readFileSync(qqConfigPath, 'utf8'))
      before = { 人设开: raw?.人设开 === true, 人设: String(raw?.人设 || '') }
      if (!state.data.qqPersonaBefore) { state.data.qqPersonaBefore = { ...before, at: now() }; await save() }
    } catch { before = null }
    sendJson(res, 200, {
      text: composePersonaText(),
      before,
      configured: Boolean(before),
      hint: before ? '把 text 提交到 /dsh-qq-bridge/save（人设开:true）即可让 QQ 那边也用这套人格' : '没找到 QQ 桥的配置，可能没装'
    })
  })
  registerRoute('/silicon-life-companion/config', async (req, res) => {
    await load()
    if (req.method !== 'POST') return sendJson(res, 200, status())
    const x = await readBody(req)
    const oldSettings = { ...state.data.settings }
    const oldPersonality = { ...state.data.personality }
    const oldPersona = { ...state.data.persona }
    const oldMoodSettings = { ...state.data.moodSettings }
    for (const key of ['enabled', 'activeThinking', 'modelSummary']) if (typeof x[key] === 'boolean') state.data.settings[key] = x[key]
    if (['off', 'rare', 'normal', 'often'].includes(String(x.stickerFrequency))) state.data.settings.stickerFrequency = String(x.stickerFrequency)
    if (isNumeric(x.modelDailyCap)) state.data.settings.modelDailyCap = clamp(x.modelDailyCap, 0, 500)
    if (isNumeric(x.injectionChars)) state.data.settings.injectionChars = clamp(x.injectionChars, 500, 12000)
    if (isNumeric(x.sevenDayDays)) state.data.settings.sevenDayMs = clamp(x.sevenDayDays, 1, 90) * DAY
    for (const key of ['warmth', 'curiosity', 'pragmatism']) if (isNumeric(x[key])) state.data.personality[key] = clamp(x[key], 0, 100)
    if (typeof x.traits === 'string') state.data.personality.traits = clean(x.traits, 2000)
    if (typeof x.personaName === 'string') state.data.persona.name = clean(x.personaName, 80)
    if (typeof x.personaDescription === 'string') state.data.persona.description = clean(x.personaDescription, 2000)
    if (typeof x.personaUserAddress === 'string') state.data.persona.userAddress = clean(x.personaUserAddress, 80)
    if (typeof x.personaLikes === 'string') state.data.persona.likes = clean(x.personaLikes, 600)
    if (typeof x.personaDislikes === 'string') state.data.persona.dislikes = clean(x.personaDislikes, 600)
    if (typeof x.personaValues === 'string') state.data.persona.values = clean(x.personaValues, 2000)
    if (typeof x.personaVoice === 'string') state.data.persona.voice = clean(x.personaVoice, 2000)
    if (typeof x.personaSamples === 'string') state.data.persona.samples = clean(x.personaSamples, 2000)
    if (typeof x.personaPrompt === 'string') state.data.persona.systemPrompt = clean(x.personaPrompt, 4000)
    if (Array.isArray(x.moodTaxonomy) && x.moodTaxonomy.length === 7) state.data.moodSettings.taxonomy = x.moodTaxonomy.map(v => clean(v, 30)).filter(Boolean).slice(0, 7)
    if (isNumeric(x.moodDecayHours)) state.data.moodSettings.decayHours = clamp(x.moodDecayHours, 1, 720)
    if (isNumeric(x.moodMaxDelta)) state.data.moodSettings.maxDelta = clamp(x.moodMaxDelta, 0, 1)
    try { await save() } catch {
      state.data.settings = oldSettings
      state.data.personality = oldPersonality
      state.data.persona = oldPersona
      state.data.moodSettings = oldMoodSettings
      return sendJson(res, 500, { error: 'configuration save failed; previous settings restored' })
    }
    sendJson(res, 200, status())
  })
  // 显式绑定主记忆（给 QQ 这类别的入口用）：只允许管理员通过本地 HTTP 设置，工具侧不开放。
  // 手动触发一次模型润色（管理页/调试用）：maxOne=false 时月记年表都重写。
  // 重写最近 N 天的日记：先按新规则重算底稿，再让模型逐天写成一句人话。
  registerRoute('/silicon-life-companion/rebuild', async (req, res) => {
    await load()
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST required' })
    const x = await readBody(req)
    const target = String(x.sessionId || '').trim()
    if (!target) return sendJson(res, 400, { error: 'sessionId is required' })
    const days = clamp(x.days ?? 7, 1, 90)
    const keys = new Set()
    for (let i = 0; i < days; i += 1) keys.add(dayKeyOf(new Date(Date.now() - i * 86400000).toISOString()))
    // 把这几天的旧条目清掉，让它们完全按当前规则重新生成（原话 archive 一条不动）。
    const before = state.data.diary.length
    state.data.diary = state.data.diary.filter(item => !(rowBelongsToSession(item, target) && isDayRow(item) && keys.has(String(item.day))))
    const removed = before - state.data.diary.length
    const regenerated = rebuildChronicle(target, days)
    // 重建是破坏性的（先删后生成）：必须立刻落盘，否则模型失败时磁盘上还留着旧文案。
    if (removed || regenerated) await save()
    let refinedDays = 0
    const details = []
    if (x.withModel !== false && state.data.settings.modelSummary !== false) {
      for (const key of [...keys].sort()) {
        const row = state.data.diary.find(item => isDayRow(item) && item.day === key && rowBelongsToSession(item, target))
        if (!row) continue
        const source = String(row.extractiveText || row.text || '')
        if (!source) continue
        const persona = [state.data.persona?.name, state.data.personality?.traits].filter(Boolean).join('，')
        const raw = await modelText(buildRollupPrompt({ period: key, kind: 'day', text: source, persona }), target, 40000)
        if (!raw) { details.push({ day: key, ok: false, error: runtime.lastSummaryError }); continue }
        const cleaned = cleanSummary(raw, { maxChars: 70 })
        if (!shouldAcceptSummary(cleaned, source)) { details.push({ day: key, ok: false, error: 'rejected' }); continue }
        row.extractiveText = source
        // 存底稿哈希：下次重建/重载只要底稿没变就保留这句模型文案，不再覆盖。
        row.inputsHash = hashInputs(source)
        row.text = cleaned
        row.source = 'model-summary'
        row.summaryAt = now()
        row.updatedAt = now()
        runtime.lastSummaryError = null
        refinedDays += 1
        details.push({ day: key, ok: true, text: cleaned })
      }
      if (refinedDays) await save()
    }
    sendJson(res, 200, { sessionId: target, days, removed, regenerated, refinedDays, details, chronicle: recentChronicle(target, 7) })
  })
  registerRoute('/silicon-life-companion/refine', async (req, res) => {
    await load()
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST required' })
    const x = await readBody(req)
    const target = String(x.sessionId || '').trim()
    if (!target) return sendJson(res, 400, { error: 'sessionId is required' })
    if (state.data.settings.modelSummary === false) return sendJson(res, 409, { error: 'modelSummary is disabled in settings' })
    const refined = await refineRollups(target, { maxOne: x.maxOne === true })
    if (refined) runtime.lastRefinedAt = now()
    // 诊断字段：模型润色没生效时能一眼看出卡在哪一步（没 llm 服务 / 没有模型配置 / 还是模型返回为空）。
    const llm = (() => { try { return ctx.get?.('llm') ?? ctx.llm } catch { return null } })()
    const config = currentCallConfig(target)
    const debug = { hasLlmStream: Boolean(llm?.stream), hasModelConfig: Boolean(config), provider: config?.provider || null, model: config?.model || null, raw: runtime.lastSummaryRaw || null, error: runtime.lastSummaryError }
    sendJson(res, 200, { sessionId: target, refined, error: runtime.lastSummaryError, debug, chronicle: { month: recentRollup(target, 'month'), year: recentRollup(target, 'year') } })
  })
  registerRoute('/silicon-life-companion/link', async (req, res) => {
    await load()
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST required' })
    const x = await readBody(req)
    const target = String(x.sessionId || '').trim()
    if (!target) return sendJson(res, 400, { error: 'sessionId is required' })
    const list = Array.isArray(x.readsFrom) ? [...new Set(x.readsFrom.map(String).map(v => v.trim()).filter(Boolean))].filter(id => id !== target) : []
    const cache = state.data.sessions[target] || { recent: [] }
    cache.readsFrom = list
    state.data.sessions[target] = cache
    await save()
    sendJson(res, 200, { sessionId: target, readsFrom: list, status: status(target) })
  })
  // 用户在管理页点「从历史原话回填」才会跑：把旧原话里能识别的自述补进 facts/profile。
  registerRoute('/silicon-life-companion/backfill', async (req, res) => {
    await load()
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST required' })
    const x = await readBody(req)
    const sessionId = String(x.sessionId || '').trim()
    sendJson(res, 200, await backfillLayers(sessionId))
  })
  registerRoute('/silicon-life-companion/clear', async (req, res) => {
    await load()
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST required' })
    const x = await readBody(req)
    if (x.confirm !== 'CLEAR') return sendJson(res, 400, { error: 'confirm must equal CLEAR' })
    const allowed = ['raw', ...validBuckets, 'moods', 'sessions']
    const buckets = Array.isArray(x.buckets) ? [...new Set(x.buckets.filter(k => allowed.includes(k)))] : []
    if (!buckets.length) return sendJson(res, 400, { error: 'select buckets explicitly' })
    if (buckets.includes('raw')) return sendJson(res, 403, { error: 'archive/raw is immutable through this endpoint; export first and use an explicit offline retention workflow' })
    const backup = Object.fromEntries(buckets.map(bucket => [bucket, state.data[bucket]]))
    try {
      for (const bucket of buckets) state.data[bucket] = bucket === 'sessions' ? {} : []
      await save()
    } catch (error) {
      Object.assign(state.data, backup)
      return sendJson(res, 500, { error: 'clear failed; previous data restored' })
    }
    sendJson(res, 200, { cleared: buckets, scope: 'all-conversations', status: status() })
  })
  ctx.effect(() => () => webDisposers.forEach(dispose => dispose?.()))

  // 工具只在插件上下文注册一次；会话边界在执行时由 exec.agent 决定（见 makeDefinition），
  // 这样既不会随 Agent 重载丢失，也不会跨对话串数据。
  // 逐个注册并各自兜底：单个工具重名不该把整个插件炸掉（那样连路由和注入都会一起失效）。
  const toolDisposers = []
  for (const tool of makeTools(() => '')) {
    try {
      if (typeof ctx.tools.get === 'function' && ctx.tools.get(tool.name)) continue
      toolDisposers.push(ctx.tools.register(tool))
    } catch (error) {
      console.error('[silicon-life-companion] tool register failed:', tool.name, error)
    }
  }
  ctx.effect(() => () => { for (const off of toolDisposers) off?.() })

  const mounted = new Map()
  const renderContext = { name: 'companion-memory-state', order: 910, required: false, interpolate: false }
  const mount = agent => {
    if (!agent?.ctx || !agent.id || mounted.has(agent.id)) return
    const sessionId = String(agent.id)
    // 挂载时把「鱼记忆」里这个会话的条目镜像进来：它记过的事，本插件的四层里也要看得见。
    const fishImported = importFishMemory(sessionId)
    if (fishImported.imported) void save()
    const promptDisposer = agent.ctx.systemPrompt.context({
      ...renderContext,
      text: () => {
        const text = composeInjection(sessionId)
        runtime.lastInjectChars = text.length
        return text
      }
    })
    runtime.mountedAgents += 1
    runtime.lastMountAt = now()
    // 挂载时先备一张表情候选：第一轮就有得用，而不是等到下一次对话。
    void refreshStickerHint(sessionId).then(hint => { if (hint) void save() })
    const offInbox = agent.ctx.on('agent/inbox/inserted', async ({ message }) => {
      await load()
      if (!state.data.settings.enabled || !message || isInjectedMessage(message)) return
      const body = clean(textOf(message), 1200)
      if (!body || alreadyRecorded(sessionId, 'user', body)) return
      const at = now()
      const anchor = sourceAnchor(sessionId, 'agent/inbox/inserted', at)
      const importance = scoreImportance(body, { relatedTexts: sessionRows(state.data.raw, sessionId).map(row => row.text), moodScore: moodSnapshot(sessionId)?.score })
      state.data.raw = [...state.data.raw, { role: 'user', text: body, at, source: 'agent-inbox', confidence: 1, importance, tier: classifyTier(importance, 0, state.data.settings.sevenDayMs), anchor }]
      // 先把「这句话本身」的向量排进队列：注入要用它跟记忆比相似度，
      // 等模型算完（约 0.4 秒）正好赶上；不然查询向量永远缺，真向量路等于白装。
      try { void warm([body, body.slice(0, 200)]) } catch {}  // 200 字那份就是注入时用的查询串
      const _beforeRaw = state.data.raw.slice()
      state.data.raw = trimRawByImportance(state.data.raw)
      if (state.data.raw.length < _beforeRaw.length) consolidateOnOverflow(_beforeRaw.filter((row) => !state.data.raw.includes(row)))
      trimToSessionCap('raw', sessionId)
      recordSelfFacts(sessionId, body, anchor)
      // 用户刚说了话：按这句话 + 当下心情挑一张表情候选，下一轮注入时用。
      const inboxStats = stickerStats(sessionId)
      inboxStats.quietTurns = (Number(inboxStats.quietTurns) || 0) + 1
      const hint = await refreshStickerHint(sessionId)
      if (hint) void save()
      await save()
    })
    const offTurnStopping = agent.ctx.on('agent/turn-stopping', async () => {
      if (!state.data.settings.enabled) return
      // 每轮结束刷新今天这一天的编年史，这样「今天做过什么」永远是新的。
      if (rebuildChronicle(sessionId, 2)) await save()
      await consolidateExpired(sessionId)
      // 每轮最多润色一条月记/年表；内容没变就跳过，失败静默回退到抽取式。
      try {
        const refined = await refineRollups(sessionId, { maxOne: true })
        if (refined) runtime.lastRefinedAt = now()
      } catch (error) {
        runtime.lastSummaryError = String(error?.message || error)
      }
    })
    const dispose = () => {
      offTurnStopping?.()
      offInbox?.()
      promptDisposer?.()
      if (mounted.delete(agent.id)) runtime.mountedAgents = Math.max(0, runtime.mountedAgents - 1)
    }
    mounted.set(agent.id, dispose)
  }
  // 插件重载后已有 Agent 不会重放 agent/created：启动时补挂，避免注入在、工具不在。
  const existing = (() => { try { return ctx.agents?.list?.() || [] } catch { return [] } })()
  for (const agent of existing) { try { mount(agent) } catch (error) { console.error('[silicon-life-companion] mount existing agent failed:', error) } }
  runtime.liveAgents = existing.map(agent => String(agent?.id || '')).filter(Boolean).slice(0, 40)
  const offCreated = ctx.on('agent/created', ({ agent }) => { try { mount(agent) } catch (error) { console.error('[silicon-life-companion] mount new agent failed:', error) } })
  // 光靠 agent/created 不够：切回一个早就开着的会话时不会重放事件，那间屋子就一直没挂上。
  // 每 4 秒对一次 agents.list()，把还没挂的补上（挂过的 mount 会直接返回）。
  const pollTimer = setInterval(() => {
    try {
      const live = ctx.agents?.list?.() || []
      runtime.liveAgents = live.map(agent => String(agent?.id || '')).filter(Boolean).slice(0, 40)
      for (const agent of live) {
        if (!mounted.has(String(agent?.id || ''))) mount(agent)
      }
    } catch { /* 列不出来就等下一次 */ }
  }, 4000)
  if (typeof pollTimer.unref === 'function') pollTimer.unref()
  ctx.effect(() => () => clearInterval(pollTimer))

  // 每日 22:50 自适应：纯本地统计，失败回滚，不会把状态写坏。
try {
  const tick = makeTick(state.data, {
  save,
  log: (...args) => console.log("[auto-iter]", ...args),
})
// 自适应跑完，把结论也告诉心情：只微调，不夺权。
const tickWithMood = (now) => {
  const out = tick(now)
  if (out?.applied) {
    try { runtime.getMoodV2?.()?.applyAutoIter?.(out.knobs) } catch {}
  }
  return out
}
  const timer = setInterval(() => { try { tickWithMood() } catch (error) { console.error("[auto-iter] tick failed:", error?.message || error) } }, 10 * 60 * 1000)
  timer.unref?.()
} catch (error) {
  console.error("[auto-iter] timer skipped:", error?.message || error)
}

const offSession = ctx.on('session/event', async (session, event) => {
    await load()
    if (!state.data.settings.enabled) return
    // 只认一条：assistant 的回复里到底有没有图片行。发了就清零，没发就攒着。
    if (event?.type === 'assistant/message') {
      const sid = String(session?.id ?? session?.header?.id ?? 'unknown')
      const said = textOf(event?.data?.message ?? event?.data)
      const 表情主题 = (said.match(/\[表情[:：]\s*([^\]]{1,20})\]/) || [])[1] || ''
      if (sid && 表情主题) {
        // 同一种表情反复用，说明这是她的习惯：记下来。
        const 用例 = (state.data.stickerThemes && typeof state.data.stickerThemes === "object") ? state.data.stickerThemes : {}
        const 记 = { ...(用例[sid] || {}) }
        const 键 = 表情主题.slice(0, 10)
        记[键] = Number(记[键] || 0) + 1
        state.data.stickerThemes = { ...用例, [sid]: 记 }
        if (记[键] === 5) {
          const 句子 = "爱用「" + 键 + "」这类表情"
          const 已有 = (state.data.profile || []).some(r => String(r && r.text || "").includes(句子))
          if (!已有) {
            state.data.profile = [...(state.data.profile || []), {
              text: 句子, at: now(), source: "auto-sticker", importance: 0.6, tier: "长期",
              anchor: { sessionId: sid, source: "sticker" },
            }]
          }
        }
        void save()
      }
      if (sid && /(!\[|\[表情[:：])/.test(said)) {
        const stats = stickerStats(sid)
        stats.quietTurns = 0
        stats.lastSentAt = now()
        void save()
      }
      return
    }
    if (event?.type !== 'user/message') return
    const data = event?.data || {}
    const body = clean(textOf(data), 1200)
    const sid = String(session?.id ?? session?.header?.id ?? 'unknown')
    if (!isStorableConversation('user', body) || isInjectedMessage(data) || alreadyRecorded(sid, 'user', body)) return
    const at = now()
    const anchor = sourceAnchor(sid, event.type, at)
    const importance = scoreImportance(body, { relatedTexts: sessionRows(state.data.raw, sid).map(row => row.text), moodScore: moodSnapshot(sid)?.score })
    state.data.raw = [...state.data.raw, { role: 'user', text: body, at, source: 'session-event', confidence: 1, importance, tier: classifyTier(importance, 0, state.data.settings.sevenDayMs), anchor }]
      const _beforeRaw = state.data.raw.slice()
      state.data.raw = trimRawByImportance(state.data.raw)
      if (state.data.raw.length < _beforeRaw.length) consolidateOnOverflow(_beforeRaw.filter((row) => !state.data.raw.includes(row)))
    trimToSessionCap('raw', sid)
    const sessionState = state.data.sessions[sid] || { recent: [] }
    sessionState.recent = [...sessionState.recent, { role: 'user', text: body.slice(0, 500), at }].slice(-12)
    recordSelfFacts(sid, body, anchor)
    // 这一句进来就顺手备好表情候选（QQ 这类走 session/event 的会话也覆盖到）。
    const stats = stickerStats(sid)
    stats.quietTurns = (Number(stats.quietTurns) || 0) + 1
    if (await refreshStickerHint(sid)) void save()
    // 心情只有一个来源：装了「鱼的心情」就镜像它的数值，不再本地自己算一套。
    const feiyu = readFeiyuMood()
    if (feiyu) {
      const lastMirror = sessionState.feiyuMirrorAt ? new Date(sessionState.feiyuMirrorAt).getTime() : 0
      if (Date.now() - lastMirror > 30 * 60 * 1000) {
        state.data.moods = [...state.data.moods, {
          text: feiyu.reason || feiyu.label,
          emotion: feiyu.label,
          category: feiyu.label,
          valence: clamp((feiyu.score - 50) / 50, -1, 1),
          arousal: 0,
          note: feiyu.reason,
          score: Math.round(feiyu.score),
          at: feiyu.at || at,
          source: 'feiyu-mood',
          confidence: clamp((feiyu.confidence || 0) / 100, 0, 1),
          anchor
        }].slice(-LIMITS.moods)
        trimToSessionCap('moods', sid)
        sessionState.feiyuMirrorAt = at
      }
      state.data.sessions[sid] = sessionState
      await save()
      return
    }
    const prev = sessionRows(state.data.moods, sid).at(-1) || { valence: 0, arousal: 0 }
    const elapsedHours = Math.max(0, (Date.now() - new Date(sessionState.moodUpdatedAt || at).getTime()) / 3600000)
    const decay = Math.exp(-elapsedHours / state.data.moodSettings.decayHours)
    const delta = /谢谢|喜欢|开心|很棒/.test(body) ? 0.05 : /难过|失望|生气|讨厌/.test(body) ? -0.06 : 0
    const emotion = delta > 0 ? '喜悦' : delta < 0 ? '悲伤' : '平静'
    const nextValence = clamp((prev.valence || 0) * decay + delta, Math.max(-1, (prev.valence || 0) - state.data.moodSettings.maxDelta), Math.min(1, (prev.valence || 0) + state.data.moodSettings.maxDelta))
    state.data.moods = [...state.data.moods, { emotion, category: emotion, valence: nextValence, arousal: clamp((prev.arousal || 0) * decay, Math.max(-1, (prev.arousal || 0) - state.data.moodSettings.maxDelta), Math.min(1, (prev.arousal || 0) + state.data.moodSettings.maxDelta)), at, source: 'bounded-rule-update', confidence: 0.35, anchor }].slice(-LIMITS.moods)
    trimToSessionCap('moods', sid)
    sessionState.moodUpdatedAt = at
    state.data.sessions[sid] = sessionState
    await save()
  })

  ctx.effect(() => () => {
    offCreated?.()
    offSession?.()
    for (const dispose of mounted.values()) dispose()
    mounted.clear()
  })
}
