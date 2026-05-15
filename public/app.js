// ChunkScribe browser UI

const $ = (id) => document.getElementById(id)

const state = {
  defaults: null,
  running: false,
  activeDim: 'minecraft:overworld',
  chunksByDim: {},          // dim -> Set<"x,z">
  view: { x: 0, z: 0, scale: 6 },
  dragging: false,
  lastMouse: null,
}

// ---------- WebSocket ----------
function connectWs() {
  const ws = new WebSocket(`ws://${location.host}/ws`)
  ws.onopen = () => log('info', 'gui ws connected')
  ws.onclose = () => { log('warn', 'gui ws closed, reconnecting in 2s'); setTimeout(connectWs, 2000) }
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data) } catch { return }
    if (m.type === 'hello') {
      state.defaults = m.defaults
      populateForm(m.defaults)
      applyStatus(m.status)
    } else if (m.type === 'log') {
      log(m.level, m.msg, m.ts)
    } else if (m.type === 'chunk') {
      queueChunk(m.dim, m.x, m.z)
    } else if (m.type === 'chunks') {
      for (const c of m.list) queueChunk(c.dim, c.x, c.z)
    } else if (m.type === 'dim') {
      if (!state.chunksByDim[m.dim]) state.chunksByDim[m.dim] = new Set()
      state.activeDim = m.dim
      renderDimTabs()
      redraw()
    } else if (m.type === 'session') {
      applySession(m.state, m.detail)
    } else if (m.type === 'status') {
      // Periodic status pulse — update counts/running flag, but keep our own chunk sets authoritative.
      state.running = m.running
      if (typeof m.entities   === 'number') $('entity-count').textContent    = m.entities
      if (typeof m.containers === 'number') $('container-count').textContent = m.containers
      reflectRunning()
    }
  }
}
connectWs()

// ---------- Form ----------
function populateForm(d) {
  $('targetHost').value      = d.targetHost ?? ''
  $('targetPort').value      = d.targetPort ?? 25565
  $('msEmail').value         = d.msEmail ?? ''
  $('listenPort').value      = d.listenPort ?? 25566
  $('version').value         = d.version ?? '1.21.11'
  $('outputDir').value       = d.outputDir ?? ''
  $('flushIntervalSec').value = d.flushIntervalSec ?? 30
  $('version-tag').textContent = d.version ?? '1.21.11'
  $('hint-port').textContent = d.listenPort ?? 25566
}

function readForm() {
  return {
    targetHost: $('targetHost').value.trim(),
    targetPort: parseInt($('targetPort').value, 10) || 25565,
    msEmail:    $('msEmail').value.trim(),
    listenPort: parseInt($('listenPort').value, 10) || 25566,
    version:    $('version').value.trim() || '1.21.11',
    outputDir:  $('outputDir').value.trim(),
    flushIntervalSec: parseInt($('flushIntervalSec').value, 10) || 0,
  }
}

$('btn-start').onclick = async () => {
  const body = readForm()
  if (!body.targetHost) { alert('Set a target server first.'); return }
  $('btn-start').disabled = true
  const r = await fetch('/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }))
  if (!r.ok) { alert('Start failed: ' + (r.error || 'unknown')); $('btn-start').disabled = false; return }
  $('hint-port').textContent = body.listenPort
}

$('btn-stop').onclick = async () => {
  $('btn-stop').disabled = true
  await fetch('/api/stop', { method: 'POST' }).catch(() => {})
}

// ---------- Scans / Transform ----------
async function refreshScans() {
  const r = await fetch('/api/scans').then(r => r.json()).catch(() => ({ scans: [], savesDir: '' }))
  const select = $('scan-select')
  select.innerHTML = ''
  if (!r.scans || r.scans.length === 0) {
    const opt = document.createElement('option')
    opt.textContent = '(no scans yet — Start the proxy + connect to capture one)'
    opt.disabled = true
    select.appendChild(opt)
  } else {
    for (const s of r.scans) {
      const opt = document.createElement('option')
      opt.value = s.path
      const dims = [s.hasOverworld && 'overworld', s.hasNether && 'nether', s.hasEnd && 'end'].filter(Boolean).join('+')
      const when = new Date(s.lastModified).toLocaleString()
      opt.textContent = `${s.name} — ${s.regionFileCount} region files, ${dims} (${when})`
      opt.dataset.name = s.name
      select.appendChild(opt)
    }
  }
  if (r.savesDir) $('saves-dir').textContent = r.savesDir
}

$('scan-select').onchange = () => {
  const opt = $('scan-select').selectedOptions[0]
  if (opt && opt.dataset.name && !$('transform-name').value.trim()) {
    $('transform-name').value = opt.dataset.name
  }
}

$('btn-refresh-scans').onclick = refreshScans

$('btn-transform').onclick = async () => {
  const scanPath = $('scan-select').value
  if (!scanPath) { alert('No scan selected.'); return }
  const destName = $('transform-name').value.trim() || 'ChunkScribe World'
  const voidUnscanned = $('transform-void').checked
  $('btn-transform').disabled = true
  log('info', `transforming ${scanPath} -> Minecraft saves ("${destName}", void=${voidUnscanned})…`)
  const r = await fetch('/api/transform', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scanPath, destName, voidUnscanned }),
  }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }))
  $('btn-transform').disabled = false
  if (r.ok) {
    log('info', `transform complete → ${r.destPath}`)
    alert(`Done!\nOpen Minecraft → Singleplayer → "${destName}".\n\nPath:\n${r.destPath}`)
  } else {
    log('err', `transform failed: ${r.error}`)
    alert('Transform failed: ' + (r.error || 'unknown'))
  }
}

