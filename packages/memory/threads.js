/**
 * 「线索」：把散在几天里的同一件事串成一条线。
 *
 * 试过两种做法：
 *   1. 纯统计 n-gram 共现 → 只会冒出「继续迭代」「的问题」这种碎片；
 *   2. 让模型输出「名称|开始|最近|状态」→ 格式太严，模型稍微多说一句就整条作废。
 * 现在改成：模型只说「名称|状态」，日期由我在日记里核对名字出现过哪些天。
 * 名字在日记里查不到 = 模型编的，直接丢掉。
 */

const MAX_DAYS = 14
const MAX_ITEMS = 3

/** 拼提示词：只要求名字和状态，降低格式失败率。 */
export function buildThreadsPrompt(days) {
  const rows = (days || [])
    .filter(item => item?.day && String(item.text || '').trim())
    .sort((a, b) => String(a.day).localeCompare(String(b.day)))
    .slice(-MAX_DAYS)
  if (rows.length < 2) return ''
  const body = rows.map(item => `${item.day}：${String(item.text).slice(0, 160)}`).join('\n')
  return [
    '下面是我最近几天的日记（每天一行）：',
    body,
    '',
    '我最近一直在做哪几件事？用一句中文回答，最多 3 件，用顿号「、」隔开。',
    '- 每件事写具体（比如「记忆插件」「QQ 接入」），不要写「继续」「迭代」「验证」这种空词；',
    '- 只输出这一句，不要编号、不要解释、不要状态、不要日期。'
  ].join('\n')
}

/** 名字是否真的出现在某天的日记里（防止模型编造/添油加醋）。 */
function mentions(dayText, name) {
  const text = String(dayText || '')
  if (text.includes(name)) return true
  // 拆开的写法（「QQ 接入」vs 日记里的「接入 QQ」）：每个词都出现过就算
  const tokens = String(name).split(/\s+/).filter(token => token.length >= 2)
  if (tokens.length > 1 && tokens.every(token => text.includes(token))) return true
  // 允许名字被省略后缀，但至少要连续对上 4 个字，避免只凭前两个字瞎认。
  const packed = String(name).replace(/\s+/g, '')
  const need = Math.min(4, packed.length)
  if (packed.length < need) return false
  return text.includes(packed.slice(0, need))
}

/** 名字太长时，取日记里真实出现过的最长前缀（「Companion 与 B 站联动的…」→「Companion」）。 */
function shortenName(segment, rows) {
  const value = String(segment).trim()
  if (value.length <= 8) return value
  // 英文专名别按字节硬切（Companion 会被切成 Companio）：整词优先。
  const firstWord = value.split(/\s+/)[0]
  if (/^[A-Za-z][A-Za-z0-9]{1,15}$/.test(firstWord) && rows.some(item => mentions(item.text, firstWord))) return firstWord
  for (let size = 8; size >= 2; size -= 1) {
    const candidate = value.slice(0, size).trim()
    if (candidate.length >= 2 && rows.some(item => mentions(item.text, candidate))) return candidate
  }
  return value.split(/\s+/)[0].slice(0, 12)
}

/**
 * 解析并核对：名字 + 状态来自模型，起止日期来自日记。
 * @param {string} raw 模型输出
 * @param {{day:string,text:string}[]} days 最近几天的日记
 */
export function parseThreads(raw, days = []) {
  const rows = (days || [])
    .filter(item => item?.day && String(item.text || '').trim())
    .sort((a, b) => String(a.day).localeCompare(String(b.day)))
  const out = []
  // 模型只要给一句「A、B、C」，这里同时兼容逗号/分号/换行/竖线写法。
  const segments = String(raw ?? '')
    .split(/[、，,；;\n]/)
    .map(part => part.split(/[|｜]/)[0])
    .map(part => part.replace(/^[-*\d.、\s]+/, '').replace(/[（(].*?[)）]/g, '').replace(/[。！？!?~～]/g, '').trim())
    .filter(Boolean)
  for (const segment of segments) {
    const raw = segment.slice(0, 40).trim()
    if (!raw || raw.length < 2) continue
    if (/^(继续|迭代|验证|检查|问题|日记|每天|一直|事情|最近)$/.test(raw)) continue
    const name = shortenName(raw, rows)
    if (!name || name.length < 2) continue
    if (out.some(item => item.name === name)) continue
    // 核对：名字必须在日记里出现过，否则视为编造
    const hitDays = rows.filter(item => mentions(item.text, name)).map(item => item.day)
    if (!hitDays.length) continue
    out.push({ name, status: '进行中', firstDay: hitDays[0], lastDay: hitDays[hitDays.length - 1], days: hitDays.length })
    if (out.length >= MAX_ITEMS) break
  }
  return out.sort((a, b) => String(b.lastDay).localeCompare(String(a.lastDay)))
}

/** 提示词输入变了才重新问模型（省一次调用）。 */
export function threadsSignature(days) {
  const rows = (days || [])
    .filter(item => item?.day && String(item.text || '').trim())
    .sort((a, b) => String(a.day).localeCompare(String(b.day)))
    .slice(-MAX_DAYS)
  return rows.map(item => `${item.day}:${String(item.text).slice(0, 160)}`).join('|')
}
