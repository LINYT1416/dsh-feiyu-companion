/** 线索解析单测：模型只说名称，日期与状态由我核对；查不到的名字一律丢掉。 */
import assert from 'node:assert/strict'
import { buildThreadsPrompt, parseThreads, threadsSignature } from '../threads.js'

const days = [
  { day: '2026-11-02', text: '接入 QQ，部署 SnowLuma' },
  { day: '2026-11-03', text: '记忆插件别窜记忆，继续迭代' },
  { day: '2026-11-04', text: '修好记忆插件的摘要覆盖，验证缓存' }
]

// 1) 提示词：只要名称，用顿号分隔
const prompt = buildThreadsPrompt(days)
assert.match(prompt, /2026-11-02：/)
assert.match(prompt, /顿号/)
assert.match(prompt, /不要写「继续」/)
assert.equal(buildThreadsPrompt(days.slice(0, 1)), '', '不足两天不提问')

// 2) 正常输出：一句「A、B」→ 日期由日记核对
const ok = parseThreads('记忆插件、QQ', days)
assert.equal(ok.length, 2)
const memory = ok.find(item => item.name === '记忆插件')
assert.equal(memory.firstDay, '2026-11-03')
assert.equal(memory.lastDay, '2026-11-04')
assert.equal(memory.days, 2)
assert.equal(memory.status, '进行中')

// 3) 编造的名字 / 添油加醋的名字 → 丢掉
const invented = parseThreads('量化交易、记忆插件、B站即时事件', days)
assert.deepEqual(invented.map(item => item.name), ['记忆插件'])

// 4) 空词、行首编号、括号注释、句末标点都能处理
const junk = parseThreads('1. 继续、2. 验证、3. 记忆插件（重要）。', days)
assert.deepEqual(junk.map(item => item.name), ['记忆插件'])

// 5) 去重 + 上限 3 + 最近提过的排前面
const many = parseThreads('记忆插件、记忆插件、QQ、SnowLuma、缓存', days)
assert.ok(many.length <= 3)
assert.equal(new Set(many.map(item => item.name)).size, many.length)
assert.equal(many[0].lastDay, '2026-11-04', '最近提过的排前面')

// 6) 签名只随输入变
assert.equal(threadsSignature(days), threadsSignature([...days].reverse()))
assert.notEqual(threadsSignature(days), threadsSignature(days.slice(0, 2)))

console.log('threads test: all assertions passed')
