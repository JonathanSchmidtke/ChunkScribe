import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { WebSocketServer, WebSocket } from 'ws'
import { log } from '../util/log'
import { bus, GuiEvent } from './bus'
import { startProxy, ProxySession, ProxyOpts } from '../proxy'

export interface GuiServerOpts {
  port: number
  defaults: ProxyOpts
  publicDir: string
  /** If true, start proxy immediately with defaults; else wait for UI Start. */
  autoStart: boolean
}

export function startGui(opts: GuiServerOpts): { url: string; close: () => void } {
  let session: ProxySession | null = null
  let lastDefaults = opts.defaults

  const server = http.createServer((req, res) => {
    handleHttp(req, res, opts.publicDir, {
      getStatus: () => buildStatus(session, lastDefaults),
      getDefaults: () => lastDefaults,
      start: (body) => {
        if (session?.isRunning()) return { ok: false, error: 'already running' }
        const merged: ProxyOpts = { ...lastDefaults, ...sanitizeOpts(body) }
        lastDefaults = merged
        try {
          session = startProxy(merged)
          return { ok: true }
        } catch (e) {
          return { ok: false, error: (e as Error).message }
        }
      },
      stop: async () => {
        if (!session) return { ok: true }
        try { await session.stop() } catch (e) { return { ok: false, error: (e as Error).message } }
        session = null
        return { ok: true }
      },
    })
  })

  const wss = new WebSocketServer({ server, path: '/ws' })
  const clients = new Set<WebSocket>()

  wss.on('connection', (ws) => {
    clients.add(ws)
    ws.send(JSON.stringify({ type: 'hello', defaults: lastDefaults, status: buildStatus(session, lastDefaults) }))
    ws.on('close', () => clients.delete(ws))
  })

  const onEvent = (ev: GuiEvent) => {
    const payload = JSON.stringify(ev)
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(payload) } catch {}
      }
    }
  }
  bus.on('event', onEvent)

  // Periodic status broadcast (chunk counts, running flag)
  const statusTimer = setInterval(() => {
    onEvent({ type: 'status', running: !!session?.isRunning(), target: session?.opts?.targetHost, chunksByDim: session?.chunksByDim() ?? {} } as GuiEvent)
  }, 1000)

  server.listen(opts.port, '127.0.0.1', () => {
    log.info(`GUI listening on http://127.0.0.1:${opts.port}`)
    if (opts.autoStart) {
      try { session = startProxy(lastDefaults) }
      catch (e) { log.err('autostart failed:', (e as Error).message) }
    }
  })

  return {
    url: `http://127.0.0.1:${opts.port}`,
    close: () => {
      clearInterval(statusTimer)
      bus.off('event', onEvent)
      for (const ws of clients) try { ws.close() } catch {}
      try { wss.close() } catch {}
      try { server.close() } catch {}
      session?.stop().catch(() => {})
    },
  }
}

function buildStatus(session: ProxySession | null, defaults: ProxyOpts) {
  return {
    running: !!session?.isRunning(),
    target: session?.opts?.targetHost ?? defaults.targetHost,
    chunksByDim: session?.chunksByDim() ?? {},
  }
}

function sanitizeOpts(body: any): Partial<ProxyOpts> {
  const o: Partial<ProxyOpts> = {}
  if (typeof body?.targetHost  === 'string') o.targetHost  = body.targetHost.trim()
  if (typeof body?.targetPort  === 'number') o.targetPort  = body.targetPort
  if (typeof body?.listenPort  === 'number') o.listenPort  = body.listenPort
  if (typeof body?.msEmail     === 'string') o.msEmail     = body.msEmail.trim() || undefined
  if (typeof body?.version     === 'string') o.version     = body.version.trim()
  if (typeof body?.outputDir   === 'string') o.outputDir   = body.outputDir
  if (typeof body?.flushIntervalSec === 'number') o.flushIntervalSec = body.flushIntervalSec
  return o
}

type Handlers = {
  getStatus: () => any
  getDefaults: () => ProxyOpts
  start: (body: any) => { ok: boolean; error?: string }
  stop: () => Promise<{ ok: boolean; error?: string }>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
}

function handleHttp(req: http.IncomingMessage, res: http.ServerResponse, publicDir: string, h: Handlers) {
  const url = req.url || '/'

  if (url.startsWith('/api/')) return handleApi(req, res, h)

  // Static files from public/
  const safe = url.split('?')[0].replace(/\/+$/, '') || '/index.html'
  const rel = safe === '/' ? '/index.html' : safe
  const filePath = path.join(publicDir, rel)
  if (!filePath.startsWith(publicDir)) { res.writeHead(403); res.end('forbidden'); return }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end('not found'); return }
    const ext = path.extname(filePath).toLowerCase()
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
    fs.createReadStream(filePath).pipe(res)
  })
}

function handleApi(req: http.IncomingMessage, res: http.ServerResponse, h: Handlers) {
  const url = req.url || ''
  const json = (status: number, body: any) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  const readBody = (): Promise<any> => new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) }
    })
  })

  if (req.method === 'GET' && url === '/api/state') {
    return json(200, { defaults: h.getDefaults(), status: h.getStatus() })
  }
  if (req.method === 'POST' && url === '/api/start') {
    return readBody().then(body => json(200, h.start(body)))
  }
  if (req.method === 'POST' && url === '/api/stop') {
    return h.stop().then(r => json(200, r))
  }

  json(404, { ok: false, error: 'not found' })
}
