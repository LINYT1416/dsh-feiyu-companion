// 按本人授权：把 Companion 的人格写进 QQ 桥配置（人设开=true），写前留备份。
import { readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const cfgPath = join(home, 'qq-bridge-config.json')
const api = 'http://127.0.0.1:52642/silicon-life-companion/persona/push-qq'

const info = await (await fetch(api)).json()
const text = String(info.text || '').trim()
if (!text) {
  console.log('ABORT: 人格文本是空的')
  process.exit(1)
}
if (text.length > 20000) {
  console.log('ABORT: 文本太长', text.length)
  process.exit(1)
}

const raw = JSON.parse(readFileSync(cfgPath, 'utf8'))
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = `${cfgPath}.companion-bak-${stamp}`
copyFileSync(cfgPath, backup)
console.log('backup ->', backup)
console.log('before: 人设开=', raw['人设开'], ' 人设len=', String(raw['人设'] || '').length, ' 前30=', String(raw['人设'] || '').slice(0, 30))

const next = { ...raw, 人设开: true, 人设: text }
const tmp = `${cfgPath}.tmp`
writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
renameSync(tmp, cfgPath)

const check = JSON.parse(readFileSync(cfgPath, 'utf8'))
console.log('after: 人设开=', check['人设开'], ' 人设len=', String(check['人设'] || '').length)
console.log('after 前60=', String(check['人设'] || '').slice(0, 60))
console.log('其他字段仍在:', Object.keys(check).length, '个；总开关=', check['总开关'])
