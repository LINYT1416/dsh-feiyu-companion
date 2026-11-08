// 记忆检索自测：固定用例，跑一遍就知道排序有没有退化。
//   node memory-selftest.mjs
// 输出 PASS/FAIL，退出码 0/1（可以挂到定时任务里，天天跑一次）。
import * as E from './memory-engine.js'

const docs = [
  '主人的B站账号 uid 123456789，昵称 示例昵称',
  '我决定语音选 GPT-SoVITS，本地 9880 端口跑着',
  '谷时刷 B 站这条已经跑通，评论能发出去，主人实测收到一条',
  '今天中午吃了米线，汤有点咸辣子很香',
  '主人在群里让我别乱@人，只在真要回某句时用',
  '明天要去公司加班，下午三点开会',
  '主人喜欢夜跑和羽毛球',
  '主人的同事叫小张，一起做插件',
  '记忆插件三层已经落地：原子、衰减、双路检索',
  'B站评论接口用 surfcore 的 bili.mjs，先 --dry 再 --go',
]

// 和 index.js 里完全一样的排序流程：双路召回 → RRF → 归一化 → 相关/重要/新鲜 + 意图加成
function rank(query) {
  const idx = E.makeIndex(docs.map((text) => ({ text })))
  const vi = E.makeVectorIndex(docs)
  const fused = E.rrf([idx.search(query, 12), vi.search(query, 12)])
  if (!fused.length) return []
  const max = Math.max(...fused.map((x) => x.score)) || 1
  const rel = new Map(fused.map((x) => [x.id, x.score / max]))
  return docs
    .map((d, i) => ({
      d,
      s: E.finalScore({ rel: rel.get(i) ?? 0, importance: 0.5, ageDays: 1 }) + E.intentBonus(query, d),
    }))
    .sort((a, b) => b.s - a.s)
}

const cases = [
  ['主人的B站账号是多少', 'uid 123456789'],
  ['语音用的什么方案', 'GPT-SoVITS'],
  ['B站评论怎么发', 'surfcore'],
  ['今天中午吃了什么', '米线'],
  ['明天有什么安排', '明天要去公司'],
  ['主人喜欢什么运动', '夜跑和羽毛球'],
  ['主人的同事是谁', '同事叫小张'],
  ['记忆插件做到哪了', '三层已经落地'],
]

let 过 = 0
const 失败 = []
for (const [q, 期望] of cases) {
  const top = rank(q)
  const hit = top.length > 0 && top[0].d.includes(期望)
  if (hit) {
    过 += 1
    console.log(`PASS  ${q} → ${top[0].d.slice(0, 34)}`)
  } else {
    失败.push(q)
    console.log(`FAIL  ${q} → 期望含「${期望}」，实际第一是「${top[0]?.d?.slice(0, 34) ?? '(空)'}」`)
  }
}

// 附加检查：原子寿命与状态机
const 寿命 = [
  ['B站 uid 123456789', '事实', 180],
  ['我明天要去公司', '计划', 2],
  ['今天中午吃了米线', '事件', 7],
  ['我喜欢夜跑', '偏好', 60],
  ['主人的同事叫小张', '事实', 180],
  ['我就是一条鱼', '未知', 30],
]
for (const [s, 类型, 天] of 寿命) {
  const a = E.toAtoms(s)[0]
  const ok = a.type === 类型 && a.ttlDays === 天
  if (ok) 过 += 1
  else 失败.push(`原子类型: ${s}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  原子「${s}」→ ${a.type} ${a.ttlDays}天（期望 ${类型} ${天}天）`)
}

console.log(`\n共 ${cases.length + 寿命.length} 项，过 ${过}，败 ${失败.length}`)
if (失败.length) {
  console.log('没过的：' + 失败.join('；'))
  process.exit(1)
}
