/**
 * 从用户原话里抽「值得长期记住的自述」以及判断一句话是否像人话。
 *
 * 教训：以前用 /我有(...)/ 这种宽规则，把「我有个疑问」也当成事实记下来了；
 * 真正有用的话（我住在哪、我养了什么、我讨厌什么）反而被碎片淹没。
 * 所以这里改成：先排除明显的提问/临时状态/口水话，再要求内容本身有信息量。
 */

const CJK = /[\u4e00-\u9fa5]/g

const normalize = text => String(text ?? '').replace(/\s+/g, ' ').trim()
const cjkCount = text => (String(text || '').match(CJK) || []).length

// 提问 / 临时感受 / 口头禅：不该进长期记忆
const NOT_A_FACT = [
  /[？？?]\s*$/,
  /(?:吗|呢|吧|么)\s*$/,
  /^(?:我)?(?:有|有点|有些)?(?:个|一个)?(?:疑问|问题|想法|建议|点疑问)/,
  /^我(?:想问|想问问|好奇|想知道|觉得|感觉|猜|看|看看|试试|以为|刚才|现在|今天|这两天)(?!住|在.*住)/,
  /^我(?:有一?点|有点|有些)/,
  /^我(?:说|问|答|回)/
]

// 真正值得记的自述：主语是「我 / 我的」，谓语给出稳定信息
const FACT_PATTERNS = [
  { re: /我(?:叫|名叫)([^，。！？；\n]{1,20})/, need: 1 },
  { re: /我是(?!一个?人|一种|谁的|不是)([^，。！？；\n]{1,30})/, need: 2 },
  { re: /我住在([^，。！？；\n]{1,30})/, need: 2 },
  { re: /我(?:喜欢|最爱|爱|讨厌|不喜欢|习惯了|习惯|希望|想要)([^，。！？；\n]{2,40})/, need: 2 },
  // 「我不吃香菜」这类否定偏好同样是稳定信息
  { re: /我(?:不|没)(?:吃|喝|玩|用|去|看|碰)([^，。！？；\n]{2,20})/, need: 2 },
  { re: /我的([^，。！？；\n]{1,20})(?:是|叫|在)([^，。！？；\n]{1,24})/, need: 1 },
  { re: /我(?:养了?|养了一只|养了一只叫)([^，。！？；\n]{2,30})/, need: 2 },
  { re: /我(?:有了一只?|有一只?)([^，。！？；\n]{2,30})/, need: 2 },
  { re: /我(?:在做|正在做|在做着)([^，。！？；\n]{3,30})/, need: 3 },
  { re: /我(?:来自|姓)([^，。！？；\n]{1,20})/, need: 1 }
]

function isNotAFact(candidate) {
  const value = normalize(candidate)
  if (!value) return true
  if (cjkCount(value) < 4) return true
  return NOT_A_FACT.some(pattern => pattern.test(value))
}

/**
 * 从一句原话里抽最多两条自述事实。
 * @param {string} body
 * @returns {string[]}
 */
export function extractSelfFacts(body) {
  const text = normalize(body)
  if (!text || text.length > 400) return []
  const found = []
  for (const { re, need } of FACT_PATTERNS) {
    const match = re.exec(text)
    if (!match) continue
    const candidate = normalize(match[0]).slice(0, 160)
    if (isNotAFact(candidate)) continue
    // 捕获到的信息本身要够长，挡掉「我住在」「我喜欢」这种半截话
    const captured = cjkCount(match[1] || '')
    if (captured < need) continue
    found.push(candidate)
  }
  return [...new Set(found)].slice(0, 2)
}

const DIGEST_NOISE = /^(?:background job|pwsh|node|npm|pnpm|\$|\[exit code|Get-|Invoke-|Set-|Copy-Item|Remove-Item)|pwsh:|Invoke-WebRequest|\.ps1|\.mjs|\.json\b|C:\\|\/usr\//i
// 纯应答 / 纯提问：写进日记毫无信息量
const FILLER = /^(?:继续|继续吧|继续迭代|好+|嗯+|哦+|收到|明白了|知道了|在吗|测试|真的吗|哈哈+|笑死|行|可以|对|是的)[。！!~～]*$/i
const TINY_QUESTION = /[？？?]\s*$/

/**
 * 一句话够不够格进编年史：得是有人味、有信息量的陈述。
 */
export function looksLikeSpeech(text, { minChars = 6 } = {}) {
  const value = normalize(text)
  if (!value) return false
  // 中英混排也算信息量：「帮我接入qq」不该因为没有更多汉字被丢掉
  const meaningful = cjkCount(value) + (value.match(/[A-Za-z0-9]/g) || []).length
  if (meaningful < minChars) return false
  if (DIGEST_NOISE.test(value)) return false
  if (FILLER.test(value)) return false
  // 一句话全是问号结尾、又很短 → 只是随口一问，不进日记
  if (TINY_QUESTION.test(value) && cjkCount(value) < 12) return false
  const symbols = (value.match(/[{}[\]$\\/|=<>]/g) || []).length
  if (symbols > 2) return false
  return true
}
