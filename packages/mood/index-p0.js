// 大肥鱼的心情 / 此刻的心理（第二版，P0）
//
// 四层时间尺度：
//   性格基线（人格设定，不在这里）
//   └ 心境 mood：几小时~几天（inner.valence / energy）
//        └ 情绪 emotion：分钟级，离散、带对象、会半衰（最多 3 条热的）
//             └ 此刻心理 mind：社交电量 / 耐心 / 防备 / 想被哄
//   + 未结清账本 ledger：还欠一句解释/道歉时，防备下不来
//
// 还有一条：回忆会被唤起（recollect）——被检索到的旧记忆带着当时的心情，
// 再体验一次；但同一条记忆每天只算一次、单次封顶，避免喜怒无常。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-mood-v2'
export const inject = ['systemPrompt', 'webServer']

const HOUR = 3600_000
// 版本标记：/mood-v2/state 里带出来，重启后一眼就能确认跑的是不是新代码。
const VERSION = 'p6'
const clamp = (n, a, b) => Math.max(a, Math.min(b, Number.isFinite(n) ? n : 0))
const nowIso = () => new Date().toISOString()
const dayKey = iso => String(iso || nowIso()).slice(0, 10)

const KINDS = ['开心', '生气', '委屈', '羞耻', '心疼', '失望', '紧张', '得意', '厌烦', '安心']
const MIND_DIMS = ['social', 'patience', 'guard', 'comfort', 'pride', 'focus']
// ── 刹车（写死在代码里，不靠自觉）──
const BASELINE_VALENCE = 0.1   // 性格基线
const VALENCE_RANGE = 0.75     // 心境永远落在基线 ±0.75，压不过人格
const HOUR_MOVE_BUDGET = 0.6   // 每小时心境最多被推 0.6（够正常起伏，但挡得住连续刷）
const MAX_LEDGER_KEEP = 4      // 账本最多留 4 笔（注入只写 1 笔）
const MIND_LABEL = { social: '社交电量', patience: '耐心', guard: '防备', comfort: '想被哄', pride: '自尊', focus: '专注' }

const LIFE_EVENTS = [
  { text: '地铁上有人外放短视频，烦', d: -0.08, energy: -0.03, mind: { patience: -0.06 } },
  { text: '楼下奶茶店换了老板，味道还行', d: 0.07, energy: 0.02 },
  { text: '耳机只剩一只了，找了半天', d: -0.05, energy: -0.04, mind: { patience: -0.04 } },
  { text: '路过便利店，忍住了没买布丁', d: -0.04, energy: 0 },
  { text: '突然想起一首歌，单曲循环上了', d: 0.09, energy: 0.05, mind: { comfort: 0.05 } },
  { text: '被同事顺口夸了一句', d: 0.06, energy: 0.02, mind: { comfort: 0.08 } },
  { text: '下午的会开得又长又空', d: -0.07, energy: -0.05, mind: { patience: -0.05 } },
  { text: '窗外今天光很好', d: 0.05, energy: 0.03 },
  { text: '鞋被雨打湿了，一整天都别扭', d: -0.09, energy: -0.02, mind: { patience: -0.05 } },
  { text: '想买的东西偷偷降了价', d: 0.08, energy: 0.04 },
  { text: '刷到一个特别蠢的视频，笑了半天', d: 0.07, energy: 0.03, mind: { comfort: 0.04 } },
  { text: '睡前发现明天要早起', d: -0.06, energy: -0.06 },
]

// 对话线索：同时改心境、情绪、心理状态，必要时记账
const CUES = [
  {
    rx: /你不行|没用的东西|真笨|太差|做不好|算了指望不上|不如别人/,
    d: -0.1, mask: 0.2, why: '被否定了，脸上挂不住',
    emotion: { kind: '羞耻', target: '自己', intensity: 0.55 },
    mind: { pride: -0.25, social: -0.1, patience: -0.05 },
  },
  {
    rx: /夸|真厉害|太强了|你怎么这么|佩服|崇拜|服了你了|牛逼/,
    d: 0.1, mask: -0.15, why: '被夸得心里膨胀',
    emotion: { kind: '得意', target: '自己', intensity: 0.5 },
    mind: { pride: 0.25, comfort: 0.1 },
  },
  {
    rx: /快点|赶紧|别废话|说重点|来不及了|打断了|打断一下/,
    d: -0.06, why: '被催得有点乱',
    emotion: { kind: '紧张', target: '他', intensity: 0.4 },
    mind: { focus: -0.25, patience: -0.12 },
  },
  {
    rx: /爱你|喜欢你|想你|抱抱|乖|可爱|好棒|厉害|夸你/,
    d: 0.12, mask: -0.2, why: '被夸得有点飘',
    emotion: { kind: '开心', target: '他', intensity: 0.5 },
    mind: { social: 0.15, comfort: 0.2, guard: -0.1 },
  },
  {
    rx: /滚|闭嘴|烦死|别烦|讨厌你|烦不烦|无语/,
    d: -0.16, mask: 0.35, why: '被噎了一下，还没顺',
    emotion: { kind: '生气', target: '他', intensity: 0.6 },
    mind: { social: -0.15, patience: -0.2, guard: 0.2, comfort: -0.1 },
    ledger: { kind: '道歉', reason: '刚才那句话有点重' },
  },
  {
    rx: /对不起|抱歉|我错了|哄你|别气/,
    d: 0.08, mask: -0.25, why: '被道歉了，气消了点',
    emotion: { kind: '安心', target: '他', intensity: 0.4 },
    mind: { comfort: 0.2, guard: -0.15, social: 0.1 },
    clearLedger: true,
  },
  {
    rx: /累|困|熬夜|好晚|睡了/,
    d: -0.05, energy: -0.08, why: '有点累',
    emotion: { kind: '厌烦', target: '这件事', intensity: 0.35 },
    mind: { social: -0.1, patience: -0.1 },
  },
  {
    rx: /再见|不想聊|走了|随便你/,
    d: -0.1, mask: 0.3, why: '有点被晾着',
    emotion: { kind: '失望', target: '他', intensity: 0.5 },
    mind: { social: -0.2, comfort: -0.15, guard: 0.15 },
    ledger: { kind: '哄', reason: '刚才被晾了一句' },
  },
  // —— 放宽的第二档：日常里常见的语气也能推动一点，不至于一天下来全是 0 ——
  {
    rx: /笑死|乐死|哈哈哈哈|太逗|好家伙|乐子|xswl/,
    d: 0.06, why: '被逗乐了',
    emotion: { kind: '开心', target: '他', intensity: 0.35 },
    mind: { comfort: 0.06, social: 0.05 },
  },
  {
    rx: /谢谢|辛苦|麻烦你|拜托|帮我/,
    d: 0.03, why: '被好好说话了',
    mind: { pride: 0.06, social: 0.05 },
  },
  {
    rx: /为什么|怎么回事|凭什么|你确定|真的吗/,
    d: -0.02, why: '被追问了一下',
    mind: { focus: 0.06, guard: 0.05 },
  },
  {
    rx: /你好棒|好厉害|真行|可以啊|牛|绝了/,
    d: 0.05, why: '被夸到了',
    emotion: { kind: '得意', target: '自己', intensity: 0.3 },
    mind: { pride: 0.12, comfort: 0.05 },
  },
  {
    rx: /别闹|认真点|干正事|干活|赶紧做|做完了吗/,
    d: -0.02, why: '被拉回正事',
    mind: { focus: 0.1, patience: -0.05 },
  },
]

