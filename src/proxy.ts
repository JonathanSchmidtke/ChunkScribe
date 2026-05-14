import mc from 'minecraft-protocol'
import path from 'node:path'
import fs from 'node:fs'
import { log } from './util/log'
import { emit } from './gui/bus'
import { PhaseTracker } from './phase'
import { Capture } from './capture'
import { WorldSaver } from './world/save'

/** Append a single packet-trace line to packets.log (off the GUI). */
let traceStream: fs.WriteStream | null = null
function trace(line: string) {
  if (!traceStream) {
    try { traceStream = fs.createWriteStream(path.resolve('packets.log'), { flags: 'a' }) }
    catch { return }
  }
  try { traceStream!.write(`${new Date().toISOString()} ${line}\n`) } catch {}
}

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
  /** Aggregate capture counts (entities, containers). */
  extraStats: () => { entities: number; containers: number }
}

export function startProxy(opts: ProxyOpts): ProxySession {
  const worldDir = path.join(opts.outputDir, sanitize(opts.targetHost))
  log.info(`listening on ${opts.listenHost}:${opts.listenPort} -> ${opts.targetHost}:${opts.targetPort}`)
  log.info(`world output: ${worldDir}`)
  emit({ type: 'session', state: 'starting', detail: `${opts.targetHost}:${opts.targetPort}` })

  // mc.createServer's offline-mode config phase writes registry_data
  // from `options.registryCodec`. Without it, 1.21.5+ clients receive an
  // empty registry and close 70ms into the configuration state. Feed it
  // the bundled minecraft-data login packet so the client can finish
  // configuration cleanly. (We still overwrite the world with the target
  // server's data once the bridge is up.)
  let registryCodec: any = {}
  try {
    const mcData = require('minecraft-data')(opts.version)
    registryCodec = mcData?.loginPacket?.dimensionCodec || {}
    const keys = Object.keys(registryCodec)
    log.info(`registryCodec ${keys.length ? `loaded (${keys.length} registries)` : 'EMPTY — config phase will likely fail'}`)
  } catch (e) {
    log.warn(`minecraft-data load failed for ${opts.version}: ${(e as Error).message}`)
  }

  const server = mc.createServer({
    'online-mode': false,
    host: opts.listenHost,
    port: opts.listenPort,
    version: opts.version,
    motd: 'ChunkScribe Proxy',
    maxPlayers: 1,
    keepAlive: false,
    registryCodec,
  } as any)

  let activeClient: any = null
  let activeTarget: any = null
  let activeCapture: Capture | null = null
  let flushTimer: NodeJS.Timeout | null = null
  let running = true

  server.on('listening', () => {
    emit({ type: 'session', state: 'running', detail: `${opts.listenHost}:${opts.listenPort}` })
  })

  // 'playerJoin' fires after mc.createServer has driven the client all the
  // way through login -> configuration -> play. Using 'login' was firing
  // before configuration was complete, so the client closed when nothing
  // came back from the proxy in config state.
  server.on('playerJoin', (client: any) => {
    log.info(`client connected: ${client.username} (state=${client.state})`)
    trace(`PLAYER_JOIN client=${client.username} state=${client.state}`)

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

    trace(`SESSION_START client=${client.username} target=${opts.targetHost}:${opts.targetPort} version=${opts.version}`)

    client.on('packet', (data: any, meta: any) => {
      try { capture.observeClientPacket(meta, data) } catch {}
      const ok = target.state === client.state
      trace(`c->s ${meta.state}.${meta.name} ${ok ? 'FWD' : `DROP(t=${target.state})`}`)
      if (!ok) return
      try { target.write(meta.name, data) }
      catch (e) { trace(`c->s WRITE_FAIL ${meta.name}: ${(e as Error).message}`) }
    })

    target.on('packet', (data: any, meta: any) => {
      phase.observe(meta.state)
      try { capture.handle(meta, data) }
      catch (e) { trace(`CAPTURE_FAIL ${meta.name}: ${(e as Error).message}`) }
      const ok = client.state === target.state
      trace(`s->c ${meta.state}.${meta.name} ${ok ? 'FWD' : `DROP(c=${client.state})`}`)
      if (!ok) return
      try { client.write(meta.name, data) }
      catch (e) { trace(`s->c WRITE_FAIL ${meta.name}: ${(e as Error).message}`) }
    })

    target.on('state', (newState: string, oldState: string) => {
      log.info(`target state: ${oldState} -> ${newState}`)
      trace(`TARGET_STATE ${oldState} -> ${newState}`)
    })
    target.on('connect',  () => { log.info('target TCP connected');         trace('TARGET_TCP_CONNECTED') })
    target.on('session',  () => { log.info('target session ready');         trace('TARGET_SESSION_READY') })
    client.on('state', (newState: string, oldState: string) => trace(`CLIENT_STATE ${oldState} -> ${newState}`))

    client.on('end',   () => { trace('CLIENT_END');         tearDownSession('client disconnect') })
    target.on('end',   () => { trace('TARGET_END');         tearDownSession('target disconnect') })
    client.on('error', (e: any) => { log.err('client error:', e?.message); trace(`CLIENT_ERROR ${e?.message}`); tearDownSession('client error') })
    target.on('error', (e: any) => { log.err('target error:', e?.message); trace(`TARGET_ERROR ${e?.message}`); tearDownSession('target error') })
    target.on('kick_disconnect', (p: any) => { log.warn('kicked (play):', p?.reason); trace(`TARGET_KICK_PLAY ${JSON.stringify(p?.reason)}`) })
    target.on('disconnect',      (p: any) => { log.warn('disconnected:',  p?.reason); trace(`TARGET_DISCONNECT ${JSON.stringify(p?.reason)}`) })
  })

  server.on('error', (e: any) => {
    log.err('server error:', e?.message)
    emit({ type: 'session', state: 'error', detail: e?.message })
  })

  return {
    opts,
    isRunning: () => running,
    chunksByDim: () => activeCapture?.chunksByDim() ?? {},
    extraStats: () => ({
      entities:   activeCapture?.mobs.count() ?? 0,
      containers: activeCapture?.containers.totalCaptured ?? 0,
    }),
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