refreshScans()
setInterval(refreshScans, 10_000)  // periodic refresh so the dropdown stays current

$('chat-form').onsubmit = async (e) => {
  e.preventDefault()
  const input = $('chat-input')
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  log('info', `> ${text}`)
  const r = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }))
  if (!r.ok) log('warn', `chat failed: ${r.error}`)
}

function applySession(s, detail) {
  const dot = $('status-dot')
  const txt = $('status-text')
  dot.className = 'dot'
  if (s === 'starting') { dot.classList.add('starting'); txt.textContent = 'starting…' }
  else if (s === 'running') { dot.classList.add('running'); txt.textContent = detail ? `running @ ${detail}` : 'running'; state.running = true; reflectRunning() }
  else if (s === 'stopping') { txt.textContent = 'stopping…' }
  else if (s === 'stopped') { txt.textContent = 'idle'; state.running = false; reflectRunning() }
  else if (s === 'error') { dot.classList.add('error'); txt.textContent = detail || 'error'; state.running = false; reflectRunning() }
}
function reflectRunning() {
  $('btn-start').disabled = state.running
  $('btn-stop').disabled  = !state.running
}
function applyStatus(s) {
  if (!s) return
  state.running = !!s.running
  reflectRunning()
}

// ---------- Chunk map ----------
const canvas = $('map')
const ctx = canvas.getContext('2d')

function resize() {
  const r = canvas.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  canvas.width  = Math.floor(r.width  * dpr)
  canvas.height = Math.floor(r.height * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  redraw()
}
new ResizeObserver(resize).observe(canvas)

// Chunks come in bursts (100+/sec). Buffer them and drain once per animation
// frame so we redraw at most 60Hz no matter how fast the bridge fills.
const chunkQueue = []
let rafPending = false

function queueChunk(dim, x, z) {
  chunkQueue.push([dim, x, z])
  if (!rafPending) {
    rafPending = true
    requestAnimationFrame(drainChunkQueue)
  }
}

function drainChunkQueue() {
  rafPending = false
  let activeDimDirty = false
  let needTabRender = false
  for (const [dim, x, z] of chunkQueue) {
    if (!state.chunksByDim[dim]) {
      state.chunksByDim[dim] = new Set()
      needTabRender = true
    }
    const set = state.chunksByDim[dim]
    const key = `${x},${z}`
    if (set.has(key)) continue
    set.add(key)
    if (!state.activeDim || state.chunksByDim[state.activeDim]?.size === 0) {
      state.activeDim = dim
      needTabRender = true
    }
    if (dim === state.activeDim) activeDimDirty = true
  }
  chunkQueue.length = 0
  if (needTabRender) renderDimTabs()
  // One redraw covers every chunk added this frame instead of N fillRects.
  if (activeDimDirty) redraw()
  updateStats()
}

function drawChunk(x, z) {
  const r = canvas.getBoundingClientRect()
  const cx = r.width / 2, cy = r.height / 2
  const s = state.view.scale
  const px = cx + (x - state.view.x) * s
  const py = cy + (z - state.view.z) * s
  ctx.fillStyle = '#6cb56a'
  ctx.fillRect(Math.floor(px), Math.floor(py), Math.max(1, s - 0.5), Math.max(1, s - 0.5))
}

function redraw() {
  const r = canvas.getBoundingClientRect()
  ctx.fillStyle = '#0e1116'
  ctx.fillRect(0, 0, r.width, r.height)
  drawGrid(r)
  const set = state.chunksByDim[state.activeDim]
  if (!set) return updateStats()
  ctx.fillStyle = '#6cb56a'
  const cx = r.width / 2, cy = r.height / 2
  const s = state.view.scale
  for (const k of set) {
    const [x, z] = k.split(',').map(Number)
    const px = cx + (x - state.view.x) * s
    const py = cy + (z - state.view.z) * s
    if (px < -s || py < -s || px > r.width || py > r.height) continue
    ctx.fillRect(Math.floor(px), Math.floor(py), Math.max(1, s - 0.5), Math.max(1, s - 0.5))
  }
  // Origin crosshair
  ctx.strokeStyle = '#2a313d'
  ctx.lineWidth = 1
  ctx.beginPath()
  const ox = cx + (0 - state.view.x) * s, oz = cy + (0 - state.view.z) * s
  ctx.moveTo(ox - 6, oz); ctx.lineTo(ox + 6, oz)
  ctx.moveTo(ox, oz - 6); ctx.lineTo(ox, oz + 6)
  ctx.stroke()
  updateStats()
}

function drawGrid(r) {
  const s = state.view.scale
  if (s < 4) return
  ctx.strokeStyle = '#161a22'
  ctx.lineWidth = 1
  const cx = r.width / 2, cy = r.height / 2
  const stepWorld = s < 10 ? 16 : 4 // grid every N chunks
  const startX = Math.floor(state.view.x / stepWorld - r.width / (2 * s * stepWorld)) * stepWorld
  const endX   = state.view.x + r.width / (2 * s)
  for (let x = startX; x <= endX; x += stepWorld) {
    const px = cx + (x - state.view.x) * s
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, r.height); ctx.stroke()
  }
  const startZ = Math.floor(state.view.z / stepWorld - r.height / (2 * s * stepWorld)) * stepWorld
  const endZ   = state.view.z + r.height / (2 * s)
  for (let z = startZ; z <= endZ; z += stepWorld) {
    const py = cy + (z - state.view.z) * s
    ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(r.width, py); ctx.stroke()
  }
}

