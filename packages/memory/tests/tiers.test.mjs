/**
 * 记忆分层回归（纯函数，不需要宿主）
 * 覆盖：重要性打分、层级判定、时间推演、升级条件。
 */
import assert from 'node:assert/strict'
import { scoreImportance, classifyTier, tierOfRow, summarizeTiers, shouldPromote, TIER_CUT, TIER_INSTANT_MS } from '../tiers.js'

const DAY = 86400000
const now = Date.now()

// 1) 显式托付 > 自述 > 普通闲聊 > 纯应答
const explicit = scoreImportance('记住：我不吃香菜，这是底线')
const selfTalk = scoreImportance('我养了一只叫年糕的猫')
const plain = scoreImportance('今天天气还行我们去看看那个视频')
const ack = scoreImportance('继续')
assert.ok(explicit > selfTalk, `显式托付应高于自述：${explicit} vs ${selfTalk}`)
assert.ok(selfTalk > plain, `自述应高于普通闲聊：${selfTalk} vs ${plain}`)
assert.ok(plain > ack, `普通闲聊应高于纯应答：${plain} vs ${ack}`)
assert.ok(ack < TIER_CUT.short, '纯应答必须落在低价值区')

// 2) 反复提起会加权
const once = scoreImportance('想给大肥鱼做记忆分层', { relatedTexts: [] })
const many = scoreImportance('想给大肥鱼做记忆分层', { relatedTexts: ['想给大肥鱼做记忆分层这件事', '想给大肥鱼做记忆分层，别忘', '想给大肥鱼做记忆分层啊'] })
assert.ok(many > once, `反复提起应更高：${many} vs ${once}`)

// 3) 情绪强度参与打分（和鱼的心情联动）
const calm = scoreImportance('这个功能做完了', { moodScore: 50 })
const intense = scoreImportance('这个功能做完了', { moodScore: 95 })
assert.ok(intense > calm, `情绪浓时应更高：${intense} vs ${calm}`)

// 4) 分层：分数定天花板
assert.equal(classifyTier(TIER_CUT.permanent, 0, 7 * DAY), 'permanent')
assert.equal(classifyTier(TIER_CUT.long, 0, 7 * DAY), 'long')
assert.equal(classifyTier(0.2, TIER_INSTANT_MS - 1000, 7 * DAY), 'instant', '刚发生且在窗口内是瞬时')
assert.equal(classifyTier(0.2, TIER_INSTANT_MS + 1000, 7 * DAY), 'short', '过了瞬时窗口进短期')
assert.equal(classifyTier(0.4, 30 * DAY, 7 * DAY), 'long', '过了短期窗口但有点价值的归档成长期')
assert.equal(classifyTier(0.1, 30 * DAY, 7 * DAY), 'instant', '没价值的自然淡掉')

// 5) 行级判定：读 row.importance，缺省用文本重算
const rowPermanent = { role: 'user', text: '记住：以后都要先给结论', importance: 0.95, at: new Date(now).toISOString() }
assert.equal(tierOfRow(rowPermanent, { sevenDayMs: 7 * DAY, nowMs: now }), 'permanent')
const rowOld = { role: 'user', text: '普通一句话聊聊那个东西', at: new Date(now - 30 * DAY).toISOString() }
assert.equal(tierOfRow(rowOld, { sevenDayMs: 7 * DAY, nowMs: now }), 'instant', '老且不重要的应淡掉')

// 6) 汇总
const counts = summarizeTiers([
  rowPermanent,
  { role: 'user', text: '刚说的临时事', at: new Date(now).toISOString() },
  { role: 'user', text: '记住：别乱动配置', importance: 0.9, at: new Date(now - 20 * DAY).toISOString() }
], { sevenDayMs: 7 * DAY, nowMs: now })
assert.equal(counts.total, 3)
assert.ok(counts.permanent >= 2, `永久层应有 2 条：${JSON.stringify(counts)}`)
assert.equal(counts.instant, 1)

// 7) 只有 user 行才谈得上升级
assert.equal(shouldPromote(rowPermanent, { sevenDayMs: 7 * DAY, nowMs: now }), true)
assert.equal(shouldPromote({ role: 'assistant', text: '记住：x', importance: 0.95 }, {}), false)

console.log('tiers test: all assertions passed')
