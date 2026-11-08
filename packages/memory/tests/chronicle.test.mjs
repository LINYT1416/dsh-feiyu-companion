/** 编年史折叠单测：天→月→年，长度有上限、内容不重复、顺序稳定。 */
import assert from 'node:assert/strict'
import { monthOf, yearOf, rollupMonths, rollupYears } from '../chronicle.js'

// 1) 键抽取
assert.equal(monthOf('2026-11-03'), '2026-11')
assert.equal(monthOf('坏数据'), '')
assert.equal(yearOf('2026-11'), '2026')
assert.equal(yearOf(''), '')

// 2) 折月：同月合并，重复句子只留一次
const days = [
  { day: '2026-11-01', text: '接入 QQ；修记忆隔离' },
  { day: '2026-11-02', text: '接入 QQ；做编年史' },
  { day: '2026-12-01', text: '收尾测试' }
]
const months = rollupMonths(days)
assert.equal(months.length, 2, '应折出两个月')
assert.equal(months[0].period, '2026-11')
assert.equal(months[0].days, 2)
const novPieces = months[0].text.split('；')
assert.equal(novPieces.filter(piece => piece === '接入 QQ').length, 1, '重复句子只留一次')
assert.ok(novPieces.includes('做编年史') && novPieces.includes('修记忆隔离'), '应保留当月各天内容')

// 3) 折年：从月记再折一层
const years = rollupYears(months)
assert.equal(years.length, 1, '两个月都在 2026 年')
assert.equal(years[0].period, '2026')
assert.equal(years[0].months, 2)
assert.ok(years[0].text.includes('接入 QQ'))

// 4) 长度上限：塞很多天也不会爆
const many = Array.from({ length: 40 }, (_, i) => ({ day: `2026-11-${String((i % 28) + 1).padStart(2, '0')}`, text: `第${i}件事的详细描述内容` }))
const capped = rollupMonths(many, { maxChars: 120 })
assert.equal(capped.length, 1)
assert.ok(capped[0].text.length <= 120, `折月后不得超过上限：${capped[0].text.length}`)

// 5) 空输入不炸
assert.deepEqual(rollupMonths([]), [])
assert.deepEqual(rollupYears([]), [])
assert.deepEqual(rollupMonths(null), [])
assert.deepEqual(rollupYears(undefined), [])

console.log('chronicle test: all assertions passed')
