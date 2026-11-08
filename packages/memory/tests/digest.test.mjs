/** 日记去重单测：重复的「继续迭代」不该占掉每天的日记。 */
import assert from 'node:assert/strict'
import { normalizeCore, similarity, isRepeat, pickFreshLines } from '../digest.js'

// 1) 归一化：标点、空格、大小写都不影响比较
assert.equal(normalizeCore('继续迭代，你做的还可以更好！'), '继续迭代你做的还可以更好')
assert.equal(normalizeCore('QQ 接入'), 'qq接入')
assert.equal(normalizeCore(''), '')
assert.equal(normalizeCore(null), '')

// 2) 相似度：同义重复高、不同事情低
assert.equal(similarity('继续迭代', '继续迭代'), 1)
assert.ok(similarity('继续迭代你做的还可以更好', '继续迭代，你做的还可以更好！') > 0.95)
assert.ok(similarity('继续迭代', '帮我部署 SnowLuma') < 0.2)
assert.ok(similarity('修复摘要覆盖问题', '修好摘要被覆盖的 bug') < 0.72, '不同说法不该误判成重复')
// 同一天里越补越长的同一句
assert.ok(similarity('继续迭代你做的还可以更好', '继续迭代你做的还可以更好大肥鱼我相信你') > 0.72)

// 3) 与前几天的日记比较
const previous = ['继续迭代，你做的还可以更好', '你先扩大输出token上限，然后继续']
assert.equal(isRepeat('继续迭代，你做的还可以更好', previous), true)
assert.equal(isRepeat('继续迭代', previous), true, '短句包含在旧句里也算重复')
assert.equal(isRepeat('把每日预算做成一句话能调的', previous), false)
assert.equal(isRepeat('随便', []), false, '没有历史就不算重复')

// 4) 挑新鲜句子：旧的被过滤、新的保留、当天内部去重
const today = [
  '继续迭代，你做的还可以更好',
  '继续迭代，你做的还可以更好',
  '把「每日预算」做成你一句话就能调的',
  '把每日预算 做成你一句话就能调的'
]
const fresh = pickFreshLines(today, previous)
assert.deepEqual(fresh, ['把「每日预算」做成你一句话就能调的'], `实际：${JSON.stringify(fresh)}`)

// 5) 全天都是重复 → 空（今天没有新鲜事，就不写日记）
assert.deepEqual(pickFreshLines(['继续迭代', '继续'], previous), [])

// 6) 上限生效
const many = ['新事一', '新事二', '新事三', '新事四', '新事五', '新事六', '新事七'].map((s, i) => `${s}第${i}个具体内容`)
assert.equal(pickFreshLines(many, [], { max: 3 }).length, 3)

console.log('digest test: all assertions passed')
