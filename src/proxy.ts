import mc from 'minecraft-protocol'
import path from 'node:path'
import { log } from './util/log'
import { emit } from './gui/bus'
import { PhaseTracker } from './phase'
import { Capture } from './capture'
import { WorldSaver } from './world/save'

export interface ProxyOpts {
  listenHost: string
  listenPort: number
  targetHost: string
  targetPort: number
  msEmail: string | undefined
  version: string
  outputDir: string
  flushIntervalSec: number
}

export interface ProxySession {
  opts: ProxyOpts
  stop: () => Promise<void>
  isRunning: () => boolean
  /** chunk counts per dimension, for status polling. */
  chunksByDim: () => Record<string, number>
}

export function startProxy(opts: ProxyOpts): ProxySession {
  const worldDir = path.join(opts.outputDir, sanitize(opts.targetHost))
  log.info(`listening on ${opts.listenHost}:${opts.listenPort} -> ${opts.targetHost}:${opts.targetPort}`)
  log.info(`world output: ${worldDir}`)
  emit({ type: 'session', state: 'starting', detail: `${opts.targetHost}:${opts.targetPort}` })

  const server = mc.createServer({
    'online-mode': false,
    host: opts.listenHost,
    port: opts.listenPort,
    version: opts.version,
    motd: 'ChunkScribe Proxy',
    maxPlayers: 1,
    keepAlive: false,
  })

  let activeClient: any = null
  let activeTarget: any = null
  let activeCapture: Capture | null = null
  let flushTimer: NodeJS.Timeout | null = null
  let running = true

  server.on('listening', () => {
    emit({ type: 'session', state: 'running', detail: `${opts.listenHost}:${opts.listenPort}` })
  })

  server.on('login', (client: any) => {
    log.info(`client connected: ${client.username}`)

    const phase = new PhaseTracker()
    const saver = new WorldSaver(worldDir, opts.version, phase)
    const capture = new Capture(phase, saver, opts.version)

    const target = mc.createClient({
      host: opts.targetHost,
      port: opts.targetPort,
      username: opts.msEmail || client.username,
      auth: 'microsoft',
      version: opts.version,
      profilesFolder: path.resolve('.auth'),
      keepAlive: false,
    })

    activeClient = client
    activeTarget = target
    activeCapture = capture

    if (flushTimer) clearInterval(flushTimer)
    flushTimer = opts.flushIntervalSec > 0
      ? setInterval(() => {
          saver.flush(capture.stores).catch(e => log.warn('periodic flush failed:', e))
        }, opts.flushIntervalSec * 1000)
      : null

    let sessionTorn = false
    const tearDownSession = async (reason: string) => {
      if (sessionTorn) return
      sessionTorn = true
      log.info(`session teardown: ${reason}`)
      try { await saver.flush(capture.stores) } catch (e) { log.err('final flush failed:', e) }
      try { client.end(reason) } catch {}
      try { target.end(reason) } catch {}
      if (flushTimer) { clearInterval(flushTimer); flushTimer = null }
      activeClient = activeTarget = null
      activeCapture = null
    }

    client.on('packet', (data: any, meta: any) => {
      if (target.state !== client.state) return
      try { target.write(meta.name, data) }
      catch (e) { log.dbg('c->s write failed', meta.name, (e as Error).message) }
    })

    target.on('packet', (data: any, meta: any) => {
      phase.observe(meta.state)
      try { capture.handle(meta, data) }
      catch (e) { log.dbg('capture failed', meta.name, (e as Error).message) }
      if (client.state !== target.state) return
      try { client.write(meta.name, data) }
      catch (e) { log.dbg('s->c write failed', meta.name, (e as Error).message) }
    })

    client.on('end',   () => tearDownSession('client disconnect'))
    target.on('end',   () => tearDownSession('target disconnect'))
    client.on('error', (e: any) => { log.err('client error:', e?.message); tearDownSession('client error') })
    target.on('error', (e: any) => { log.err('target error:', e?.message); tearDownSession('target error') })
    target.on('kick_disconnect',  (p: any) => log.warn('kicked (play):',  p?.reason))
    target.on('disconnect',       (p: any) => log.warn('disconnected:',   p?.reason))
  })

  server.on('error', (e: any) => {
    log.err('server error:', e?.message)
    emit({ type: 'session', state: 'error', detail: e?.message })
  })

  return {
    opts,
    isRunning: () => running,
    chunksByDim: () => activeCapture?.chunksByDim() ?? {},
    stop: async () => {
      if (!running) return
      running = false
      emit({ type: 'session', state: 'stopping' })
      try { activeClient?.end('proxy stopped') } catch {}
      try { activeTarget?.end('proxy stopped') } catch {}
      try { server.close() } catch {}
      if (flushTimer) { clearInterval(flushTimer); flushTimer = null }
      emit({ type: 'session', state: 'stopped' })
    },
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_')
}
