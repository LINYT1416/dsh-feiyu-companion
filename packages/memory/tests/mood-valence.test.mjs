/**
 * 老记忆的心情补效价：只有 0-100 分数时，换算成 -1..1，情绪加权才用得上。
 */
import assert from 'node:assert/strict'

const mod = await import('../index.js')
const data = {
  facts: [
    { text: '老记忆 A', mood: { score: 90, label: '很好' } },
    { text: '老记忆 B', mood: { score: 20, label: '低落' } },
    { text: '新记忆 C', mood: { score: 50, valence: 0.1 } },
    { text: '没心情的 D' },
  ],
  profile: [{ text: '老画像', mood: { score: 75 } }],
  episodes: [],
  diary: [],
}

const count = mod.backfillMoodValence(data)
assert.equal(count, 3, `应该只补 3 条（A/B/画像），实际 ${count}`)
assert.equal(data.facts[0].mood.valence, 0.8)
assert.equal(data.facts[1].mood.valence, -0.6)
assert.equal(data.facts[2].mood.valence, 0.1, '已有 valence 不能覆盖')
assert.equal(data.profile[0].mood.valence, 0.5)

// 幂等：再跑一次不该有变化
assert.equal(mod.backfillMoodValence(data), 0)
assert.equal(data.facts[0].mood.valence, 0.8)

// 分数缺失时跳过，不硬编
assert.equal(mod.backfillMoodValence({ facts: [{ text: 'x', mood: { label: '好' } }] }), 0)

console.log('mood valence backfill test: all assertions passed')