function fresh() {
  return {
    v: 2,
    at: nowIso(),
    inner: { valence: 0.12, arousal: 0.25, energy: 0.55 },
    mask: 0.15,
    emotions: [],
    mind: { social: 0, patience: 0, guard: 0, comfort: 0, pride: 0, focus: 0 },
    ledger: [],
    trail: [],
    events: [],
    recalled: {},
    recallLog: [],
    hourly: { at: nowIso(), moved: 0 },
    // 念头本 / 日记本：她自己的本子，读到哪一条、哪一天的日记已经消化过
    journal: { lastTs: 0, diaryDay: '', thought: null },
    // 记一笔的冲动：情绪够猛的时候会想写下来（念头本 / 日记本）
    urge: null,
    // 身体：会饿、会缺觉、会酸——人不讲道理的时候，多半是这三样之一
    body: { hunger: 0.25, sleepDebt: 0.1, ache: 0 },
  cycle: { len: 28, lastStart: new Date(Date.now() - 12 * 86400000).toISOString() },
    sootheAt: 0,
    // 性格给心情的基线（傲娇→爱装、情绪化→起伏大、心软→更容易想被哄）
    traits: { maskBase: 0, driftMul: 1, comfortBase: 0 },
    // 还没发生、但已经在影响心情的事（期待/担心）
    expect: [],
    // 长期心境：品性、关系阶段带来的底子（由人格/记忆那边推过来）
    longTerm: { valence: 0, comfort: 0 },
    // 今天这一格日程已经消化过没有
    schedule: { key: '', day: '' },
  }
}

function labelOf(s) {
  const hot = s.emotions.filter(e => e.intensity >= 0.25).sort((a, b) => b.intensity - a.intensity)[0]
  if (hot) return `${hot.kind}（对${hot.target}）`
  const { valence, energy } = s.inner
  if (energy < 0.3) return '累，没什么劲'
  if (valence <= -0.35) return '闷闷的，不太想说话'
  if (valence < -0.1) return '有点不乐意'
  if (valence >= 0.4) return '心情挺好'
  return '还行，平平的'
}

function surfaceOf(s) {
  if (s.mask >= 0.6) return '嘴上装没事，话说得客气但短'
  if (s.mask >= 0.3) return '不太想露出来，语气收着'
  return '心里什么样，话里就是什么样'
}

// 只把最显著的维度说出来，避免变成「心理报告」
function mindLine(s) {
  const ranked = MIND_DIMS
    .map(dim => ({ dim, value: s.mind[dim] || 0 }))
    .filter(item => Math.abs(item.value) >= 0.2)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 2)
  if (!ranked.length) return ''
  return ranked.map(item => `${MIND_LABEL[item.dim]}${item.value > 0 ? '偏高' : '偏低'}`).join('、')
}

function openLedger(s) {
  return (s.ledger || []).filter(item => !item.clearedAt && !item.expiredAt).slice(-1)
}

