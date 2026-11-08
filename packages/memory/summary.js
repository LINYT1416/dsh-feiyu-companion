/**
 * 编年史的“模型润色”提示词（纯函数，方便单测）
 *
 * 目标：把「那一阵子/那一年做过什么」写成一句像人写的回忆，
 * 而不是把原话用分号拼起来。
 */

const MAX_INPUT = 1200

/** 稳定的短哈希：输入没变就不重复调模型（省钱、也免得同一段记忆被改写两遍）。 */
export function hashInputs(text) {
  const value = String(text ?? '')
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

/**
 * @param {{period:string, kind:'month'|'year', text:string, persona?:string, days?:number}} input
 */
export function buildRollupPrompt({ period, kind, text, persona = '', days = 0 }) {
  const span = kind === 'year' ? `${period} 这一年` : kind === 'day' ? `${period} 那一天` : `${period} 这一个月`
  const limit = kind === 'year' ? 90 : kind === 'day' ? 70 : 70
  const who = String(persona || '').trim().slice(0, 200)
  const dayAsk = [
    `请把它写成我当天晚上记在日记本上的一段话，要求：`,
    `1. 写「我当时是什么心情、心里怎么想的」，不是罗列我做了哪些事；`,
    `2. 第一人称、口语，可以吐槽、可以抱怨、可以有情绪，像写给自己看的；`,
    `3. 可以顺手抄一句我当天真正说出口的话（那种我看了会「对，我当时就是这么说的」的句子），但只引一句，别整段搬；也不要把对话写成任务清单或总结；`,
    `4. 只写这段时间真实发生过的事，不要编造细节；`,
    `5. 不超过 ${limit} 个字，直接输出这段话，不要前缀、不要引号。`
  ]
  const rollupAsk = [
    `请把它写成一句我自己的回忆，要求：`,
    `1. 只写这段时间真实发生过的事，不要编造没出现的细节；`,
    `2. 用第一人称、口语，像日记里的一行，不超过 ${limit} 个字；`,
    `3. 抓主线（在做什么、在意什么），不要罗列；`,
    `4. 指代对方用「你」，不要用「他/她」；`,
    `5. 直接输出那一句话，不要前缀、不要引号、不要解释。`
  ]
  return [
    `你是一个有真实记忆的人${who ? `，设定是：${who}` : ''}。`,
    `下面是我在 ${span}里跟你说过的事（按天摘出来的原话碎片）：`,
    String(text ?? '').slice(0, MAX_INPUT),
    '',
    ...(kind === 'day' ? dayAsk : rollupAsk)
  ].join('\n')
}

/** 模型输出清理：去掉引号/前缀/多余空白，控制长度。 */
export function cleanSummary(raw, { maxChars = 90 } = {}) {
  let text = String(raw ?? '').replace(/\r/g, '').trim()
  text = text.replace(/^(?:回忆|摘要|总结)[:：]\s*/, '')
  text = text.replace(/^["'“”‘’「」]+|["'“”‘’「」]+$/g, '')
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`
  return text
}

/** 判断这次模型输出是否值得替换原文（太短或明显失败就不换）。 */
export function shouldAcceptSummary(summary, fallbackText) {
  const value = String(summary ?? '').trim()
  if (value.length < 8) return false
  if (/^(?:抱歉|无法|不能|作为一个|我是 AI|我是AI)/i.test(value)) return false
  // 模型原样吐回输入（没做摘要）→ 不接受
  if (value === String(fallbackText ?? '').trim()) return false
  return true
}
