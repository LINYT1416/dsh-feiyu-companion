/** 自述抽取与“像人话”判定的回归：重点挡住「我有个疑问」这类空话。 */
import assert from 'node:assert/strict'
import { extractSelfFacts, looksLikeSpeech } from '../extract.js'

// 1) 该记的事实要抓到
assert.deepEqual(extractSelfFacts('我养了一只叫年糕的猫'), ['我养了一只叫年糕的猫'])
assert.ok(extractSelfFacts('我住在杭州').length === 1)
assert.ok(extractSelfFacts('我叫大肥鱼').length === 1)
assert.ok(extractSelfFacts('我喜欢用简短的说明').length === 1)
assert.ok(extractSelfFacts('我的生日是三月').length === 1)
assert.ok(extractSelfFacts('我不吃香菜').length === 1)

// 2) 空话、提问、临时状态一律不收（截图里那个问题）
for (const bad of ['我有个疑问', '我有个问题想问你', '我想问一下这个怎么弄', '我觉得这个插件还行', '我刚才试了一下', '我有点累', '现在我在写代码吗？', '我看看']) {
  assert.deepEqual(extractSelfFacts(bad), [], `不该记：${bad}`)
}

// 3) 半截话不收（动词后面没内容）
for (const bad of ['我住在', '我喜欢', '我的名字是']) {
  assert.deepEqual(extractSelfFacts(bad), [], `半截话不该记：${bad}`)
}

// 4) 一句话最多两条，且去重
const two = extractSelfFacts('我叫大肥鱼，我喜欢喝冰可乐，我住在杭州')
assert.ok(two.length <= 2, `最多两条：${JSON.stringify(two)}`)
assert.equal(new Set(two).size, two.length)

// 5) 编年史判定：纯应答/纯短问句不进日记
for (const bad of ['继续', '好', '嗯嗯', '收到', '在吗？', '真的吗', '我有个疑问']) {
  assert.equal(looksLikeSpeech(bad), false, `不该进日记：${bad}`)
}
// 有信息量的话要进去
for (const good of ['帮我接入qq，这个地址打不开', '现在最大的问题是各个对话间别窜记忆', '我要用snowluma，你帮我部署']) {
  assert.equal(looksLikeSpeech(good), true, `应该进日记：${good}`)
}
// 命令行/路径仍然挡住
assert.equal(looksLikeSpeech('pwsh -Command Get-Process'), false)

// 6) 长度门槛可调
assert.equal(looksLikeSpeech('你好呀', { minChars: 2 }), true)
assert.equal(looksLikeSpeech('你好呀', { minChars: 8 }), false)

console.log('extract test: all assertions passed')
