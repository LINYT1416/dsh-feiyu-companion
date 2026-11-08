// 记忆库家政：只收「会无限膨胀、但内容价值低」的旁支数据。
// 记忆本体（raw / facts / episodes）不在这里动——它们走分层与分数淘汰。

const DAY = 86400e3

// 1) 情绪流水：默认只留最近 30 天、每天最多留最后一次；另外永远保留最新一条。
//    注入只用最新一条，旧情绪没有查询方，留着只是把库撑大。
export function compactMoods(moods, { now = Date.now(), keepDays = 30, perDay = 1 } = {}) {
  const list = Array.isArray(moods) ? moods : []
  const byDay = new Map()
  for (const row of list) {
    const at = typeof row?.at === 'number' ? row.at : Date.parse(String(row?.at || ''))
    if (!Number.isFinite(at) || !at) continue
    const day = new Date(at).toISOString().slice(0, 10)
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push({ row, at })
  }
  const kept = []
  for (const [day, rows] of byDay) {
    const ageDays = (now - (Date.parse(day + 'T00:00:00Z') || now)) / DAY
    if (ageDays > keepDays) continue
    rows.sort((a, b) => a.at - b.at)
    for (const item of rows.slice(-perDay)) kept.push(item.row)
  }
  // 兜底：最近 24 条情绪无论如何都留着，避免「今天刚记的全被按天压成一条」。
  const recent = list.slice(-24)
  const seen = new Set(kept.map((row) => row))
  for (const row of recent) if (!seen.has(row)) kept.push(row)
  kept.sort((a, b) => {
    const at = (row) => (typeof row?.at === 'number' ? row.at : Date.parse(String(row?.at || '')) || 0)
    return at(a) - at(b)
  })
  return { kept, dropped: list.length - kept.length }
}

// 2) 按会话的旁支数据：只留活跃会话，另有数量上限。
export function pruneSessionMaps(state, { activeSessions = [], keep = 40 } = {}) {
  const alive = new Set(activeSessions.filter(Boolean))
  let pruned = 0
  for (const key of ['stickerStats', 'stickerHints', 'threads', 'threadsFailed']) {
    const map = state?.[key]
    if (!map || typeof map !== 'object') continue
    for (const k of Object.keys(map)) {
      if (alive.has(k)) continue
      delete map[k]
      pruned += 1
    }
    const keys = Object.keys(map)
    if (keys.length > keep) {
      const sorted = keys.sort((a, b) => String(map[b]?.updatedAt || map[b]?.at || '').localeCompare(String(map[a]?.updatedAt || map[a]?.at || '')))
      for (const k of sorted.slice(keep)) {
        delete map[k]
        pruned += 1
      }
    }
  }
  return { pruned }
}

// 3) 内部梗：每个对话最多 12 条，超了先丢最久没被提过的。
export function compactJokes(insideJokes, { perSession = 12 } = {}) {
  const map = insideJokes || {}
  let dropped = 0
  for (const key of Object.keys(map)) {
    const list = Array.isArray(map[key]) ? map[key] : []
    if (list.length <= perSession) continue
    const sorted = [...list].sort((a, b) => String(b?.lastUsedAt || b?.at || '').localeCompare(String(a?.lastUsedAt || a?.at || '')))
    map[key] = sorted.slice(0, perSession)
    dropped += list.length - map[key].length
  }
  return { dropped }
}

// 4) 会话表：30 天没动静的清掉。
export function compactSessions(sessions, { now = Date.now(), keepDays = 30 } = {}) {
  const map = sessions || {}
  let dropped = 0
  for (const key of Object.keys(map)) {
    const at = Date.parse(String(map[key]?.updatedAt || map[key]?.at || '')) || 0
    if (!at) continue
    if ((now - at) / DAY > keepDays) {
      delete map[key]
      dropped += 1
    }
  }
  return { dropped }
}

export function runHousekeeping(state, { activeSessions = [] } = {}) {
  const moods = compactMoods(state?.moods)
  if (state && Array.isArray(state.moods)) state.moods = moods.kept
  const maps = pruneSessionMaps(state, { activeSessions })
  const jokes = compactJokes(state?.insideJokes)
  const sessions = compactSessions(state?.sessions)
  return {
    moodsDropped: moods.dropped,
    mapsPruned: maps.pruned,
    jokesDropped: jokes.dropped,
    sessionsDropped: sessions.dropped,
  }
}
