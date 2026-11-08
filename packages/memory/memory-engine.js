// 记忆引擎（照 LivingMemory 的骨架，但只用标准库，不装任何依赖）
// 四件事：
//   1) 原子事实：一句话拆成“事实”，每种类型有自己的寿命（TTL）
//   2) 衰减与强化：重要度每天掉一点，被用过的掉得慢
//   3) 双路检索：关键词 BM25 路 + 向量路（字符二元组哈希，自制轻量 embedding）
//   4) 融合：RRF 排位融合 + MMR 去重，最后按 相关/重要/新鲜 加权

const DAY = 86400000

// ── 查询扩写：装不了模型，就让词自己长出手脚 ──────────────────────
// 她问「主人的B站账号」，库里那条写的是「uid 123456789 / 昵称 示例昵称」，
// 字面一个词都不重合。把同义说法补进查询，比硬升向量维度管用得多。
const ALIAS = [
  // B站只说「B站」时不要瞎补账号词，否则「B站评论怎么发」会被账号类条目抢走。
  [/(账号|uid|\bid\b)/i, ['uid', '昵称', '账号', '鲸鲸']],
  [/(名字|叫什么|昵称)/i, ['昵称', '名字', '叫']],
  [/(评论|回复|留言)/i, ['评论', 'surfcore', 'bili']],
  [/(语音|说话|声音|嗓子)/i, ['语音', 'gpt-sovits', 'sovits', '声音']],
  [/(吃|喝|口味|爱吃)/i, ['喜欢', '吃', '喝']],
  [/(住|家|哪)/i, ['住', '家']],
  [/(记忆|记性|忘)/i, ['记忆', '记得', '忘']],
  [/(插件)/i, ['插件', 'dsh']],
  [/(心情|情绪)/i, ['心情', '情绪', '心境']],
  [/(日程|安排|计划)/i, ['日程', '安排', '计划']],
  [/(qq|企鹅)/i, ['qq', '雪风', '桥']]
]
export function expandQuery(text) {
  const s = String(text || '')
  const extra = []
  for (const [re, words] of ALIAS) if (re.test(s)) extra.push(...words)
  return extra.length ? s + ' ' + extra.join(' ') : s
}

// ── 分词：中文按二元组 + 英文/数字按词 ──────────────────────────────
export function tokenize(text) {
  const s = String(text || '').toLowerCase()
  const out = new Map()
  const push = (t) => { if (t) out.set(t, (out.get(t) || 0) + 1) }
  for (const m of s.matchAll(/[a-z0-9]+/g)) push(m[0])
  const han = s.replace(/[^\u4e00-\u9fa5]+/g, ' ')
  for (const seg of han.split(' ')) {
    if (!seg) continue
    if (seg.length === 1) push(seg)
    for (let i = 0; i < seg.length - 1; i++) push(seg.slice(i, i + 2))
  }
  return out
}

export function docLen(tokens) {
  let n = 0
  for (const v of tokens.values()) n += v
  return n
}

// ── 轻量向量：字符二元组哈希到固定维度，再 L2 归一化 ────────────────
export function embed(text, dim = 256) {
  const v = new Float64Array(dim)
  const toks = tokenize(text)
  for (const [t, c] of toks) {
    let h = 2166136261
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i)
      h = Math.imul(h, 16777619) >>> 0
    }
    const idx = h % dim
    v[idx] += 1 + Math.log(c)
  }
  let norm = 0
  for (let i = 0; i < dim; i++) norm += v[i] * v[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < dim; i++) v[i] /= norm
  return v
}

export function cosine(a, b) {
  let d = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) d += a[i] * b[i]
  return d
}


// ── 查询加成：把"主人的/是多少/叫啥"这类虚词剔掉，剩下的实词才算命中 ──
const STOP = new Set(['的', '是', '了', '在', '有', '和', '与', '也', '都', '就', '那', '这', '吗', '呢', '吧', '啊', '呀',
  '什么', '多少', '怎么', '哪个', '哪个', '我', '你', '他', '她', '它', '我们', '你们', '请问', '告诉'])

export function contentTokens(text) {
  const out = []
  for (const [tok] of tokenize(text)) {
    if (tok.length < 2 && !/[a-z0-9]/i.test(tok)) continue   // 单字中文不要
    if (STOP.has(tok)) continue
    out.push(tok)
  }
  return out
}

// 一条文档相对这个查询的额外加成：
//   · 实词整词命中（"B站""账号""uid"）→ 每个 +0.35
//   · 问的是号码/账号/uid 且文档里有 6 位以上数字 → +1.2（这种问题答案几乎总是那串数字）
//   · 多词命中占比越高，加成越完整（避免只撞一个词就翻上来）
export function entityBoost(query, text) {
  const q = String(query || '')
  const d = String(text || '')
  const toks = contentTokens(q)
  if (!toks.length) return 0
  let hit = 0
  for (const tok of toks) if (d.toLowerCase().includes(tok.toLowerCase())) hit += 1
  let boost = 0.35 * hit
  const ratio = hit / toks.length
  boost *= 0.5 + 0.5 * ratio
  if (/账号|帐号|uid|id|号码|编号|电话|几号/i.test(q) && /\d{6,}/.test(d)) boost += 1.2
  return boost
}

