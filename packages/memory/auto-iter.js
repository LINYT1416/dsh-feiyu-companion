// 每日自适应（22:50）：看前一天她说了什么，微调几档"说话习惯"，不碰人设、不调模型。
// 纯本地统计，零 token。改之前先备份，跑完自检；出错回滚，绝不把状态写坏。

const MIN = 60 * 1000

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

function dayKey(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// 从当天的原话里抽几组很浅的指标。
export function measureDay(rows, day) {
  const texts = (rows || [])
    .filter(r => r && r.role === 'user' && dayKey(r.at) === day)
    .map(r => String(r.text || ''))
    .filter(t => t.length >= 2 && t.length <= 300)
  if (!texts.length) return null
  const all = texts.join('')
  const avgLen = all.length / texts.length
  const question = texts.filter(t => /[？?]|吗$/.test(t)).length / texts.length
  const particle = (all.match(/[哈啊呀呢吧嘛哦诶嘿]/g) || []).length / texts.length
  const negative = texts.filter(t => /累|烦|难受|崩|不想|困|郁闷|生气|讨厌/.test(t)).length / texts.length
  const positive = texts.filter(t => /好耶|开心|哈哈|喜欢|棒|顺利|搞定|太好了/.test(t)).length / texts.length
  return {
    n: texts.length,
    avgLen: Number(avgLen.toFixed(2)),
    question: Number(question.toFixed(2)),
    particle: Number(particle.toFixed(2)),
    negative: Number(negative.toFixed(2)),
    positive: Number(positive.toFixed(2)),
  }
}

// 指标 → 几档行为。范围写死，跑歪了也只在界内。
export function decideKnobs(m, prev = {}) {
  const k = {
    replyLen: prev.replyLen ?? 'normal',   // short | normal | long
    warmth: prev.warmth ?? 0,              // -0.2 ~ 0.2，影响口气软硬
    habitGroup: prev.habitGroup ?? null,   // 口头禅池子
  }
  if (!m) return k
  if (m.negative >= 0.3) { k.replyLen = 'short'; k.warmth = clamp(k.warmth + 0.05, -0.2, 0.2); k.habitGroup = '软' }
  else if (m.positive >= 0.3) { k.replyLen = 'normal'; k.warmth = clamp(k.warmth + 0.03, -0.2, 0.2); k.habitGroup = '损' }
  if (m.avgLen >= 40 && m.question >= 0.3) k.replyLen = 'long'
  if (m.avgLen <= 12) k.replyLen = 'short'
  if (m.habitGroup == null) k.habitGroup = '傲娇'
  return k
}

// 自检：数值在范围内、字段类型对、必填还在。
export function selfCheck(state) {
  const k = state?.autoIter?.knobs
  if (!k) return { ok: true, note: '还没跑过' }
  const bad = []
  if (!['short', 'normal', 'long'].includes(k.replyLen)) bad.push('replyLen')
  if (!Number.isFinite(k.warmth) || Math.abs(k.warmth) > 0.21) bad.push('warmth')
  if (!['傲娇', '损', '软', '懒'].includes(k.habitGroup)) bad.push('habitGroup')
  if (!state.persona || typeof state.persona !== 'object') bad.push('persona')
  return bad.length ? { ok: false, bad } : { ok: true, note: '数值都在界内' }
}

// 主入口：一天只跑一次；先备份、再算、再自检，失败就回滚。
export function runDailyAdapt(state, { now = new Date(), save, log = () => {} } = {}) {
  const day = dayKey(now.toISOString())
  const prevDay = dayKey(new Date(now.getTime() - 86400000).toISOString())
  if (state.autoIter?.day === day) return { skipped: 'today-done' }

  const snapshot = JSON.stringify({ persona: state.persona, personality: state.personality, habit: state.habit, autoIter: state.autoIter })
  try {
    const m = measureDay(state.raw, prevDay)
    const knobs = decideKnobs(m, state.autoIter?.knobs || {})
    state.autoIter = {
      day,
      at: now.toISOString(),
      metrics: m,
      knobs,
      history: [...(state.autoIter?.history || []), { day: prevDay, metrics: m, knobs }].slice(-30),
    }
    const check = selfCheck(state)
    if (!check.ok) throw new Error('自检没过：' + check.bad.join(','))
    if (typeof save === 'function') save()
    log('auto-iter ok', day, m ? JSON.stringify(m) : 'no-data')
    return { applied: true, metrics: m, knobs }
  } catch (error) {
    try {
      const restored = JSON.parse(snapshot)
      state.persona = restored.persona
      state.personality = restored.personality
      state.habit = restored.habit
      state.autoIter = restored.autoIter
      if (typeof save === 'function') save()
    } catch { /* 连回滚都失败就什么都不写 */ }
    log('auto-iter failed, rolled back:', String(error?.message || error))
    return { rolledBack: true, error: String(error?.message || error) }
  }
}

// 每 10 分钟看一眼：到 22:50 之后、当天还没跑过，就跑一次。
export function makeTick(state, { save, log } = {}) {
  return function tick(now = new Date()) {
    const h = now.getHours()
    const mm = now.getMinutes()
    if (h < 22 || (h === 22 && mm < 50)) return null
    return runDailyAdapt(state, { now, save, log })
  }
}

export { MIN }
