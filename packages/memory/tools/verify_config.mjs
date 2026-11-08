// 运行态往返验证：人格/性格/情绪设置写入→重读→恢复；护栏 & 注入内容检查。
const base = 'http://127.0.0.1:63090/silicon-life-companion'
const get = async path => (await fetch(base + path, { cache: 'no-store' })).json()
const post = async (path, body) => {
  const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, value: await response.json().catch(() => null) }
}

const before = await get('/state')
const orig = {
  personaName: before.persona.name,
  personaDescription: before.persona.description,
  personaPrompt: before.persona.systemPrompt,
  traits: before.personality.traits,
  warmth: before.personality.warmth,
  curiosity: before.personality.curiosity,
  pragmatism: before.personality.pragmatism,
  moodDecayHours: before.moodSettings.decayHours,
  injectionChars: before.settings.injectionChars,
  sevenDayDays: Math.round(before.settings.sevenDayMs / 86400000)
}
console.log('BEFORE', JSON.stringify({ name: orig.personaName, warmth: orig.warmth, decay: orig.moodDecayHours, budget: orig.injectionChars }))

const probe = { ...orig, personaName: 'Companion验证', warmth: 61, moodDecayHours: 48, injectionChars: 99999 }
const wrote = await post('/config', probe)
console.log('WRITE status', wrote.status, JSON.stringify({ name: wrote.value?.persona?.name, warmth: wrote.value?.personality?.warmth, decay: wrote.value?.moodSettings?.decayHours, budget: wrote.value?.settings?.injectionChars }))
const readback = await get('/state')
console.log('READBACK', JSON.stringify({ name: readback.persona.name, warmth: readback.personality.warmth, decay: readback.moodSettings.decayHours }))

const restored = await post('/config', orig)
console.log('RESTORE status', restored.status, JSON.stringify({ name: restored.value?.persona?.name, warmth: restored.value?.personality?.warmth, decay: restored.value?.moodSettings?.decayHours, budget: restored.value?.settings?.injectionChars, traits: restored.value?.personality?.traits }))
const injection = restored.value?.injectionPreview || ''
console.log('INJECTION persona/性格参数/七类', /我是谁/.test(injection), /性格参数/.test(injection), (restored.value?.moodSettings?.taxonomy || []).length)

const guard = await post('/clear', { confirm: 'CLEAR', buckets: ['raw'] })
console.log('RAW_CLEAR_GUARD', guard.status, guard.value?.error)
const noConfirm = await post('/clear', { buckets: ['facts'] })
console.log('NO_CONFIRM_GUARD', noConfirm.status, noConfirm.value?.error)
const badBody = await post('/config', { warmth: 'not-a-number', injectionChars: -5 })
console.log('BAD_INPUT_CLAMP', badBody.status, badBody.value?.personality?.warmth, badBody.value?.settings?.injectionChars)
await post('/config', orig)
