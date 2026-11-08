/**
 * 日记去重：只记「今天新发生的事」。
 *
 * 动机：用户每天都说「继续迭代」「接着做」，如果照单全收，编年史会变成
 * 一模一样的流水账——2026-11-03 和 11-04 读起来没有区别。人记事不会这样，
 * 重复的事会被压缩成「还是那件事」，只有新的信息才值得占一行。
 *
 * 纯函数，方便单测；不碰 I/O。
 */

/** 归一化：只留字母/数字（含中文），标点、符号、表情一律丢掉，方便比较同一个意思的不同写法。 */
export function normalizeCore(text) {
  return String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function bigrams(value) {
  const out = new Set()
  for (let i = 0; i < value.length - 1; i += 1) out.add(value.slice(i, i + 2))
  return out
}

/** 0..1 的相似度：中文用字符二元组 Jaccard，短句退化成包含判断。 */
export function similarity(a, b) {
  const left = normalizeCore(a)
  const right = normalizeCore(b)
  if (!left || !right) return 0
  if (left === right) return 1
  if (left.length < 4 || right.length < 4) return left.includes(right) || right.includes(left) ? 0.9 : 0
  // 短口令式重复（「继续迭代」）常常整句包含在旧句里，二元组会把相似度压得很低，单独处理。
  const shorter = left.length <= right.length ? left : right
  const longer = left.length <= right.length ? right : left
  if (shorter.length <= 6 && longer.includes(shorter)) return 0.85
  // 同一天里越补越长的同一句（「继续迭代…」→「继续迭代…，大肥鱼我相信你」）也算重复
  if (shorter.length >= 6 && longer.startsWith(shorter)) return 0.85
  const ga = bigrams(left)
  const gb = bigrams(right)
  let shared = 0
  for (const gram of ga) if (gb.has(gram)) shared += 1
  return shared / (ga.size + gb.size - shared)
}

/**
 * 这句话是不是「前几天已经说过的那件事」。
 * @param {string} text
 * @param {string[]} previous 前几天的日记原文（已被分号拆开的句子也可以）
 * @param {number} threshold
 */
export function isRepeat(text, previous, threshold = 0.72) {
  if (!previous?.length) return false
  return previous.some(prev => similarity(text, prev) >= threshold)
}

/**
 * 从今天的候选句里挑出真正新鲜的那些。
 * 全都在重复 → 返回空数组（今天没有值得写进日记的新事）。
 */
export function pickFreshLines(lines, previous, { max = 6, threshold = 0.72 } = {}) {
  const seen = []
  const kept = []
  for (const line of lines || []) {
    const value = String(line ?? '').trim()
    if (!value) continue
    // 同一天内部也去重
    if (seen.some(item => similarity(item, value) >= threshold)) continue
    if (isRepeat(value, previous, threshold)) continue
    seen.push(value)
    kept.push(value)
    if (kept.length >= max) break
  }
  return kept
}