// ── BM25 ─────────────────────────────────────────────────────────
export function makeIndex(docs, { k1 = 1.5, b = 0.75 } = {}) {
  const items = docs.map((d, i) => ({ id: i, text: d.text, tokens: tokenize(d.text), len: 0 }))
  let total = 0
  const df = new Map()
  for (const it of items) {
    it.len = docLen(it.tokens)
    total += it.len
    for (const t of new Set(it.tokens.keys())) df.set(t, (df.get(t) || 0) + 1)
  }
  const avgdl = total / (items.length || 1)
  const N = items.length || 1
  return {
    docs: items,
    search(query, topK = 10) {
      const q = tokenize(expandQuery(query))
      const scores = []
      for (const it of items) {
        let s = 0
        for (const [t, qc] of q) {
          const f = it.tokens.get(t)
          if (!f) continue
          const n = df.get(t) || 0
          const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
          s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (it.len / avgdl))) * Math.min(qc, 3)
        }
        if (s > 0) {
          s *= 1 + 0.9 * entityBoost(query, it.text)
          scores.push({ id: it.id, score: s })
        }
      }
      scores.sort((a, b2) => b2.score - a.score)
      return scores.slice(0, topK)
    },
  }
}

// ── 向量检索 ─────────────────────────────────────────────────────
// 向量数组里允许出现 null（这条还没算过真向量）：有真向量就只用真的那批，
// 没算过的行交给 BM25 去捞，不会因为缺一条就把整批退回哈希。
export function makeVectorIndex(texts, dim = 256, 向量 = null) {
  const 原文 = texts.map((t) => String(t || ''))
  const 是数组 = Array.isArray(向量) && 向量.length === texts.length
  const 有真 = 是数组 && 向量.some((v) => v && v.length)
  const 维 = 有真 ? (向量.find((v) => v && v.length) || []).length : dim
  const vecs = 有真
    ? 向量.map((v) => (v && v.length === 维 ? (v instanceof Float64Array ? v : Float64Array.from(v)) : null))
    : texts.map((t) => embed(t, dim))
  return {
    vecs,
    search(query, topK = 10, 查询向量 = null) {
      if (!vecs.length) return []
      const 用真查询 = Boolean(查询向量 && 查询向量.length === 维)
      // 库里有真向量、但查询自己还没算出来时，不能拿哈希向量去跟真向量比大小——
      // 那是两个空间。这一轮就只走 BM25，等查询向量算好再说。
      if (有真 && !用真查询) return []
      const q = 用真查询 ? 查询向量 : embed(expandQuery(query), 维)
      const out = []
      vecs.forEach((v, i) => {
        if (!v) return                       // 没向量不进向量路，别拿哈希冒充真向量
        out.push({ id: i, score: cosine(q, v) + 0.25 * entityBoost(query, 原文[i]) })
      })
      out.sort((a, b) => b.score - a.score)
      return out.filter((x) => x.score > 0).slice(0, topK)
    },
  }
}

// ── RRF 融合（排位级，不怕两路分数不可比）──────────────────────────
export function rrf(lists, { k = 60 } = {}) {
  const acc = new Map()
  for (const list of lists) {
    list.forEach((hit, rank) => {
      const cur = acc.get(hit.id) || { id: hit.id, score: 0, hits: 0 }
      cur.score += 1 / (k + rank + 1)
      cur.hits += 1
      acc.set(hit.id, cur)
    })
  }
  const out = [...acc.values()]
  for (const x of out) if (x.hits > 1) x.score += 0.02 // 两路同时命中，小幅奖励
  out.sort((a, b) => b.score - a.score)
  return out
}

// ── MMR 去重（别把同一件事念三遍）──────────────────────────────────
export function mmr(items, vecOf, { lambda = 0.7, topK = 10 } = {}) {
  const picked = []
  const pool = [...items]
  while (pool.length && picked.length < topK) {
    let best = -1
    let bestScore = -Infinity
    for (let i = 0; i < pool.length; i++) {
      const vi0 = vecOf(pool[i].id)
      const sim = picked.length && vi0
        ? Math.max(...picked.map((p) => {
            const vp = vecOf(p.id)
            if (!vp || vp.length !== vi0.length) return 0
            return cosine(vi0, vp)
          }))
        : 0
      const s = lambda * pool[i].score - (1 - lambda) * sim
      if (s > bestScore) { bestScore = s; best = i }
    }
    picked.push(pool.splice(best, 1)[0])
  }
  return picked
}

// ── 原子事实：一句话拆成事实，每种类型有自己的寿命 ─────────────────
const TTL = { 事件: 7, 计划: 2, 事实: 180, 关系: 90, 偏好: 60, 未知: 30 }