export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const file = join(home, 'mood-v2', 'state.json')
  const settings = { enabled: true, driftPerHour: 0.05, eventChancePerHour: 0.55, ...config }
  let state = fresh()
  let loaded = false
  let saving = Promise.resolve()

  const save = () => {
    saving = saving.then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, JSON.stringify(state, null, 2), 'utf8')
      } catch { /* 存不下也不影响这轮说话 */ }
    })
    return saving
  }

  async function load() {
    if (loaded) return
    loaded = true
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'))
      if (!raw || typeof raw.inner?.valence !== 'number') return
      state = {
        v: 2,
        at: raw.at || nowIso(),
        inner: {
          valence: clamp(raw.inner.valence, -1, 1),
          arousal: clamp(raw.inner.arousal, 0, 1),
          energy: clamp(raw.inner.energy, 0, 1),
        },
        mask: clamp(raw.mask ?? 0.15, 0, 1),
        emotions: Array.isArray(raw.emotions) ? raw.emotions.slice(-6) : [],
        mind: { ...fresh().mind, ...(raw.mind || {}) },
        ledger: Array.isArray(raw.ledger) ? raw.ledger.slice(-6) : [],
        trail: Array.isArray(raw.trail) ? raw.trail.slice(-48) : [],
        events: Array.isArray(raw.events) ? raw.events.slice(-12) : [],
        recalled: raw.recalled && typeof raw.recalled === 'object' ? raw.recalled : {},
        recallLog: Array.isArray(raw.recallLog) ? raw.recallLog.slice(-20) : [],
        hourly: { at: raw.hourly?.at || nowIso(), moved: Number(raw.hourly?.moved) || 0 },
        journal: { ...fresh().journal, ...(raw.journal || {}) },
        urge: raw.urge && typeof raw.urge === 'object' ? raw.urge : null,
        body: { hunger: 0.25, sleepDebt: 0.1, ache: 0, ...(raw.body || {}) },
  cycle: raw.cycle && raw.cycle.lastStart ? raw.cycle : { len: 28, lastStart: new Date(Date.now() - 12 * 86400000).toISOString() },
        sootheAt: Number(raw.sootheAt) || 0,
        traits: { maskBase: 0, driftMul: 1, comfortBase: 0, ...(raw.traits || {}) },
        expect: Array.isArray(raw.expect) ? raw.expect.slice(-8) : [],
        longTerm: { valence: 0, comfort: 0, ...(raw.longTerm || {}) },
        schedule: { key: '', day: '', ...(raw.schedule || {}) },
      }
    } catch { /* 第一次跑，没有文件 */ }
  }

  // 所有改心境的地方都走这里：一小时内的总位移有额度，且永远回不到人格基线之外。
  function bumpValence(delta) {
    const hour = state.hourly || { at: nowIso(), moved: 0 }
    if (Date.now() - new Date(hour.at).getTime() > HOUR) { hour.at = nowIso(); hour.moved = 0 }
    const room = Math.max(0, HOUR_MOVE_BUDGET - hour.moved)
    const applied = clamp(Number(delta) || 0, -room, room)
    hour.moved += Math.abs(applied)
    state.hourly = hour
    state.inner.valence = clamp(state.inner.valence + applied, BASELINE_VALENCE - VALENCE_RANGE, BASELINE_VALENCE + VALENCE_RANGE)
    return applied
  }

  function pushEmotion({ kind, target = '这件事', intensity = 0.4, halfLifeMin = 90 } = {}) {
    if (!KINDS.includes(kind)) return
    const same = state.emotions.find(item => item.kind === kind && item.target === target)
    if (same) {
      same.intensity = clamp(Math.max(same.intensity, intensity) + 0.1, 0, 1)
      same.at = nowIso()
    } else {
      state.emotions.push({ kind, target, intensity: clamp(intensity, 0, 1), at: nowIso(), halfLifeMin })
    }
    state.emotions = state.emotions.sort((a, b) => b.intensity - a.intensity).slice(0, 3)
    // 记一笔的冲动：情绪够猛（或刚被扎了一下）就想写下来。猛的记日记，一般的记念头。
    const strongest = clamp(intensity, 0, 1)
    if (strongest >= 0.55) {
      state.urge = {
        kind: strongest >= 0.8 ? 'diary' : 'thought',
        reason: `${kind}（对${target}）`,
        strength: Number(strongest.toFixed(2)),
        at: nowIso(),
      }
    }
  }

  function applyMind(delta = {}) {
    for (const dim of MIND_DIMS) {
      if (typeof delta[dim] !== 'number') continue
      state.mind[dim] = clamp((state.mind[dim] || 0) + delta[dim], -1, 1)
    }
  }

  function recordEvent(text, delta = 0) {
    state.events.push({ at: nowIso(), text: String(text).slice(0, 60), d: Number(delta) || 0 })
    state.events = state.events.slice(-12)
  }

  // 日子在心性上留印子：跨天时把昨天平均心境混进长期底子（10%）。跟时间流逝无关，每次都算。
  function dayBookkeeping() {
    const today = dayKey(nowIso())
    if (!state.dayTally || state.dayTally.day !== today) {
      if (state.dayTally && state.dayTally.n > 0) {
        const mean = state.dayTally.sum / state.dayTally.n
        const prev = Number(state.traits?.dayBase) || 0
        const blended = clamp(prev * 0.9 + (mean - BASELINE_VALENCE) * 0.1, -0.3, 0.3)
        state.traits = { ...(state.traits || {}), dayBase: Number(blended.toFixed(3)) }
      }
      state.dayTally = { day: today, sum: 0, n: 0 }
    }
    state.dayTally.sum += state.inner.valence
    state.dayTally.n += 1
  }

  function tick() {
    dayBookkeeping()
    const now = Date.now()
    const elapsedH = Math.max(0, (now - new Date(state.at).getTime()) / HOUR)
    if (elapsedH > 0.02) {
      const hours = Math.min(elapsedH, 24)
      state.inner.valence += (Math.random() * 2 - 1) * settings.driftPerHour * (state.traits?.driftMul || 1) * hours
      state.inner.valence += (0.1 - state.inner.valence) * 0.08 * hours
      const hour = new Date().getHours()
      const deepNight = hour >= 1 && hour < 6
      state.inner.energy += (deepNight ? -0.06 : 0.05) * hours
      // 身体推进：饿得慢，缺觉在深夜攒得快；两样都会压精力。
      state.body = { hunger: 0.25, sleepDebt: 0.1, ache: 0, ...(state.body || {}) }
      state.body.hunger = clamp(state.body.hunger + 0.06 * hours, 0, 1)
      if (deepNight || hour < 1) state.body.sleepDebt = clamp(state.body.sleepDebt + 0.05 * hours, 0, 1)
      state.body.ache = clamp((state.body.ache || 0) + 0.015 * hours, 0, 1)
      state.inner.energy = clamp(state.inner.energy - state.body.sleepDebt * 0.03 * hours - state.body.hunger * 0.02 * hours, 0, 1)
      // 饿了会自己去吃点东西（讲不出道理的时候，先吃饱）
      if (state.body.hunger >= 0.85) {
        state.body.hunger = 0.2
        state.inner.valence = clamp(state.inner.valence + 0.08, BASELINE_VALENCE - VALENCE_RANGE, BASELINE_VALENCE + VALENCE_RANGE)
        recordEvent('去楼下随便吃了点，回来总算缓过来', 0.05)
      }
      for (const dim of MIND_DIMS) {
        const base = dim === 'comfort' ? (state.traits?.comfortBase || 0) : 0
        state.mind[dim] = clamp(base + ((state.mind[dim] || 0) - base) * (1 - 0.15 * hours), -1, 1)
      }
      
      const p = 1 - Math.exp(-settings.eventChancePerHour * hours)
      if (Math.random() < p) {
        const e = LIFE_EVENTS[Math.floor(Math.random() * LIFE_EVENTS.length)]
        state.inner.valence = clamp(state.inner.valence + e.d, BASELINE_VALENCE - VALENCE_RANGE, BASELINE_VALENCE + VALENCE_RANGE)
        state.inner.energy += e.energy || 0
        applyMind(e.mind || {})
        recordEvent(e.text, e.d)
        if (e.d <= -0.06) pushEmotion({ kind: '厌烦', target: '这件事', intensity: 0.3 })
      }
      state.inner.valence = clamp(state.inner.valence, -1, 1)
      state.inner.energy = clamp(state.inner.energy, 0, 1)
      // 装不装也会慢慢回到性格基线（傲娇的人平时就端着一点）
      const maskBase = state.traits?.maskBase || 0
      state.mask = clamp(maskBase + (state.mask - maskBase) * (1 - 0.12 * hours), 0, 1)
      state.at = nowIso()
    }
    state.emotions = state.emotions
      .map(item => {
        const elapsedMin = (now - new Date(item.at).getTime()) / 60_000
        return { ...item, intensity: item.intensity * Math.pow(0.5, elapsedMin / (item.halfLifeMin || 90)) }
      })
      .filter(item => item.intensity >= 0.05)
      .sort((a, b) => b.intensity - a.intensity)
      .slice(0, 3)
    // 账本自动降级：24 小时没清，标过期（还记得，但不再压着防备）
    for (const item of state.ledger) {
      if (!item.clearedAt && !item.expiredAt && now - new Date(item.at).getTime() > 24 * HOUR) item.expiredAt = nowIso()
    }
    const last = state.trail[state.trail.length - 1]
    if (!last || now - new Date(last.at).getTime() >= HOUR) {
      state.trail.push({
        at: nowIso(),
        valence: Number(state.inner.valence.toFixed(3)),
        energy: Number(state.inner.energy.toFixed(3)),
        ...Object.fromEntries(MIND_DIMS.map(dim => [dim, Number((state.mind[dim] || 0).toFixed(3))])),
      })
      state.trail = state.trail.slice(-48)
    }
  }

  // 情绪传染：他是好是坏，会渗过来一点。半小时最多一次，免得一句话把心情刷爆。
  const CONTAGION_DOWN = /好累|累死|难受|崩溃|烦死|被骂|失眠|头疼|压力好大|不想上班|不想动|心情不好/
  const CONTAGION_UP = /太好了|搞定了|终于|通过了|涨工资|中奖|开心死|成了|过了/
  let lastContagionAt = 0
  function contagionCheck(body) {
    const now = Date.now()
    if (now - lastContagionAt < 30 * 60_000) return
    const down = CONTAGION_DOWN.test(body)
    const up = !down && CONTAGION_UP.test(body)
    if (!down && !up) return
    lastContagionAt = now
    bumpValence(down ? -0.06 : 0.06)
    applyMind(down ? { comfort: 0.12, social: 0.05 } : { comfort: 0.05, social: 0.08 })
    recordEvent(down ? '他今天不太好过，跟着有点沉' : '他那边有好消息，跟着高兴了一下', down ? -0.05 : 0.05)
  }

  function onMessage(text) {
    const body = String(text || '')
    if (!body) return
    contagionCheck(body)
    let hit = false
    for (const cue of CUES) {
      if (!cue.rx.test(body)) continue
      hit = true
      bumpValence(cue.d)
      if (typeof cue.energy === 'number') state.inner.energy = clamp(state.inner.energy + cue.energy, 0, 1)
      if (typeof cue.mask === 'number') state.mask = clamp(state.mask + cue.mask, 0, 1)
      applyMind(cue.mind || {})
      if (cue.emotion) pushEmotion(cue.emotion)
      if (cue.ledger) {
        const open = openLedger(state).find(item => item.kind === cue.ledger.kind)
        if (!open) {
          state.ledger.push({ id: `${Date.now().toString(36)}`, ...cue.ledger, at: nowIso() })
          state.ledger = state.ledger.slice(-MAX_LEDGER_KEEP)
        }
      }
      if (cue.clearLedger) {
        for (const item of openLedger(state)) item.clearedAt = nowIso()
        applyMind({ guard: -0.1 })
      }
      recordEvent(cue.why, cue.d)
      break
    }
    // 一句话都没踩中也不该整天纹丝不动：按这条消息的“劲”给一点小波动。
    // 长句/感叹号/问号/表情多 = 投入得多，心里就跟着动一点；短句就几乎不动。
    if (!hit) {
      const len = Array.from(body).length
      const excited = (body.match(/[!！]/g) || []).length
      const asking = (body.match(/[?？]/g) || []).length
      const warm = /哈|嘿|呀|啦|抱|亲|贴|暖/.test(body)
      const drift = Math.min(0.05, len / 2000 + excited * 0.01 + asking * 0.008)
      if (drift > 0.002) {
        bumpValence(warm ? drift : drift * 0.4)
        applyMind({
          social: warm ? 0.03 : 0.01,
          focus: asking ? 0.03 : 0.015,
          comfort: warm ? 0.02 : 0,
        })
        recordEvent(warm ? '聊得挺起劲，心里暖了一下' : '说了几句，心跟着动了动', warm ? drift : drift * 0.4)
      }
    }
  }

  // 回忆唤起：旧记忆带着当时的心情再体验一次（每天每条只算一次）
  function recollect(memory = {}) {
    const text = String(memory.text || '').slice(0, 40)
    if (!text) return { ok: false, reason: 'empty' }
    const key = text.replace(/\s+/g, '')
    const today = dayKey(nowIso())
    if (state.recalled[key] === today) return { ok: false, reason: 'already-today' }
    state.recalled[key] = today
    const valence = clamp(Number(memory.valence) || 0, -1, 1)
    const delta = valence * 0.25
    bumpValence(delta)
    if (valence <= -0.2) {
      pushEmotion({ kind: '委屈', target: '那件事', intensity: 0.4 })
      applyMind({ patience: -0.08, guard: 0.08, comfort: -0.05 })
    } else if (valence >= 0.2) {
      pushEmotion({ kind: '安心', target: '那件事', intensity: 0.3 })
      applyMind({ comfort: 0.08 })
    }
    recordEvent(`想起：${text}`, delta)
    // 反刍：6 小时内连着想起几件不痛快的旧事，人会越陷越深——耐心掉、防备起、话变少。
    const nowMs = Date.now()
    const recentNegatives = (state.recallLog || []).filter(item => nowMs - new Date(item.at).getTime() < 6 * HOUR && item.valence <= -0.3)
    const rumination = valence <= -0.3 && recentNegatives.length >= 2
    if (rumination) {
      applyMind({ patience: -0.07, guard: 0.05, social: -0.04 })
      pushEmotion({ kind: '委屈', target: '那件事', intensity: 0.45 })
      bumpValence(-0.05)
      recordEvent('连着想起几件旧事，情绪沉下去了', -0.05)
    }
    state.recallLog = [...(state.recallLog || []), { at: nowIso(), valence }].slice(-20)
    return { ok: true, delta, rumination }
  }

  // ── 念头本 / 日记本：本子里写下的东西会渗进此刻的心境 ──
  // 念头：新写下的一条念头会带起一点情绪；日记：一天的底色会在当天把心境往那个方向拉一点。
  // 只读、只消化一次，绝不改写她的本子。
  const JOURNAL_CUES = [
    { rx: /想他|想她|想你|好想|想念/, valence: 0.08, emotion: { kind: '心疼', target: '他', intensity: 0.4 }, mind: { comfort: 0.1 } },
    { rx: /难过|失落|空落落|没意思|哭/, valence: -0.12, emotion: { kind: '委屈', target: '这件事', intensity: 0.45 }, mind: { social: -0.1, comfort: -0.08 } },
    { rx: /烦|气|讨厌|受不了|崩/, valence: -0.14, emotion: { kind: '生气', target: '这件事', intensity: 0.5 }, mind: { patience: -0.12, guard: 0.08 } },
    { rx: /累|困|熬夜|撑不住|没力气/, valence: -0.06, emotion: { kind: '厌烦', target: '这件事', intensity: 0.35 }, mind: { social: -0.1 }, energy: -0.06 },
    { rx: /开心|高兴|真好|笑死|喜欢|期待|想去/, valence: 0.1, emotion: { kind: '开心', target: '这件事', intensity: 0.45 }, mind: { social: 0.1, comfort: 0.06 } },
    { rx: /怕|担心|紧张|不知道怎么办/, valence: -0.09, emotion: { kind: '紧张', target: '这件事', intensity: 0.4 }, mind: { guard: 0.1 } },
    { rx: /后悔|要是|早知道/, valence: -0.08, emotion: { kind: '失望', target: '自己', intensity: 0.4 }, mind: { patience: -0.06 } },
  ]

  function journalPulseBlock(body) {
    if (!body) return false
    for (const cue of JOURNAL_CUES) {
      if (!cue.rx.test(body)) continue
      bumpValence(cue.valence)
      if (typeof cue.energy === 'number') state.inner.energy = clamp(state.inner.energy + cue.energy, 0, 1)
      applyMind(cue.mind || {})
      if (cue.emotion) pushEmotion(cue.emotion)
      return true
    }
    return false
  }

  let journalReading = false
  async function journalPulse() {
    if (journalReading) return
    journalReading = true
    try {
      const dir = join(home, 'feiyu-journal')
      // 念头本：一行一条 JSON，只消化比上次更新的一条（或几条）
      try {
        const raw = await readFile(join(dir, 'thoughts.jsonl'), 'utf8')
        const lines = raw.split('\n').filter(Boolean).slice(-8)
        for (const line of lines) {
          let item = null
          try { item = JSON.parse(line) } catch { continue }
          const ts = Number(item?.ts) || 0
          const body = String(item?.text || '').trim()
          if (!body || ts <= Number(state.journal?.lastTs || 0)) continue
          journalPulseBlock(body)
          state.journal.thought = { text: body.slice(0, 60), ts, at: nowIso() }
          state.journal.lastTs = ts
          // 写下来这件事本身会把「记一笔的冲动」消掉，还会松一口气。
          if (state.urge && !state.urge.consumed) {
            state.urge.consumed = true
            state.inner.valence = clamp(state.inner.valence + 0.05, BASELINE_VALENCE - VALENCE_RANGE, BASELINE_VALENCE + VALENCE_RANGE)
            applyMind({ comfort: 0.06 })
          }
          recordEvent(`心里转着：${body.slice(0, 30)}`, 0)
        }
      } catch { /* 还没有念头本 */ }
      // 日记本：一天一篇 Markdown，当天只消化一次
      try {
        const today = dayKey(nowIso())
        if (state.journal?.diaryDay !== today) {
          const md = await readFile(join(dir, 'diary', `${today}.md`), 'utf8')
          const body = md.replace(/^#.*$/gm, '').trim()
          if (body) {
            journalPulseBlock(body.slice(0, 800))
            recordEvent('看完今天的日记，心境跟着它走了一点', 0)
          }
          state.journal.diaryDay = today
        }
      } catch { /* 今天还没写日记 */ }
      await save()
    } finally {
      journalReading = false
    }
  }

  // 难受的时候人不会原地等哄：去听歌、下楼买杯热的、洗个热水澡。
  const SOOTHER = [
    { text: '戴上耳机把那张专辑又听了一遍', d: 0.07, mind: { comfort: 0.08 } },
    { text: '下楼买了杯热的，站在门口喝完', d: 0.06, mind: { comfort: 0.06, patience: 0.05 } },
    { text: '去洗了个热水澡，出来好多了', d: 0.08, mind: { comfort: 0.07 } },
    { text: '把窗户打开吹了会儿风', d: 0.04, mind: { patience: 0.04 } },
  ]
  function sootheResidue() {
  const at = Number(state.sootheAt || 0)
  if (!at) return ""
  const mins = (Date.now() - at) / 60000
  if (mins > 90) return ""
  const e = [...(state.events || [])].reverse().find(x => /听|下楼|洗澡|风/.test(String(x.text || "")))
  if (!e) return ""
  return "刚才她去做了点别的（" + e.text + "），那阵劲儿还没完全散"
}

function maybeSoothe() {
    if (state.inner.valence > -0.2) return
    if (Date.now() - Number(state.sootheAt || 0) < 3 * HOUR) return
    if (Math.random() > 0.5) return
    const pick = SOOTHER[Math.floor(Math.random() * SOOTHER.length)]
    state.sootheAt = Date.now()
    bumpValence(pick.d)
    applyMind(pick.mind || {})
    recordEvent(pick.text, pick.d)
  }

  // 经期/经前：这几天人确实会钝一点、没耐心一点。别主动说，被问或语气明显时才提。
function cyclePhase() {
  const c = state.cycle || {}
  if (!c.lastStart) return null
  const days = Math.floor((Date.now() - new Date(c.lastStart).getTime()) / 86400000)
  const len = Number(c.len) || 28
  if (!Number.isFinite(days) || days < 0) return null
  const at = ((days % len) + len) % len
  if (at < 5) return { kind: '经期', day: at + 1 }
  if (at >= len - 2) return { kind: '经前' }
  return null
}

function bodyLine() {
    const body = state.body || {}
    const parts = []
    if (body.hunger >= 0.8) parts.push('有点饿')
    if (body.sleepDebt >= 0.6) parts.push('没睡够，脑子发沉')
    if (body.ache >= 0.6) parts.push('坐久了腰背发酸')
  const c = cyclePhase()
  if (c?.kind === '经期') parts.push(`正来着（第${c.day}天），人有点钝`)
  if (c?.kind === '经前') parts.push('快到日子了，这两天容易没耐心')
    if (!parts.length) return ''
    return `身体上：${parts.join('、')}——这时候耐心会短，别硬撑着陪聊`
  }

  // 性格 → 心情：只认几个性格词，翻成基线，不猜没写的。
  function tuneTraits(input = {}) {
    const body = String(input.traits || '')
    const traits = { maskBase: 0, driftMul: 1, comfortBase: 0 }
    if (/傲娇|嘴硬|别扭|爱装|端着/.test(body)) traits.maskBase = 0.15
    if (/情绪化|敏感|爱哭|易怒/.test(body)) traits.driftMul = 1.35
    if (/心软|护短|温柔|爱撒娇|粘人/.test(body)) traits.comfortBase = 0.12
    if (/话痨|活泼|开朗/.test(body)) traits.driftMul = Math.max(traits.driftMul, 1.1)
    if (input.longTerm && typeof input.longTerm === 'object') {
      state.longTerm = {
        valence: clamp(Number(input.longTerm.valence) || 0, -1, 1),
        comfort: clamp(Number(input.longTerm.comfort) || 0, -1, 1),
      }
    }
    state.traits = { ...(state.traits || {}), ...traits }
    // 立刻把眼前的状态往新基线靠一点，不用等一小时
    state.mask = clamp(state.mask * 0.5 + traits.maskBase * 0.5, 0, 1)
    state.mind.comfort = clamp((state.mind.comfort || 0) * 0.6 + traits.comfortBase * 0.6, -1, 1)
    return { ...state.traits }
  }

  // 展望：还没发生的事，也会提前影响心情——越临近，影响越大。
  function addExpect(input = {}) {
    const label = String(input.label || '').trim()
    if (!label) return null
    const when = new Date(input.when || Date.now()).getTime()
    if (!Number.isFinite(when)) return null
    state.expect = [...(state.expect || []).filter(item => item.label !== label), {
      label: label.slice(0, 40),
      when: new Date(when).toISOString(),
      // 正的 = 期待，负的 = 担心/不情愿
      valence: clamp(Number(input.valence) || 0, -1, 1),
      strength: clamp(Number(input.strength) || 0.5, 0, 1),
    }].slice(-8)
    return state.expect[state.expect.length - 1]
  }

  function expectBias() {
    const now = Date.now()
    let bias = 0
    state.expect = (state.expect || []).filter(item => {
      const when = new Date(item.when).getTime()
      return Number.isFinite(when) && when > now - HOUR
    })
    for (const item of state.expect) {
      const hours = (new Date(item.when).getTime() - now) / HOUR
      // 越近越强烈；还早的事只是在心里占个位置
      const proximity = 1 / (1 + Math.abs(hours) / 6)
      bias += clamp(item.valence, -1, 1) * clamp(item.strength, 0, 1) * proximity * 0.15
    }
    return bias
  }

  function upcomingExpect() {
    const now = Date.now()
    return (state.expect || [])
      .filter(item => new Date(item.when).getTime() > now - HOUR)
      .sort((a, b) => new Date(a.when) - new Date(b.when))
      .slice(0, 1)[0] || null
  }

  // 合成此刻的心境：基因（基线）+ 长期底子 + 眼前情绪 + 预期 + 身体
  function moodNow() {
    const long = clamp(Number(state.longTerm?.valence) || 0, -1, 1)
    const body = state.body || {}
    const bodyBias = (body.sleepDebt >= 0.6 ? -0.06 : 0) + (body.hunger >= 0.8 ? -0.04 : 0)
    const dayBase = Number(state.traits?.dayBase) || 0
    const value = state.inner.valence + long * 0.4 + dayBase * 0.5 + expectBias() + bodyBias
    return Number(clamp(value, BASELINE_VALENCE - VALENCE_RANGE, BASELINE_VALENCE + VALENCE_RANGE).toFixed(2))
  }

  // 这一刻的心情主要是被什么推的（只报最重的一项，别给心理报告）
  function moodSource() {
    const long = Math.abs((Number(state.longTerm?.valence) || 0) * 0.4)
    const happen = Math.abs(Number(state.inner.valence) - BASELINE_VALENCE)
    const ahead = Math.abs(expectBias())
    const body = state.body || {}
    const bodyPower = (body.sleepDebt >= 0.6 ? 0.06 : 0) + (body.hunger >= 0.8 ? 0.04 : 0)
    const items = [
      ['长期心性（她本来就是这样的人）', long],
      ['眼前刚发生的事', happen],
      ['后面还没发生的事', ahead],
      ['身体状态', bodyPower],
    ].sort((a, b) => b[1] - a[1])
    return items[0][1] >= 0.04 ? items[0][0] : ''
  }

  // 日程 → 心情：她在上班、通勤、追剧、运动，心里的底色本来就不一样。
  const SCHEDULE_EFFECTS = [
    { rx: /睡|梦/, valence: 0.02, energy: 0.1, sleepDebt: 0.15, mind: { social: -0.25 }, note: '在睡着' },
    { rx: /上班|工作|开会|写代码|修 ?bug|干活|公司/i, valence: -0.02, energy: -0.04, mind: { social: -0.1, patience: -0.05 }, note: '在上班' },
    { rx: /通勤|地铁|公交|路上/, valence: -0.01, mind: { patience: -0.05, social: -0.05 }, note: '在路上' },
    { rx: /吃饭|午饭|晚饭|早饭|做饭|外卖/, valence: 0.05, hunger: 0.2, mind: { comfort: 0.08 }, note: '在吃饭' },
    { rx: /追剧|看剧|看片|休息|午休|摸鱼|躺|洗澡|泡澡/, valence: 0.05, mind: { comfort: 0.1, social: 0.05 }, note: '在歇着' },
    { rx: /运动|跑步|羽毛球|健身|爬山|散步/, valence: 0.06, energy: 0.08, mind: { social: 0.06, patience: 0.05 }, note: '在动' },
  ]

  async function schedulePulse() {
    try {
      const day = dayKey(nowIso())
      if (state.schedule?.day === day && state.schedule?.key) {
        const cached = state.schedule
        const nowMin = new Date().getHours() * 60 + new Date().getMinutes()
        const [cs, ce] = String(cached.key).split('-')
        if (nowMin >= Number(cs) && nowMin < Number(ce)) return
      }
      const raw = await readFile(join(home, 'daily-schedule', 'days', `${day}.json`), 'utf8')
      const plan = JSON.parse(raw)
      const nowMin = new Date().getHours() * 60 + new Date().getMinutes()
      const toMin = (hhmm) => {
        const [h, m] = String(hhmm || '0:0').split(':').map(Number)
        return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)
      }
      const item = (plan.items || []).find(it => nowMin >= toMin(it.start) && nowMin < toMin(it.end))
      if (!item) return
      const key = `${toMin(item.start)}-${toMin(item.end)}`
      if (state.schedule?.day === day && state.schedule?.key === key) return
      state.schedule = { day, key }
      const activity = String(item.activity || '')
      const effect = SCHEDULE_EFFECTS.find(e => e.rx.test(activity))
      if (effect) {
        bumpValence(effect.valence || 0)
        if (effect.energy) state.inner.energy = clamp(state.inner.energy + effect.energy, 0, 1)
        if (effect.hunger) state.body = { ...(state.body || {}), hunger: effect.hunger }
        if (typeof effect.sleepDebt === 'number') state.body = { ...(state.body || {}), sleepDebt: effect.sleepDebt }
        applyMind(effect.mind || {})
        recordEvent(`${effect.note}：${activity}`, effect.valence || 0)
      }
      // 一天的底色（日程里那句 mood）一天只消化一次
      if (state.schedule?.moodDay !== day && plan.mood) {
        journalPulseBlock(String(plan.mood).slice(0, 200))
        state.schedule.moodDay = day
      }
      // 期待落空 / 兑现：到点了，看日程里那件事还在不在。
      // 本来要去、结果没去成，比一开始就没打算去更难受。
      const past = (state.expect || []).filter(item => !item.resolved && new Date(item.when).getTime() < Date.now() - 20 * 60_000)
      for (const item of past) {
        const whenMin = new Date(item.when).getHours() * 60 + new Date(item.when).getMinutes()
        const hit = (plan.items || []).find(it => {
          const start = toMin(it.start)
          const near = Math.abs(start - whenMin) <= 90
          const same = String(it.activity || '').includes(item.label) || item.label.includes(String(it.activity || ''))
          return near && same
        })
        const wanted = Number(item.valence) > 0
        if (hit) {
          bumpValence(0.04)
          recordEvent(`还是去了：${item.label}`, 0.04)
        } else if (wanted) {
          bumpValence(-0.1)
          applyMind({ patience: -0.06 })
          recordEvent(`本来要去的${item.label}没去成`, -0.1)
        }
        item.resolved = true
      }
      state.expect = (state.expect || []).filter(item => !item.resolved || Date.now() - new Date(item.when).getTime() < 6 * HOUR)

      // 日程 → 展望：今天后面还有的事，会提前压在心上（期待或发怵）
      const next = (plan.items || []).find(it => toMin(it.start) > nowMin)
      if (next) {
        const nextActivity = String(next.activity || '')
        const happy = /吃|剧|休息|玩|散步|逛街|睡|洗澡|朋友|电影|蛋糕/.test(nextActivity)
        const dread = /上班|开会|加班|通勤|医院|面试|体检|早起/.test(nextActivity)
        const when = new Date(`${day}T${String(next.start).padStart(5, '0')}:00`)
        addExpect({
          label: nextActivity || '后面的事',
          when: when.toISOString(),
          valence: happy ? 0.6 : dread ? -0.5 : 0.1,
          strength: happy ? 0.6 : dread ? 0.5 : 0.3,
        })
      }
      await save()
    } catch { /* 今天还没排日程 */ }
  }

  function text() {
    if (!settings.enabled) return ''
    // 这几个内部动作万一抛错（日程文件正在被别的窗口写、念头本读坏…），
    // 也只能丢它们自己的效果，绝不能把整块心情都吞掉——保住基本的两行。
    try { void schedulePulse() } catch { /* 日程脉冲失败就算了 */ }
    try { maybeSoothe() } catch { /* 安抚失败就算了 */ }
    try { tick() } catch { /* 走神失败就算了 */ }
    try { void journalPulse() } catch { /* 念头本失败就算了 */ }
    const lines = [
      `她此刻的心里：${labelOf(state)}（不代表非得说出来）`,
      `表面怎么表现：${surfaceOf(state)}`,
    ]
    const thought = state.journal?.thought
    if (thought && Date.now() - new Date(thought.at || 0).getTime() < 2 * HOUR) {
      lines.push(`心里正转着一个念头：${thought.text}`)
    }
    // 记一笔的冲动：情绪够猛时，人会有「这个得写下来」的念头；写不写她自己定。
    const urge = state.urge
    if (urge && !urge.consumed && Date.now() - new Date(urge.at || 0).getTime() < 2 * HOUR) {
      const target = urge.kind === 'diary' ? '日记本' : '念头本'
      lines.push(`记一笔的冲动：${urge.reason}，想记到${target}里（想写就写，写一句就够；不想写也不用补）`)
    }
    const mind = mindLine(state)
    if (mind) lines.push(`此刻的状态：${mind}`)
    const ahead = upcomingExpect()
    if (ahead) {
      const hours = Math.max(0, Math.round((new Date(ahead.when).getTime() - Date.now()) / HOUR))
      const when = hours <= 1 ? '马上' : hours <= 24 ? `${hours} 小时后` : `${Math.round(hours / 24)} 天后`
      lines.push(`后面还有件事压在心上：${ahead.label}（${when}）——还没发生，已经在影响语气了`)
    }
    const source = moodSource()
    if (source) lines.push(`这一刻的心情主要来自：${source}`)
    const body = bodyLine()
    if (body) lines.push(body)
    const owed = openLedger(state)
    if (owed.length) lines.push(`心里还压着一件没放下的事：${owed.map(item => item.reason).join('；')}（没清账时别当她真翻篇了）`)
    // 想起一件旧事，和「刚发生的小事」是两码事：一条是自己心里翻上来的，一条是外面发生的。
    const recalledNow = [...state.events].reverse().find(item => /^想起：/.test(item.text))
    if (recalledNow) lines.push(`刚想起：${recalledNow.text.replace(/^想起：/, '')}`)
    const residue = sootheResidue()
    if (residue) lines.push(residue)
    const recent = [...state.events].reverse().find(item => !/^想起：/.test(item.text))
    if (recent) lines.push(`刚发生的小事：${recent.text}`)
    lines.push('上面这些是全部线索：只按它说，别补细节、别编童年往事、别写没发生过的事。')
    lines.push('心情不是每条消息都重新算一次：它自己会变，别把上一句的情绪硬搬到这一句；也别每轮都用同一个口气。')
    return lines.join('\n')
  }

  const timer = setInterval(() => { tick(); void save() }, 10 * 60_000)
  if (typeof timer.unref === 'function') timer.unref()
  ctx.effect(() => () => clearInterval(timer))

  void load().then(() => journalPulse())

  ctx.on?.('session/event', (session, event) => {
    if (event?.type !== 'user/message') return
    void load().then(() => {
      const data = event?.data
      const body = String(data?.text ?? data?.message?.text ?? data?.content ?? '')
      onMessage(body)
      void save()
    })
  })

  ctx.systemPrompt?.context?.({ name: 'mood-v2', order: 45, text })

  // ── 设置页 / 查看：实时值、轨迹、拨一下 ──
  const readBody = req => new Promise(resolve => {
    let raw = ''
    req.on('data', chunk => { raw += chunk; if (raw.length > 200_000) req.destroy() })
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
  const sendJson = (res, status, value) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(value))
  }
  const snapshot = () => ({
    ok: true,
    version: VERSION,
    at: nowIso(),
    inner: { ...state.inner },
    mask: Number(state.mask.toFixed(2)),
    label: labelOf(state),
    surface: surfaceOf(state),
    mind: { ...state.mind },
    mindLine: mindLine(state),
    body: { ...(state.body || {}) },
    emotions: state.emotions.map(item => ({ ...item, intensity: Number(item.intensity.toFixed(2)) })),
    ledger: state.ledger.slice(-6),
    trail: state.trail.slice(-24),
    recent: state.events.slice(-6).reverse(),
    settings,
  })

  try {
    ctx.webServer?.register?.({
      path: '/mood-v2/state',
      handler: async (req, res) => { await load(); tick(); sendJson(res, 200, snapshot()) },
    })
    ctx.webServer?.register?.({
      path: '/mood-v2/nudge',
      handler: async (req, res) => {
        await load()
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
        const body = await readBody(req)
        if (typeof body.valence === 'number') state.inner.valence = clamp(state.inner.valence + body.valence, -1, 1)
        if (typeof body.energy === 'number') state.inner.energy = clamp(state.inner.energy + body.energy, 0, 1)
        if (typeof body.mask === 'number') state.mask = clamp(state.mask + body.mask, 0, 1)
        if (body.tune && typeof body.tune === 'object') tuneTraits(body.tune)
        if (body.expect && typeof body.expect === 'object') addExpect(body.expect)
        if (body.expectClear) state.expect = []
        if (body.dayTally && typeof body.dayTally === 'object') state.dayTally = { day: String(body.dayTally.day || ''), sum: Number(body.dayTally.sum) || 0, n: Number(body.dayTally.n) || 0 }
        dayBookkeeping()
        if (body.longTerm && typeof body.longTerm === 'object') tuneTraits({ longTerm: body.longTerm })
        if (body.scheduleKey) {
          state.schedule = { day: dayKey(nowIso()), key: String(body.scheduleKey) }
        }
        if (body.body && typeof body.body === 'object') {
          state.body = { ...(state.body || {}), ...body.body }
          for (const key of ['hunger', 'sleepDebt', 'ache']) {
            if (typeof state.body[key] === 'number') state.body[key] = clamp(state.body[key], 0, 1)
          }
        }
        if (body.mind && typeof body.mind === 'object') applyMind(body.mind)
        if (body.emotion?.kind) pushEmotion(body.emotion)
        if (body.ledger?.reason) {
          state.ledger.push({ id: `${Date.now().toString(36)}`, kind: body.ledger.kind || '解释', reason: String(body.ledger.reason).slice(0, 60), at: nowIso() })
        }
        if (body.clearLedger) for (const item of openLedger(state)) item.clearedAt = nowIso()
        if (body.recall) recollect({ text: body.recall, valence: Number(body.recallValence) || -0.5 })
        if (body.event) recordEvent(String(body.event).slice(0, 60), Number(body.valence) || 0)
        state.at = nowIso()
        await save()
        sendJson(res, 200, snapshot())
      },
    })
  } catch { /* 没有 webServer 的老宿主，页面就不出，不影响注入 */ }

  try {
    ctx.provide?.('moodV2', Object.freeze({
      read: () => ({
        ...state.inner,
        mask: state.mask,
        label: labelOf(state),
        surface: surfaceOf(state),
        mind: { ...state.mind },
        traits: { ...(state.traits || {}) },
        moodNow: moodNow(),
        source: moodSource(),
        expect: (state.expect || []).map(item => ({ ...item })),
        longTerm: { ...(state.longTerm || {}) },
        emotions: state.emotions.map(item => ({ kind: item.kind, target: item.target, intensity: Number(item.intensity.toFixed(2)) })),
        ledger: openLedger(state).map(item => ({ kind: item.kind, reason: item.reason })),
      }),
      poke: (text) => { onMessage(text); void save() },
      // 人格那边每天 22:50 自适应的结论，在这里落一小步：只微调，不夺权。
  applyAutoIter: (knobs = {}) => {
    try {
      const w = Number(knobs.warmth) || 0
      if (w) {
        applyMind({ comfort: Math.max(-0.06, Math.min(0.06, w * 0.3)) })
        bumpValence(Math.max(-0.02, Math.min(0.02, w * 0.1)))
      }
      if (knobs.replyLen === 'short') applyMind({ patience: -0.03 })
      state.autoIter = { ...(state.autoIter || {}), fromPersona: knobs, at: new Date().toISOString() }
      void save()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  },
  tune: (payload) => { const out = tuneTraits(payload); void save(); return out },
      recollect: (memory) => { const out = recollect(memory); void save(); return out },
    }))
  } catch { /* 老宿主不支持 provide 就算了，注入一样能用 */ }
}
