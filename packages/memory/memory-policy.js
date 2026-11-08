// 人的记性：不是四个平铺的抽屉，是一条有半衰期的曲线。
// 瞬时：刚刚这几句（小时级），原文在，但随时会散
// 短期：今天（天级），细节开始模糊，只记得大概发生了啥
// 中期：这阵子（月级），能想起事情，想不起原话
// 长期：这些年（年级），稳定的印象和结论
// 永久：不衰减（你是谁、我叫什么、说过的要紧话）
//
// 这个模块只放“规则”，不碰 state——插件里怎么用由调用方决定。

const HOUR = 3600e3
const DAY = 86400e3

export const TIER_POLICY = {
  瞬时: { halfLife: 0.08, keepRaw: true, maxDays: 2 },
  短期: { halfLife: 1, keepRaw: true, maxDays: 7 },
  中期: { halfLife: 30, keepRaw: false, maxDays: 365 },
  长期: { halfLife: 365 * 10, keepRaw: false, maxDays: 365 * 30 },
  永久: { halfLife: Infinity, keepRaw: false, maxDays: Infinity },
}

// 一条记忆属于哪层：显式 tier 优先；否则由重要度和年龄共同决定。
export function tierOf(row, now = Date.now()) {
  const given = String(row?.tier || '')
  if (TIER_POLICY[given]) return given
  const at = Date.parse(String(row?.at || '')) || now
  const ageDays = Math.max(0, (now - at) / DAY)
  const imp = Number.isFinite(Number(row?.importance)) ? Number(row.importance) : 0.5
  const used = Number(row?.useCount || 0)
  if (imp >= 0.92) return '永久'
  if (imp >= 0.75 && (used >= 1 || ageDays < 60)) return '长期'
  if (ageDays < 2) return '瞬时'
  if (ageDays < 7) return '短期'
  if (ageDays < 60) return '中期'
  return imp >= 0.6 ? '长期' : '中期'
}

// 该不该还记得：按半衰期衰减，低于阈值就“淡出”（数据还在，只是不再主动说）。
export function retention(row, now = Date.now()) {
  const tier = tierOf(row, now)
  const policy = TIER_POLICY[tier]
  if (!Number.isFinite(policy.halfLife)) return 1
  const at = Date.parse(String(row?.at || '')) || now
  const ageDays = Math.max(0, (now - at) / DAY)
  const used = Math.min(5, Number(row?.useCount || 0))
  // 被反复想起的东西衰减更慢（复习效应）
  const halfLife = policy.halfLife * (1 + used * 0.6)
  return Math.pow(0.5, ageDays / halfLife)
}

// 晋升：短期里反复被用到的、说得很重的，会沉成长期甚至永久。
export function promotionOf(row, now = Date.now()) {
  const tier = tierOf(row, now)
  const imp = Number.isFinite(Number(row?.importance)) ? Number(row.importance) : 0.5
  const used = Number(row?.useCount || 0)
  if (tier === '永久') return '永久'
  if (imp >= 0.93) return '永久'
  if (tier === '瞬时' && used >= 2 && imp >= 0.6) return '短期'
  if (tier === '短期' && (used >= 2 || imp >= 0.8)) return '长期'
  if (tier === '中期' && (used >= 4 || imp >= 0.8)) return '长期'
  if (tier === '长期' && used >= 8 && imp >= 0.85) return '永久'
  return tier
}

// 把一堆行分成四桶：常驻锚点、长期、近期（还该念原文的）、已经淡出的。
export function bucketize(rows, { now = Date.now(), permanentMax = 6, longMax = 8, recentMax = 8 } = {}) {
  const out = { permanent: [], longTerm: [], recent: [], faded: [] }
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue
    const tier = tierOf(row, now)
    if (tier === '永久') out.permanent.push(row)
    else if (tier === '长期') out.longTerm.push(row)
    else if (tier === '瞬时' || tier === '短期') out.recent.push(row)
    else if (retention(row, now) < 0.12) out.faded.push(row)
    else out.longTerm.push(row)
  }
  const byScore = (a, b) => score(b, now) - score(a, now)
  out.permanent.sort(byScore)
  out.longTerm.sort(byScore)
  out.recent.sort((a, b) => (Date.parse(String(b.at || '')) || 0) - (Date.parse(String(a.at || '')) || 0))
  return {
    permanent: out.permanent.slice(0, permanentMax),
    longTerm: out.longTerm.slice(0, longMax),
    recent: out.recent.slice(0, recentMax),
    faded: out.faded,
    counts: {
      permanent: out.permanent.length,
      longTerm: out.longTerm.length,
      recent: out.recent.length,
      faded: out.faded.length,
    },
  }
}

// 留不留、念不念的综合分：分层权重 × 衰减 × 重要度 × 复习。
export function score(row, now = Date.now()) {
  const tier = tierOf(row, now)
  const tierWeight = { 永久: 100, 长期: 40, 中期: 12, 短期: 4, 瞬时: 1 }[tier] ?? 1
  const imp = Number.isFinite(Number(row?.importance)) ? Number(row.importance) : 0.5
  return tierWeight * (0.4 + retention(row, now)) + imp * 10 + Math.min(5, Number(row?.useCount || 0))
}

// 原话被挤出时，至少留一句“那阵子的摘要”，别整段凭空消失。
export function condenseForOverflow(rows, { max = 240 } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && String(r.text || '').trim())
  if (!list.length) return null
  const days = new Map()
  for (const row of list) {
    const at = Date.parse(String(row.at || '')) || Date.now()
    const key = new Date(at).toISOString().slice(0, 10)
    if (!days.has(key)) days.set(key, [])
    days.get(key).push(String(row.text))
  }
  const parts = []
  for (const [day, texts] of [...days.entries()].sort()) {
    parts.push(`${day}：${texts.slice(0, 4).join('；')}`)
  }
  let text = parts.join(' / ')
  if (text.length > max) text = text.slice(0, max - 1) + '…'
  return {
    text,
    kind: 'overflow-consolidation',
    days: [...days.keys()],
    from: list.length,
  }
}

// 自检：这套规则自己有没有自相矛盾的地方（给页面/自测用）。
export function selfCheck(row, now = Date.now()) {
  const tier = tierOf(row, now)
  const promoted = promotionOf(row, now)
  const r = retention(row, now)
  const ok = TIER_POLICY[tier] && r >= 0 && r <= 1 && typeof promoted === 'string'
  return { ok, tier, promoted, retention: Number(r.toFixed(4)) }
}
