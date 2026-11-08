/**
 * 编年史折叠（纯函数）
 *
 * 天 → 月 → 年：每上一层都只留下“那段时间我们主要在做的事”，
 * 这样十年之后注入的长度也不会变，但年表里仍然有那一年。
 *
 * 输入都是 { period, text } 的数组，不碰状态，方便单测。
 */

const MAX_ITEM = 22 // 每条子记录在月/年摘要里最多留多少字

const clip = (text, max) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** 从按天的记录里抽月份键：2026-11-03 → 2026-11 */
export function monthOf(dayKey) {
  const value = String(dayKey ?? '')
  return /^\d{4}-\d{2}/.test(value) ? value.slice(0, 7) : ''
}

/** 从月份键里抽年份：2026-11 → 2026 */
export function yearOf(period) {
  const value = String(period ?? '')
  return /^\d{4}/.test(value) ? value.slice(0, 4) : ''
}

/**
 * 折月：把一个月的日记压成一条。
 * 同样的句子只留一次（那几天可能在做同一件事）。
 */
export function rollupMonths(dayEntries, { maxChars = 400 } = {}) {
  const byMonth = new Map()
  for (const entry of Array.isArray(dayEntries) ? dayEntries : []) {
    const period = monthOf(entry?.day)
    if (!period) continue
    if (!byMonth.has(period)) byMonth.set(period, [])
    byMonth.get(period).push(entry)
  }
  const out = []
  for (const [period, entries] of [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const seen = new Set()
    const pieces = []
    for (const entry of entries.sort((a, b) => String(a.day).localeCompare(String(b.day)))) {
      for (const part of String(entry.text || '').split('；')) {
        const piece = clip(part, MAX_ITEM)
        if (piece.length < 4 || seen.has(piece)) continue
        seen.add(piece)
        pieces.push(piece)
      }
    }
    if (!pieces.length) continue
    out.push({ period, text: pieces.join('；').slice(0, maxChars), days: entries.length })
  }
  return out
}

/**
 * 折年：把一年的月记压成一条。
 */
export function rollupYears(monthEntries, { maxChars = 400 } = {}) {
  const byYear = new Map()
  for (const entry of Array.isArray(monthEntries) ? monthEntries : []) {
    const period = monthOf(entry?.period) || monthOf(entry?.day)
    const year = yearOf(period)
    if (!year) continue
    if (!byYear.has(year)) byYear.set(year, [])
    byYear.get(year).push(entry)
  }
  const out = []
  for (const [year, entries] of [...byYear.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const seen = new Set()
    const pieces = []
    for (const entry of entries.sort((a, b) => String(a.period).localeCompare(String(b.period)))) {
      for (const part of String(entry.text || '').split('；')) {
        const piece = clip(part, MAX_ITEM)
        if (piece.length < 4 || seen.has(piece)) continue
        seen.add(piece)
        pieces.push(piece)
      }
    }
    if (!pieces.length) continue
    out.push({ period: year, text: pieces.join('；').slice(0, maxChars), months: entries.length })
  }
  return out
}
