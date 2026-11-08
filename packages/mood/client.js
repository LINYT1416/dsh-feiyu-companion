window.__ModuleLoader__.load({
  id: 'dsh-mood-v2',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const base = '/mood-v2'
    const request = (path, options) => fetch(base + path, { cache: 'no-store', ...options }).then(async response => {
      const value = await response.json()
      if (!response.ok) throw new Error(value.error || '请求失败')
      return value
    })
    const card = { background: 'var(--dsw-alias-bg-layer-1)', padding: 12, borderRadius: 6 }
    const dim = { color: 'var(--dsw-alias-label-secondary)' }
    const MIND = [['social', '社交电量'], ['patience', '耐心'], ['guard', '防备'], ['comfort', '想被哄'], ['pride', '自尊'], ['focus', '专注']]

    const bar = (label, value, tone) => h('div', { key: label, style: { display: 'flex', alignItems: 'center', gap: 8 } },
      h('span', { style: { ...dim, width: 72 } }, label),
      h('div', { style: { flex: 1, height: 8, borderRadius: 4, background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.2))', position: 'relative' } },
        h('div', { style: { position: 'absolute', left: '50%', top: 0, width: 1, height: '100%', background: 'rgba(127,127,127,0.35)' } }),
        h('div', { style: { position: 'absolute', left: `${Math.min(50, 50 + value * 50)}%`, width: `${Math.abs(value) * 50}%`, height: '100%', borderRadius: 4, background: tone } })),
      h('span', { style: { width: 42, textAlign: 'right' } }, value > 0 ? `+${Math.round(value * 100)}` : `${Math.round(value * 100)}`))

    function Panel() {
      const [value, setValue] = React.useState(null)
      const [message, setMessage] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const refresh = React.useCallback(() => request('/state').then(setValue).catch(error => setMessage(error.message)), [])
      React.useEffect(() => { refresh() }, [refresh])
      const nudge = patch => {
        setBusy(true)
        setMessage('')
        request('/nudge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
          .then(next => { setValue(next); setMessage('已调整，下一条回复的口气会跟着变') })
          .catch(error => setMessage(error.message))
          .finally(() => setBusy(false))
      }
      if (!value) return h('div', { style: { padding: 24 } }, message || '正在读取心情…')
      const trail = value.trail || []
      const open = (value.ledger || []).filter(item => !item.clearedAt && !item.expiredAt)
      return h('div', { style: { padding: 24, maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 16, color: 'var(--dsw-alias-label-primary)' } },
        h('h2', { style: { margin: 0 } }, '大肥鱼此刻的心理'),
        h('p', { style: { margin: 0, ...dim } }, '这份是全局的：DSH 和 QQ 那条大肥鱼看的是同一份。心境、情绪、此刻的状态、没结清的账——都会影响她这一句怎么回。'),

        h('section', { style: { ...card, display: 'flex', flexDirection: 'column', gap: 8 } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12 } }, h('strong', null, value.label), h('span', { style: dim }, value.surface)),
          MIND.map(([key, label]) => bar(label, value.mind[key] || 0, key === 'guard' ? 'linear-gradient(90deg,#a88bd4,#d4a8c8)' : key === 'comfort' ? 'linear-gradient(90deg,#e0a0b0,#f2b8c6)' : 'linear-gradient(90deg,#8b9bb4,#7fd4a5)')),
          h('small', { style: dim }, value.mindLine ? `注入里会写：此刻的状态：${value.mindLine}` : '现在没有哪一维特别突出，注入里不会写这一行')),

        h('section', { style: { ...card, display: 'flex', flexDirection: 'column', gap: 8 } },
          h('strong', null, '身体'),
          ...[
            ['饿', value.body?.hunger, '吃点东西', { body: { hunger: 0.15 } }, '放着不管每小时涨 6%，涨到 85 她自己会去楼下吃'],
            ['缺觉', value.body?.sleepDebt, '睡一会儿', { body: { sleepDebt: 0.15 } }, '深夜（1–6 点）每小时涨 5%，睡一觉才降'],
            ['腰酸', value.body?.ache, '活动一下', { body: { ache: 0.08 } }, '坐着每小时涨 1.5%，动一动会松'],
          ].map(([label, raw, action, patch, hint]) => h('div', { key: label, style: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 } },
            h('span', { style: { ...dim, width: 40 } }, label),
            h('span', { style: { width: 40 } }, Math.round((raw || 0) * 100)),
            h('button', { disabled: busy, onClick: () => nudge({ ...patch, event: `手动：去${action}` }) }, action),
            h('span', { style: { ...dim, fontSize: 12 } }, hint))),
          h('small', { style: dim }, '这三样不会自己好，只会随时间变差；上面三个按钮就是「她去做了点什么」。')),

        h('section', { style: { ...card, display: 'flex', flexDirection: 'column', gap: 6 } },
          h('strong', null, '还没发生、已经在影响她的事'),
          (value.expect || []).length
            ? (value.expect || []).map(item => h('div', { key: item.label + item.when, style: { fontSize: 13 } },
              `· ${item.label}（${String(item.when).slice(5, 16).replace('T', ' ')}，${item.valence >= 0 ? '期待' : '有点发怵'}）`))
            : h('div', { style: dim }, '眼下没什么等着的事')),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { disabled: busy, onClick: () => nudge({ expectClear: true, event: '手动：这件事过去了' }) }, '这些事都过去了')),

        h('section', { style: { ...card, display: 'flex', flexDirection: 'column', gap: 6 } },
          h('strong', null, '长期心性'),
          h('div', { style: { display: 'flex', gap: 16, fontSize: 13, ...dim } },
            h('span', null, `最近几天的底子 ${Math.round(((value.traits?.dayBase || 0) * 100))}`),
            h('span', null, `关系带来的底子 ${Math.round(((value.longTerm?.valence || 0) * 100))}`),
            h('span', null, `合成后的心境 ${value.moodNow ?? '—'}`)),
          h('small', { style: dim }, '每天结算一次：昨天的平均心境会混进底子 10%，连着几天不好过会沉下去。')),

        h('section', { style: { ...card, display: 'flex', flexDirection: 'column', gap: 6 } },
          h('strong', null, '还热着的情绪'),
          (value.emotions || []).length
            ? h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, value.emotions.map(item => h('span', {
              key: item.kind + item.target,
              style: { padding: '2px 8px', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.15))', fontSize: 12 },
            }, `${item.kind}·对${item.target} ${Math.round(item.intensity * 100)}`)))
            : h('div', { style: dim }, '没有特别热的情绪，心境在前面那层里')),

        h('section', { style: { ...card, display: 'flex', flexDirection: 'column', gap: 6 } },
          h('strong', null, '还没放下的账'),
          open.length
            ? open.map(item => h('div', { key: item.id, style: { fontSize: 13 } }, `· 欠一句${item.kind}：${item.reason}`))
            : h('div', { style: dim }, '清干净了。')),

        h('section', { style: { ...card, display: 'flex', flexDirection: 'column', gap: 6 } },
          h('strong', null, '24 小时轨迹'),
          trail.length
            ? h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 2, height: 48 } }, trail.map((point, index) => h('div', {
              key: point.at + index,
              title: `${String(point.at).slice(11, 16)} 心境 ${point.valence}`,
              style: { flex: 1, minWidth: 3, height: `${Math.max(4, (point.valence + 1) * 50)}%`, background: point.valence >= 0 ? '#7fd4a5' : '#d49a9a', borderRadius: 2 },
            })))
            : h('div', { style: dim }, '还没攒到一小时，等一会儿再看。')),

        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('button', { disabled: busy, onClick: refresh }, '刷新'),
          h('button', { disabled: busy, onClick: () => nudge({ emotion: { kind: '开心', target: '他', intensity: 0.6 }, valence: 0.2, event: '手动：开心' }) }, '拨开心'),
          h('button', { disabled: busy, onClick: () => nudge({ emotion: { kind: '生气', target: '他', intensity: 0.6 }, valence: -0.2, ledger: { kind: '道歉', reason: '手动记的一笔' }, event: '手动：生气' }) }, '拨不高兴'),
          h('button', { disabled: busy, onClick: () => nudge({ mask: 0.3, event: '手动：开始装' }) }, '让她装一下'),
          h('button', { disabled: busy, onClick: () => nudge({ clearLedger: true, event: '手动：清账' }) }, '清账'),
          h('button', { disabled: busy, onClick: () => nudge({ recall: '去年冬天在便利店门口等你的那晚', recallValence: -0.8, event: '手动：想起一件旧事' }) }, '试一次回忆')),

        h('p', { style: { margin: 0, ...dim } }, '「拨一下」「试一次回忆」只是给你验证用的。同一条记忆一天只会生效一次；账没清的时候，防备不会自己降下来。'),
        message ? h('p', { style: { margin: 0 } }, message) : null)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'mood-v2', order: 85, label: '大肥鱼的心情' }, props => h(Panel, props)))
      },
    }
  },
})