export function atomType(text) {
  const t = String(text || '')
  // 顺序有讲究：先判"最不该过期"的稳定事实，再往下走短期类型。
  // 旧版把「是」当成事实关键词，一句话里几乎都有「是」，结果什么都存 180 天——
  // 这就是之前"该忘的不忘"的根因，这里收窄到真正的身份/账号类词。
  if (/uid|账号|帐号|号码|编号|生日|邮箱|住在|老家|身份证/i.test(t)) return '事实'
  if (/叫|名字|昵称/.test(t)) return '事实'
  if (/明天|下周|待会|稍后|计划|打算|准备|要去|约好/.test(t)) return '计划'
  if (/今天|刚才|刚刚|昨天|上午|下午|晚上|刚才/.test(t)) return '事件'
  if (/喜欢|讨厌|偏好|爱吃|不爱|最怕/.test(t)) return '偏好'
  // 注意：别把单独的「主人」当关系词——几乎每句话都有它，一加就全变关系类
  if (/妈妈|爸爸|朋友|同事|老婆|老公|男朋友|女朋友|师兄|师姐|老板/.test(t)) return '关系'
  if (/主人(是|叫|的.*叫)/.test(t)) return '关系'
  return '未知'
}

// 被用一次就强化：TTL 按强化次数延长（1 次 +30%，最多翻倍），衰减也变慢。
export function reinforceAtom(atom, { at = Date.now() } = {}) {
  if (!atom) return atom
  atom.reinforce = Number(atom.reinforce || 0) + 1
  const base = Number(atom.ttlDays || TTL.未知)
  const 倍 = Math.min(2, 1 + 0.3 * atom.reinforce)
  atom.ttlDays = Math.round(base * 倍)
  atom.expiresAt = at + atom.ttlDays * DAY
  if (atom.status === 'dormant') atom.status = 'active'   // 又被想起来了，从休眠叫醒
  return atom
}

// 生命周期：过期的标成 expired（数据不删，只是不再念）
export function sweepAtoms(atoms, now = Date.now()) {
  const out = []
  for (const a of atoms || []) {
    if (!a) continue
    if (a.status === 'active' && Number(a.expiresAt || 0) <= now) a.status = 'expired'
    out.push(a)
  }
  return out
}

// 新事实取代旧事实：旧的进 superseded，不再参与召回
export function supersede(oldAtom, newAtom) {
  if (oldAtom) oldAtom.status = 'superseded'
  return newAtom
}

export function toAtoms(text, { at = Date.now() } = {}) {
  const parts = String(text || '')
    .split(/[。；;！!？?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
  return parts.map((s, i) => {
    const type = atomType(s)
    const ttl = TTL[type] || TTL.未知
    return {
      id: `${at}-${i}`,
      text: s,
      type,
      ttlDays: ttl,
      expiresAt: at + ttl * DAY,
      status: 'active',
      reinforce: 0,
      at,
    }
  })
}

// ── 衰减：重要度每天掉一点，被用过的掉得慢 ─────────────────────────
export function decay(importance, { ageDays = 0, reinforce = 0, rate = 0.01 } = {}) {
  const effective = rate / (1 + Math.min(5, reinforce) * 0.5)
  const v = Number(importance || 0) * Math.exp(-effective * Math.max(0, ageDays))
  return Math.max(0, Math.min(1, v))
}

export function atomAlive(atom, now = Date.now()) {
  return atom && atom.status === 'active' && Number(atom.expiresAt || 0) > now
}


// ── 查询意图：问"账号/叫什么"想要事实，问"今天"想要事件，问"谁"想要关系 ──
export function queryIntent(query) {
  const q = String(query || '')
  if (/uid|账号|帐号|号码|编号|生日|邮箱|叫什么|名字|昵称|多少/i.test(q)) return '事实'
  if (/今天|刚才|昨天|上午|下午|晚上|吃了|去了/i.test(q)) return '事件'
  if (/明天|下周|计划|打算|安排/i.test(q)) return '计划'
  if (/喜欢|讨厌|偏好|爱不|爱吃|最怕|运动|口味/i.test(q)) return '偏好'
  if (/谁|关系|认识|朋友|同事|是我什么人/i.test(q)) return '关系'
  return ''
}

// 这条记忆的类型跟查询意图对不对得上：对得上给一点加成（正/负）
export function intentBonus(query, text) {
  const want = queryIntent(query)
  if (!want) return 0
  const got = atomType(text)
  if (got === want) return 0.12
  if (want === '事实' && got === '未知') return -0.05   // 问事实，答"未知"的靠后
  return 0
}

// ── 一条记忆的综合分：相关 + 重要 + 新鲜 ───────────────────────────
export function finalScore({ rel = 0, importance = 0.5, ageDays = 0, reinforce = 0 }) {
  const fresh = Math.max(0, 1 - ageDays / 30)
  const imp = decay(importance, { ageDays, reinforce })
  return 0.65 * rel + 0.2 * imp + 0.15 * fresh
}