canvas.addEventListener('mousedown', (e) => {
  state.dragging = true; state.lastMouse = { x: e.clientX, y: e.clientY }
})
window.addEventListener('mouseup', () => { state.dragging = false })
window.addEventListener('mousemove', (e) => {
  if (!state.dragging || !state.lastMouse) return
  const dx = e.clientX - state.lastMouse.x
  const dy = e.clientY - state.lastMouse.y
  state.lastMouse = { x: e.clientX, y: e.clientY }
  state.view.x -= dx / state.view.scale
  state.view.z -= dy / state.view.scale
  redraw()
})
canvas.addEventListener('wheel', (e) => {
  e.preventDefault()
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
  state.view.scale = Math.max(1, Math.min(32, state.view.scale * factor))
  redraw()
}, { passive: false })
window.addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') { recenter() }
})
function recenter() {
  const set = state.chunksByDim[state.activeDim]
  if (!set || set.size === 0) { state.view = { x: 0, z: 0, scale: state.view.scale }; redraw(); return }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const k of set) {
    const [x, z] = k.split(',').map(Number)
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  state.view.x = (minX + maxX) / 2
  state.view.z = (minZ + maxZ) / 2
  redraw()
}

function renderDimTabs() {
  const dims = Object.keys(state.chunksByDim)
  const container = $('dim-tabs'); container.innerHTML = ''
  for (const d of dims) {
    const b = document.createElement('button')
    b.textContent = d.replace('minecraft:', '')
    if (d === state.activeDim) b.classList.add('active')
    b.onclick = () => { state.activeDim = d; renderDimTabs(); redraw() }
    container.appendChild(b)
  }
}

function updateStats() {
  const set = state.chunksByDim[state.activeDim]
  $('chunk-count').textContent = set ? set.size : 0
  $('active-dim').textContent = (state.activeDim || '').replace('minecraft:', '') || '—'
}

// ---------- Log ----------
const logEl = $('log')
const MAX_LOG_LINES = 500
function log(level, msg, ts) {
  const line = document.createElement('div')
  line.className = `line ${level}`
  const tsStr = new Date(ts || Date.now()).toISOString().slice(11, 19)
  line.innerHTML = `<span class="ts">${tsStr}</span>${escape(msg)}`
  logEl.appendChild(line)
  while (logEl.childNodes.length > MAX_LOG_LINES) logEl.removeChild(logEl.firstChild)
  logEl.scrollTop = logEl.scrollHeight
}
function escape(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]) }

// initial paint
requestAnimationFrame(resize)
