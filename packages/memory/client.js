window.__ModuleLoader__.load({
  id: '@local/silicon-life-companion-v4',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const base = '/silicon-life-companion'
    // 面板里点开的页面：直接在本窗口盖一层 iframe。
    // 为什么不用 <a target=_blank>：桌面端没有新窗口处理器，点了没反应。
    function openOverlay(path, title) {
      try {
        const old = document.getElementById('slc-overlay')
        if (old) old.remove()
        const wrap = document.createElement('div')
        wrap.id = 'slc-overlay'
        wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(6,10,18,.72);display:flex;align-items:center;justify-content:center;padding:24px'
        const box = document.createElement('div')
        box.style.cssText = 'width:min(1500px,96vw);height:min(920px,92vh);background:#0b1220;border:1px solid #24314a;border-radius:14px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 70px rgba(0,0,0,.6)'
        const bar = document.createElement('div')
        bar.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #1e2a42;color:#dbe6ff;font:14px "Microsoft YaHei",sans-serif'
        const name = document.createElement('span')
        name.textContent = title
        name.style.cssText = 'flex:1'
        const btn = document.createElement('button')
        btn.textContent = '✕'
        btn.style.cssText = 'border:none;background:transparent;color:#dbe6ff;font-size:18px;cursor:pointer;opacity:.8'
        const iframe = document.createElement('iframe')
        iframe.src = path
        iframe.style.cssText = 'flex:1;width:100%;border:0;background:#05070d'
        const shut = () => wrap.remove()
        btn.onclick = shut
        wrap.onclick = (e) => { if (e.target === wrap) shut() }
        bar.appendChild(name); bar.appendChild(btn)
        box.appendChild(bar); box.appendChild(iframe)
        wrap.appendChild(box)
        document.body.appendChild(wrap)
      } catch (e) { console.error('[companion-memory] 打开页面失败', e) }
    }
    const request = (path, options) => fetch(base + path, { cache: 'no-store', ...options }).then(async response => { const value = await response.json(); if (!response.ok) throw new Error(value.error || 'Request failed'); return value })
    const card = { background: 'var(--dsw-alias-bg-layer-1)', padding: 12, borderRadius: 6 }
    function Panel({ close }) {
      const [state, setState] = React.useState(null)
      const [layers, setLayers] = React.useState(null)
      const [message, setMessage] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [budget, setBudget] = React.useState('3500')
      const [days, setDays] = React.useState('7')
      const [deep, setDeep] = React.useState(false)
      const [personaName, setPersonaName] = React.useState('')
      const [personaDescription, setPersonaDescription] = React.useState('')
      const [personaUserAddress, setPersonaUserAddress] = React.useState('')
      const [personaLikes, setPersonaLikes] = React.useState('')
      const [personaDislikes, setPersonaDislikes] = React.useState('')
      const [personaValues, setPersonaValues] = React.useState('')
      const [personaVoice, setPersonaVoice] = React.useState('')
      const [personaSamples, setPersonaSamples] = React.useState('')
      const [personaPrompt, setPersonaPrompt] = React.useState('')
      const [traits, setTraits] = React.useState('')
      const [warmth, setWarmth] = React.useState(50)
      const [curiosity, setCuriosity] = React.useState(50)
      const [pragmatism, setPragmatism] = React.useState(50)
      const [decayHours, setDecayHours] = React.useState(72)
      const [stickerFreq, setStickerFreq] = React.useState('normal')
      const refresh = React.useCallback(() => Promise.all([request('/state'), request('/data')]).then(([value, data]) => {
        setState(value); setLayers(data)
        setBudget(String(value.settings?.injectionChars ?? 3500)); setDays(String(Math.round((value.settings?.sevenDayMs ?? 604800000) / 86400000))); setDeep(value.settings?.activeThinking === true)
        setPersonaName(value.persona?.name || ''); setPersonaDescription(value.persona?.description || ''); setPersonaUserAddress(value.persona?.userAddress || ''); setPersonaLikes(value.persona?.likes || ''); setPersonaDislikes(value.persona?.dislikes || ''); setPersonaPrompt(value.persona?.systemPrompt || '')
        setPersonaValues(value.persona?.values || ''); setPersonaVoice(value.persona?.voice || ''); setPersonaSamples(value.persona?.samples || '')
        setTraits(value.personality?.traits || ''); setWarmth(value.personality?.warmth ?? 50); setCuriosity(value.personality?.curiosity ?? 50); setPragmatism(value.personality?.pragmatism ?? 50); setDecayHours(value.moodSettings?.decayHours ?? 72); setStickerFreq(value.stickerFrequency || value.settings?.stickerFrequency || 'normal')
      }).catch(error => setMessage(error.message)), [])
      React.useEffect(() => { refresh() }, [refresh])
      const act = work => { setBusy(true); setMessage(''); work().then(() => { setMessage(prev => prev || '已保存'); refresh() }).catch(error => setMessage(error.message)).finally(() => setBusy(false)) }
      const save = () => act(() => request('/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ injectionChars: Number(budget), sevenDayDays: Number(days), activeThinking: deep, personaName, personaDescription, personaUserAddress, personaLikes, personaDislikes, personaValues, personaVoice, personaSamples, personaPrompt, traits, warmth: Number(warmth), curiosity: Number(curiosity), pragmatism: Number(pragmatism), moodDecayHours: Number(decayHours), stickerFrequency: stickerFreq }) }))
      const blankPersona = () => { if (!window.confirm('把人格清空成一张白纸？当前人设会先存档（最近 10 份可回看），记忆不受影响。')) return; act(() => request('/persona/blank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })) }
      const pushQQ = () => act(async () => {
        const info = await request('/persona/push-qq')
        if (!info?.configured) throw new Error(info?.hint || '没找到 QQ 桥')
        if (!String(info.text || '').trim()) throw new Error('人格还是空的，先填再同步')
        // QQ 桥的管理接口只认浏览器会话，所以这一步必须在浏览器里发。
        const response = await fetch('/dsh-qq-bridge/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ 人设开: true, 人设: info.text }) })
        const value = await response.json().catch(() => null)
        if (!response.ok || !value || value.ok === false) throw new Error((value && (value['说'] || value.error)) || `QQ 桥拒绝（${response.status}）`)
        setMessage(`已同步到 QQ：${String((value && value['说']) || '好了')}（${info.text.length} 字）`)
      })
      const exportData = () => act(() => request('/export').then(value => { const blob = new Blob([value.content], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'companion-memory-export.json'; a.click(); URL.revokeObjectURL(url); return value }))
      const backfill = () => act(() => request('/backfill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }))
      const syncBridge = () => act(() => request('/bridge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'import' }) }))
      const refreshStickers = () => act(() => request('/sticker/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deep: true }) }).then(value => { if (!value.ok) throw new Error(value.reason || '更新失败'); setMessage(`表情库已更新${value.synced ? '（含新图）' : ''}`); return value }))
      const row = (label, value) => h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12 } }, h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, label), h('span', null, value))
      const counts = state?.counts || {}
      const layerNames = ['archive', 'facts', 'episodes', 'profile']
      const qqPersonaLine = (() => {
        const q = state?.qqPersona
        if (!q) return ''
        if (!q.on) return 'QQ 桥的老式「人设」已经关掉了——直连对话时 QQ 用的就是这里这份人格，不需要同步。'
        if (q.same) return '直连模式：QQ 用的就是这里这份人格。'
        return `QQ 桥还留着自己的一份人设（QQ ${q.theirChars} 字 / 这里 ${q.myChars} 字）。直连对话时它不参与；只有老式「QQ 自带人设」的桥才需要在下面点同步。`
      })()
      const children = [
        h('header', { key: 'head', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, h('div', null, h('h2', { style: { margin: 0 } }, 'Companion 记忆与状态'), h('p', { style: { margin: '4px 0 0', color: 'var(--dsw-alias-label-secondary)' } }, '记忆按对话隔离；下方状态为全部对话汇总。')), h('button', { onClick: () => openOverlay('/silicon-life-companion/journal', '📔 日记本 / 念头本'), style: { marginLeft: 'auto', marginRight: 8, padding: '6px 12px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-secondary, #33415c)', background: 'transparent', color: 'inherit', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' } }, '📔 日记本'), h('button', { onClick: () => openOverlay('/silicon-life-companion/graph', '🌌 记忆星云'), style: { marginRight: 12, padding: '6px 12px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-secondary, #33415c)', background: 'transparent', color: 'inherit', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' } }, '🌌 记忆星云'), h('button', { onClick: () => openOverlay('/silicon-life-companion/graph3d', '🌌 记忆星云 3D'), style: { marginRight: 12, padding: '6px 12px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-secondary, #33415c)', background: 'transparent', color: 'inherit', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' } }, '🌌 3D'), h('button', { onClick: close, title: '关闭', style: { padding: '2px 9px', borderRadius: 8, border: 'none', background: 'transparent', color: 'inherit', fontSize: 17, lineHeight: 1.2, cursor: 'pointer', opacity: 0.65 } }, '✕')),
        state ? h('section', { key: 'summary', style: { ...card, display: 'flex', flexDirection: 'column', gap: 6 } }, row('数据结构版本', state.version), row('四层记忆', `archive ${counts.archive ?? counts.raw ?? 0} / facts ${counts.facts ?? 0} / episodes ${counts.episodes ?? 0} / profile ${counts.profile ?? 0}`), row('归档有效原话', `${state.archiveClean ?? '—'} 条${state.archiveNoise ? `（另有 ${state.archiveNoise} 条历史系统噪声，已隔离未删）` : ''}`), row('编年史', state.chronicle?.days ? `${state.chronicle.days} 天（最近 ${state.chronicle.lastDay || '—'}）` : '还没开始积累'), row('记忆分层', state.tiers ? `瞬时 ${state.tiers.instant} · 短期 ${state.tiers.short} · 长期 ${state.tiers.long} · 永久 ${state.tiers.permanent}` : '—'), row('容量水位', state.capacity ? `原文库 ${Math.round((state.capacity.archive?.ratio || 0) * 100)}%（${state.capacity.archive?.used}/${state.capacity.archive?.limit}）· 注入 ${Math.round((state.capacity.injection?.ratio || 0) * 100)}%` : '—'), row('情绪记录（本地）', counts.moods ?? 0), row('心情来源', state.moodSource === 'feiyu-mood' ? '鱼的心情插件（它负责告诉我）' : '本插件本地记账'), row('当前心情', state.moodSource === 'feiyu-mood' && state.feiyuMood ? `${state.feiyuMood.label} ${Math.round(state.feiyuMood.score)}/100${state.feiyuMood.reason ? '｜' + state.feiyuMood.reason : ''}` : state.mood ? `${state.mood.emotion}（${state.mood.valence}, ${state.mood.arousal}）` : '暂无'), state.capacity && (state.capacity.archive?.level >= 80 || state.capacity.injection?.level >= 80) ? h('small', { style: { color: 'var(--dsw-alias-warning, #b8860b)' } }, '容量到 80% 以上了：只是提醒，不会自动删任何记忆。') : null, h('small', null, '装了「鱼的心情」时心情归它管，这里只展示不重复注入；archive 是 raw 的只读投影，偏好会自动进 profile、其余自述进 facts；久远原话在注入里会变短，原文不动。')) : h('p', { key: 'loading' }, '正在读取状态…'),
        state ? h('section', { key: 'layers', style: { ...card, display: 'flex', flexDirection: 'column', gap: 8 } },
          h('h3', { style: { margin: 0 } }, '四层记忆浏览（每层最近 30 条）'),
          ...layerNames.map(layer => {
            const items = (layers?.layers?.[layer] || []).map(item => h('p', { key: item.id, style: { margin: '4px 0', overflowWrap: 'anywhere', opacity: item.noise ? 0.55 : 1 } }, `${item.noise ? '⚠ 系统噪声 · ' : ''}${item.role === 'assistant' ? '旧助手草稿 · ' : ''}${item.at || ''} · ${item.text || ''}`))
            const count = layers?.layers?.[layer]?.length || 0
            return h('details', { key: layer, open: layer !== 'archive' }, h('summary', null, `${layer} (${count})`), ...items)
          }),
          h('small', null, layers?.note || '')
        ) : null,
        state ? h('section', { key: 'persona', style: { ...card, display: 'flex', flexDirection: 'column', gap: 8 } }, h('h3', { style: { margin: 0 } }, '人格 / 性格 / 情绪设定'), h('p', { style: { margin: 0, color: 'var(--dsw-alias-label-secondary)' } }, '默认是一张白纸：下面哪一格不填，注入里就一个字都不加。'), h('input', { value: personaName, maxLength: 80, placeholder: '名字（留空 = 没名字）', onChange: e => setPersonaName(e.target.value) }), h('input', { value: personaUserAddress, maxLength: 80, placeholder: '她怎么称呼你（留空 = 不特意称呼）', onChange: e => setPersonaUserAddress(e.target.value) }), h('textarea', { value: personaDescription, maxLength: 2000, rows: 2, placeholder: '她是谁（一句话也行）', onChange: e => setPersonaDescription(e.target.value) }), h('textarea', { value: personaLikes, maxLength: 600, rows: 2, placeholder: '她喜欢的（留空 = 没这回事）', onChange: e => setPersonaLikes(e.target.value) }), h('textarea', { value: personaDislikes, maxLength: 600, rows: 2, placeholder: '她不喜欢的', onChange: e => setPersonaDislikes(e.target.value) }), h('textarea', { value: personaValues, maxLength: 2000, rows: 3, placeholder: '三观：在意什么、不做什么、怎么待人', onChange: e => setPersonaValues(e.target.value) }), h('textarea', { value: personaVoice, maxLength: 2000, rows: 3, placeholder: '说话方式：句子长短、口头禅、会不会用表情、什么时候直接/绕', onChange: e => setPersonaVoice(e.target.value) }), h('textarea', { value: personaSamples, maxLength: 2000, rows: 3, placeholder: '她平时说话的样子（两三句你自己的话，让她照这个口气说）', onChange: e => setPersonaSamples(e.target.value) }), h('textarea', { value: traits, maxLength: 2000, rows: 2, placeholder: '性格特征（自然语言）', onChange: e => setTraits(e.target.value) }), h('textarea', { value: personaPrompt, maxLength: 4000, rows: 4, placeholder: '补充设定（最多 4000 字，优先级最高）', onChange: e => setPersonaPrompt(e.target.value) }), ...[['温暖', warmth, setWarmth], ['求知', curiosity, setCuriosity], ['务实', pragmatism, setPragmatism]].map(([label, value, setter]) => h('label', { key: label }, `${label} ${value}`, h('input', { type: 'range', min: 0, max: 100, value, onChange: e => setter(Number(e.target.value)) }))), h('label', null, '表情包频率', h('select', { value: stickerFreq, onChange: e => setStickerFreq(e.target.value) }, h('option', { value: 'off' }, '不发'), h('option', { value: 'rare' }, '偶尔'), h('option', { value: 'normal' }, '正常'), h('option', { value: 'often' }, '经常'))), h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, h('button', { disabled: busy, onClick: save }, '保存设定'), h('button', { disabled: busy, onClick: blankPersona }, '清空成白纸（先存档）'), h('button', { disabled: busy, onClick: pushQQ }, '同步给老式 QQ 人设')), h('small', null, 'DSH 和 QQ 直连时，两边用的是下面这一份人格，不需要同步；这个按钮只给「QQ 桥自带人设」的老式接法用。')) : null,
        h('div', { key: 'actions', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, h('button', { disabled: busy, onClick: refresh }, '刷新状态'), h('button', { disabled: busy, onClick: backfill }, '从历史原话回填 facts/profile'), h('button', { disabled: busy, onClick: refreshStickers }, '更新表情库（联网）'), h('button', { disabled: busy, onClick: exportData }, '导出全部记忆 JSON'), h('button', { disabled: busy, onClick: () => setMessage('archive/raw 是不可变原始源，管理页与接口均不提供清除。') }, '原文保留保护')),
        state?.bridge ? h('p', { key: 'bridge', style: { margin: 0, color: 'var(--dsw-alias-label-secondary)' } }, `联动：鱼记忆 ${state.bridge.fish?.detected ? `本会话 ${state.bridge.fish.memories} 条、已镜像 ${state.bridge.fish.mirrored} 条（只读）` : '没找到库'}；persistent-memory ${state.bridge.detected ? `已镜像 ${state.bridge.mirrored}/${state.bridge.upstreamFacts} 条` : '没找到文件'}`) : null,
        state ? h('p', { key: 'jokes', style: { margin: 0, color: 'var(--dsw-alias-label-secondary)' } }, `这个对话里的梗：${state.jokeCount ?? 0} 条${state.jokeCount ? '（只有你明确说“记成我们的梗”才会存）' : '（还没有；我不会自己编）'}`) : null,
        qqPersonaLine ? h('p', { key: 'qqpersona', style: { margin: 0, color: 'var(--dsw-alias-label-secondary)' } }, qqPersonaLine) : null,
        message ? h('p', { key: 'message', role: 'status' }, message) : null
      ]
      return h('div', { style: { padding: 24, maxWidth: 760, color: 'var(--dsw-alias-label-primary)', display: 'flex', flexDirection: 'column', gap: 16 } }, ...children)
    }
    // 面板自身出错时只降级这一页，不连累整个设置窗口。
    class Boundary extends React.Component {
      constructor(props) { super(props); this.state = { error: null } }
      static getDerivedStateFromError(error) { return { error } }
      render() {
        if (this.state.error) return h('div', { style: { padding: 24, display: 'flex', flexDirection: 'column', gap: 8 } }, h('h2', { style: { margin: 0 } }, 'Companion 记忆与状态'), h('p', { style: { margin: 0 } }, '这个页面渲染出错，但记忆功能本身仍在运行。'), h('code', { style: { overflowWrap: 'anywhere' } }, String(this.state.error?.message || this.state.error)), h('button', { onClick: () => this.setState({ error: null }) }, '重试'))
        return this.props.children
      }
    }
    return { inject: ['slots'], apply(ctx) { ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'silicon-life-companion', order: 80, label: 'Companion 记忆与状态' }, props => h(Boundary, null, h(Panel, props)))) } }
  }
})
