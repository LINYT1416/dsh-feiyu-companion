/**
 * 记忆分层（纯函数，不碰状态）
 *
 * 人类的记忆不是按“第几天”分桶的，而是先判重要性，再让时间把它推向更高层或淡掉：
 *   瞬时 instant   —— 刚发生、还没被判定重要，只活在当前语境里
 *   短期 short     —— 有点用，先留着看会不会再被提起（默认 7 天内）
 *   长期 long      —— 明确重要，跨天也要记住
 *   永久 permanent —— 身份级：约定、底线、偏好、反复强调的事，永不淡出
 *
 * 这里只负责“判断”，不负责存；存由 index.js 的 buckets 负责，
 * 这样分层规则可以单独测，不会因为改规则而碰坏数据。
 */

export const TIER_TYPES = ['instant', 'short', 'long', 'permanent']
export const TIER_LABEL = { instant: '瞬时', short: '短期', long: '长期', permanent: '永久' }
export const TIER_CUT = { short: 0.35, long: 0.6, permanent: 0.85 }
export const TIER_INSTANT_MS = 30 * 60 * 1000

const SIGNALS = {
  // 被明确托付的事：人类最容易记住的正是这类
  explicit: /记住|别忘了|别忘|约好|约定|答应|一定要|永远|以后都|每次都|我的规矩|我不喜欢|我喜欢|从今往后/,
  // 情绪浓度高的内容：杏仁核加成
  emotion: /难过|失望|生气|讨厌|害怕|焦虑|开心|高兴|太好了|谢谢你|喜欢你|爱你|想你|崩溃|累死/,
  // 关于自己的陈述
  selfDisclosure: /^我(?!们)|我的/,
  // 纯应答/指令，几乎没有记忆价值
  lowValue: /^(?:继续|好+|嗯+|收到|明白了|在吗|测试|？+|\?+|ok|okay|继续迭代|继续吧)$/i
}

const clamp01 = n => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0))

/**
 * 给一句话打重要性（0~1）。
 * @param {string} text 原话
 * @param {{relatedTexts?: string[], moodScore?: number|null, lengthBonus?: boolean}} ctx
 *   relatedTexts: 同会话里其它原话，用来判断“这件事被反复提起过没有”
 *   moodScore: 当时的情绪强度（0~100），情绪越浓越容易记住
 */
export function scoreImportance(text, ctx = {}) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!value) return 0
  if (SIGNALS.lowValue.test(value)) return 0.1

  let score = 0.3
  if (SIGNALS.explicit.test(value)) score += 0.35
  if (SIGNALS.selfDisclosure.test(value)) score += 0.2
  if (SIGNALS.emotion.test(value)) score += 0.15
  if (ctx.lengthBonus !== false && value.length >= 40) score += 0.08

  const probe = value.slice(0, 12)
  const repeats = Array.isArray(ctx.relatedTexts)
    ? ctx.relatedTexts.filter(other => typeof other === 'string' && other && other !== value && other.includes(probe)).length
    : 0
  if (repeats >= 2) score += 0.15
  if (repeats >= 4) score += 0.1

  if (Number.isFinite(ctx.moodScore)) score += Math.min(0.1, Math.abs(ctx.moodScore - 50) / 500)

  return clamp01(score)
}

/**
 * 分数定天花板，时间定它现在停在哪一层。
 * @param {number} importance 0~1
 * @param {number} ageMs 距今毫秒
 * @param {number} sevenDayMs 短期窗口（可配）
 */
export function classifyTier(importance, ageMs, sevenDayMs = 7 * 86400000) {
  const score = clamp01(importance)
  const age = Math.max(0, Number(ageMs) || 0)
  if (score >= TIER_CUT.permanent) return 'permanent'
  if (score >= TIER_CUT.long) return 'long'
  if (age <= TIER_INSTANT_MS) return 'instant'
  if (age <= sevenDayMs) return 'short'
  // 过了短期窗口：还有点价值就归档成长期，否则自然淡掉（数据仍在 archive，不删除）
  return score >= TIER_CUT.short ? 'long' : 'instant'
}

/** 一行的当前层级；行里存了 importance 就直接用，没存就按文本重算。 */
export function tierOfRow(row, opts = {}) {
  const sevenDayMs = opts.sevenDayMs ?? 7 * 86400000
  const nowMs = opts.nowMs ?? Date.now()
  const at = row && row.at ? new Date(row.at).getTime() : NaN
  const ageMs = Number.isFinite(at) ? Math.max(0, nowMs - at) : 0
  const importance = Number.isFinite(row?.importance)
    ? row.importance
    : scoreImportance(row?.text ?? '', { moodScore: row?.mood?.score })
  return classifyTier(importance, ageMs, sevenDayMs)
}

/** 统计各层条数，供 status / 管理页展示。 */
export function summarizeTiers(rows, opts = {}) {
  const out = { instant: 0, short: 0, long: 0, permanent: 0, total: 0 }
  for (const row of Array.isArray(rows) ? rows : []) {
    const tier = tierOfRow(row, opts)
    out[tier] += 1
    out.total += 1
  }
  return out
}

/** 该不该从原话升级成“永久事实”。 */
export function shouldPromote(row, opts = {}) {
  if (!row || row.role !== 'user') return false
  return tierOfRow(row, opts) === 'permanent'
}
