/** 模型润色的提示词与清理逻辑单测（纯函数，不调模型、不花钱）。 */
import assert from 'node:assert/strict'
import { hashInputs, buildRollupPrompt, cleanSummary, shouldAcceptSummary } from '../summary.js'

// 1) 哈希：同输入同值，不同输入不同值
assert.equal(hashInputs('abc'), hashInputs('abc'))
assert.notEqual(hashInputs('abc'), hashInputs('abd'))
assert.equal(typeof hashInputs(''), 'string')

// 2) 提示词：带上时间、原文、约束；年度比月度更长
const monthPrompt = buildRollupPrompt({ period: '2026-11', kind: 'month', text: '接入qq；修记忆隔离' })
assert.match(monthPrompt, /2026-11/)
assert.match(monthPrompt, /接入qq/)
assert.match(monthPrompt, /第一人称/)
assert.match(monthPrompt, /不要编造/)
const yearPrompt = buildRollupPrompt({ period: '2026', kind: 'year', text: 'x', days: 30 })
assert.match(yearPrompt, /2026 这一年/)
assert.ok(yearPrompt.match(/不超过 (\d+) 个字/)[1] === '90', '年表允许更长')
assert.ok(monthPrompt.match(/不超过 (\d+) 个字/)[1] === '70', '月记更短')

// 3) 人格会进提示词，但被截断
const withPersona = buildRollupPrompt({ period: '2026-11', kind: 'month', text: 'x', persona: '大肥鱼'.repeat(100) })
assert.ok(withPersona.length < 1600, '人格不能把提示词撑爆')

// 4) 输出清理：去引号、去前缀、压空白、截断
assert.equal(cleanSummary('“这段我们一起修记忆。”'), '这段我们一起修记忆。')
assert.equal(cleanSummary('摘要：接入 QQ 那天'), '接入 QQ 那天')
assert.equal(cleanSummary('  一段   话  '), '一段 话')
assert.ok(cleanSummary('长'.repeat(200), { maxChars: 20 }).length <= 21)

// 5) 接受判定：太短/拒答/原样吐回都不接受
assert.equal(shouldAcceptSummary('好', 'fallback'), false, '太短不接受')
assert.equal(shouldAcceptSummary('抱歉，我无法完成', 'fallback'), false, '拒答不接受')
assert.equal(shouldAcceptSummary('接入qq；修记忆隔离', '接入qq；修记忆隔离'), false, '原样吐回不接受')
assert.equal(shouldAcceptSummary('那几天我们一直在折腾 QQ 接入，顺手把记忆隔离修了。', '接入qq；修记忆隔离'), true)

console.log('summary test: all assertions passed')
