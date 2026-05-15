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
  /** Cape alias to activate on the user's Mojang profile before connecting
   * (e.g. "MineCon 2011", "Migrator"). Must be a cape the account owns. */
  cape?: string
}

export interface ProxySession {
  opts: ProxyOpts
  stop: () => Promise<void>
  isRunning: () => boolean
  chunksByDim: () => Record<string, number>
  extraStats: () => { entities: number; containers: number }
  sendChat: (text: string) => boolean
}

/**
 * Two-phase startup so MC actually renders target's world:
 *
 *  PHASE 1 — TARGET WARMUP
 *    We connect to target first (with the user's Microsoft auth) and
 *    capture every packet target sends during the configuration phase:
 *    registry_data (one per registry: biomes, dimension_types,
 *    enchantments, paintings, etc.), tags, feature_flags. We also keep
 *    target's play.login packet for later. This populates a runtime
 *    snapshot of target's exact protocol-level world description.
 *
 *  PHASE 2 — LOCAL SERVER
 *    Once target is in play state (snapshot is complete), we open the
 *    local mc.createServer listener with `registryCodec = target's
 *    captured registries`. When MC connects, mc.createServer's auto
 *    config phase sends *target's* registries to the client — so the
 *    client's local registry IDs match the IDs in target's chunks. A
 *    monkey-patch on client.write also injects target's actual tags +
 *    feature_flags right before finish_configuration.
 *
 *  PHASE 3 — BRIDGE
 *    When MC enters play state, we forward target's play.login (so the
 *    client knows about target's dimensions) and then bridge every
 *    subsequent packet bidirectionally. Chunks reference biome IDs the
 *    client now has → MC renders the world for real.
 */
export function startProxy(opts: ProxyOpts): ProxySession {
  const worldDir = path.join(opts.outputDir, sanitize(opts.targetHost))
  log.info(`world output: ${worldDir}`)
  emit({ type: 'session', state: 'starting', detail: `${opts.targetHost}:${opts.targetPort}` })

  // Captured state from target's config phase. Populated during warmup,
  // consumed when MC client connects.
  const captured = {
    registries: {} as Record<string, any>,
    tags: null as any,
    featureFlags: null as any,
    playLogin: null as any,
    targetInPlay: false,
    // All play-state packets that arrived from target before MC connected.
    // Replayed in order on playerJoin so MC sees the world target streamed.
    // Filtered: keep_alive / ping are time-sensitive — let live ones win.
    playBuffer: [] as Array<{ name: string; data: any }>,
  }

  const REPLAY_SKIP = new Set(['keep_alive', 'ping'])

  const phase = new PhaseTracker()
  const saver = new WorldSaver(worldDir, opts.version, phase)
  const capture = new Capture(phase, saver, opts.version)

  let activeServer: any = null
  let activeClient: any = null
  let flushTimer: NodeJS.Timeout | null = null
  let running = true
  let stopped = false

  // Optional pre-auth cape switch. Fire and (best effort) await before we
  // create the target client, so the new cape is reflected in the player
  // profile target fetches on hasJoined. Failures are non-fatal — we still
  // connect with whatever cape was active before.
  if (opts.cape) {
    ;(async () => {
      const { getMinecraftJavaToken, applyCape } = require('./mojang') as typeof import('./mojang')
      const token = await getMinecraftJavaToken(opts.msEmail, path.resolve('.auth'))
      if (!token) { log.warn(`cape switch skipped: no auth token`); return }
      const r = await applyCape(token, opts.cape!)
      if (!r.ok) log.warn(`cape switch: ${r.error}`)
    })().catch((e) => log.warn(`cape switch threw: ${(e as Error).message}`))
  }

  // ============== PHASE 1: connect to target & capture registries ==============
  log.info(`connecting to target ${opts.targetHost}:${opts.targetPort} to capture registries...`)
  trace(`WARMUP_START target=${opts.targetHost}:${opts.targetPort}`)

  const target = mc.createClient({
    host: opts.targetHost,
    port: opts.targetPort,
    username: opts.msEmail || 'ChunkScribe',
    auth: 'microsoft',
    version: opts.version,
    profilesFolder: path.resolve('.auth'),
    keepAlive: false,
  })

  target.on('state', (newState: string, oldState: string) => {
    log.info(`target state: ${oldState} -> ${newState}`)
    trace(`TARGET_STATE ${oldState} -> ${newState}`)
  })
  target.on('connect', () => { log.info('target TCP connected'); trace('TARGET_TCP_CONNECTED') })
  target.on('session', () => { log.info('target session ready'); trace('TARGET_SESSION_READY') })

  target.on('packet', (data: any, meta: any) => {
    phase.observe(meta.state)
    try { capture.handle(meta, data) }
    catch (e) { trace(`CAPTURE_FAIL ${meta.name}: ${(e as Error).message}`) }

    // Capture config-phase packets for replay to MC client
    if (meta.state === 'configuration') {
      if (meta.name === 'registry_data') {
        captured.registries[data.id] = data
      } else if (meta.name === 'tags') {
        captured.tags = data
      } else if (meta.name === 'feature_flags') {
        captured.featureFlags = data
      }
      trace(`s->c CAPTURE ${meta.state}.${meta.name}`)
      return
    }

    // First play.login = target's actual world description; stash it
    if (meta.state === 'play' && meta.name === 'login' && !captured.playLogin) {
      captured.playLogin = data
      captured.targetInPlay = true
      log.info(`target reached play state (${Object.keys(captured.registries).length} registries, tags: ${!!captured.tags}, flags: ${!!captured.featureFlags})`)
      trace(`TARGET_PLAY_LOGIN captured`)
      startLocalServer()
      return
    }

    // Once MC client is connected & in play, bridge target's play stream through.
    if (activeClient && activeClient.state === 'play' && meta.state === 'play') {
      if (meta.name === 'login') {
        trace(`s->c DROP duplicate play.login`)
        return
      }
      try {
        activeClient.write(meta.name, data)
        trace(`s->c FWD ${meta.state}.${meta.name}`)
      } catch (e) {
        trace(`s->c WRITE_FAIL ${meta.name}: ${(e as Error).message}`)
      }
      return
    }

    // MC not connected yet but target already in play: buffer the packet for
    // replay so MC gets the full world snapshot when it joins.
    if (meta.state === 'play' && meta.name !== 'login' && !REPLAY_SKIP.has(meta.name)) {
      captured.playBuffer.push({ name: meta.name, data })
      trace(`s->c BUFFER ${meta.name} (buf size ${captured.playBuffer.length})`)
      return
    }

    trace(`s->c CAPTURE ${meta.state}.${meta.name}`)
  })

  target.on('end', () => { trace('TARGET_END'); cleanup('target disconnect') })
  target.on('error', (e: any) => {
    log.err('target error:', e?.message)
    trace(`TARGET_ERROR ${e?.message}`)
    emit({ type: 'session', state: 'error', detail: `target: ${e?.message}` })
    cleanup('target error')
  })
  target.on('kick_disconnect', (p: any) => { log.warn('kicked (play):', p?.reason); trace(`TARGET_KICK ${JSON.stringify(p?.reason)}`) })
  target.on('disconnect',      (p: any) => { log.warn('disconnected:',  p?.reason); trace(`TARGET_DISCONNECT ${JSON.stringify(p?.reason)}`) })

  // Periodic flush so chunks persist even if we never see a disconnect
  flushTimer = opts.flushIntervalSec > 0
    ? setInterval(() => {
        saver.flush(capture.stores).catch(e => log.warn('periodic flush failed:', e))
      }, opts.flushIntervalSec * 1000)
    : null

  // ============== PHASE 2: open local server with target's registries ==========
  function startLocalServer() {
    if (activeServer) return
    log.info(`opening local listener on ${opts.listenHost}:${opts.listenPort}`)

    activeServer = mc.createServer({
      'online-mode': false,
      host: opts.listenHost,
      port: opts.listenPort,
      version: opts.version,
      motd: 'ChunkScribe Proxy',
      maxPlayers: 1,
      keepAlive: false,
      registryCodec: captured.registries,
    } as any)

    activeServer.on('listening', () => {
      emit({ type: 'session', state: 'running', detail: `${opts.listenHost}:${opts.listenPort}` })
    })
    activeServer.on('error', (e: any) => {
      log.err('local server error:', e?.message)
      emit({ type: 'session', state: 'error', detail: e?.message })
    })

    // Inject target's actual tags + feature_flags right before finish_configuration
    activeServer.on('connection', (client: any) => {
      trace(`CONNECTION from=${client.socket?.remoteAddress}:${client.socket?.remotePort}`)

      const origWrite = client.write.bind(client)
      let preludeSent = false
      client.write = (name: string, data: any) => {
        if (!preludeSent && name === 'finish_configuration' && client.state === 'configuration') {
          preludeSent = true
          if (captured.featureFlags) {
            try { origWrite('feature_flags', captured.featureFlags); trace('SHIM feature_flags sent (from target)') }
            catch (e) { trace(`SHIM feature_flags FAIL: ${(e as Error).message}`) }
          }
          if (captured.tags) {
            try { origWrite('tags', captured.tags); trace('SHIM tags sent (from target)') }
            catch (e) { trace(`SHIM tags FAIL: ${(e as Error).message}`) }
          }
        }
        return origWrite(name, data)
      }

      client.on('packet', (_d: any, meta: any) => trace(`SERVER<-CLIENT ${meta.state}.${meta.name}`))
      client.on('state', (n: string, o: string) => trace(`CLIENT_STATE ${o} -> ${n}`))
      client.on('end',   () => trace('CLIENT_END (pre-playerJoin)'))
      client.on('error', (e: any) => trace(`CLIENT_ERROR (pre-playerJoin): ${e?.message}`))
    })

    activeServer.on('playerJoin', (client: any) => {
      log.info(`client connected: ${client.username} (state=${client.state})`)
      trace(`PLAYER_JOIN ${client.username}`)
      activeClient = client

      // Replay target's actual play.login so the client knows about target's
      // dimensions/seed/gamemode (and so its registries now line up).
      if (captured.playLogin) {
        try {
          client.write('login', captured.playLogin)
          trace(`SHIM play.login replayed from target`)
        } catch (e) {
          log.err('replay play.login failed:', (e as Error).message)
          trace(`SHIM play.login FAIL: ${(e as Error).message}`)
        }
      }

      // Replay the world snapshot target streamed during warmup: chunks,
      // spawn_position, player position, declare_recipes, set_health,
      // everything in order. Without this, MC sits in "Loading terrain"
      // forever because target has already finished sending the initial
      // world view and won't re-send.
      log.info(`replaying ${captured.playBuffer.length} buffered play packets to MC...`)
      let replayed = 0, replayFailed = 0
      for (const pkt of captured.playBuffer) {
        try { client.write(pkt.name, pkt.data); replayed++ }
        catch (e) { replayFailed++; trace(`replay FAIL ${pkt.name}: ${(e as Error).message}`) }
      }
      log.info(`replay done (${replayed} ok, ${replayFailed} failed)`)
      // Drop the buffer; future packets flow live via target.on('packet')
      captured.playBuffer.length = 0

      // Bridge client -> target
      client.on('packet', (data: any, meta: any) => {
        try { capture.observeClientPacket(meta, data) } catch {}
        const ok = target.state === client.state
        if (!ok) { trace(`c->s ${meta.state}.${meta.name} DROP(t=${target.state})`); return }
        trace(`c->s ${meta.state}.${meta.name} FWD`)
        try { target.write(meta.name, data) }
        catch (e) { trace(`c->s WRITE_FAIL ${meta.name}: ${(e as Error).message}`) }
      })

      client.on('end',   () => { trace('CLIENT_END');         activeClient = null })
      client.on('error', (e: any) => { log.err('client error:', e?.message); trace(`CLIENT_ERROR ${e?.message}`); activeClient = null })
    })
  }

  function cleanup(reason: string) {
    if (stopped) return
    stopped = true
    running = false
    log.info(`session teardown: ${reason}`)
    saver.flush(capture.stores).catch(e => log.err('final flush failed:', e))
    try { activeClient?.end(reason) } catch {}
    try { target?.end(reason) } catch {}
    try { activeServer?.close() } catch {}
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null }
    emit({ type: 'session', state: 'stopped' })
  }

  return {
    opts,
    isRunning: () => running,
    chunksByDim: () => capture.chunksByDim(),
    extraStats: () => ({
      entities:   capture.mobs.count(),
      containers: capture.containers.totalCaptured,
    }),
    sendChat: (text: string) => {
      if (!target || target.state !== 'play') return false
      try {
        const trimmed = text.trim()
        if (trimmed.startsWith('/')) {
          target.write('chat_command', { command: trimmed.slice(1) })
        } else {
          target.write('chat_message', {
            message: trimmed,
            timestamp: BigInt(Date.now()),
            salt: 0n,
            signature: undefined,
            offset: 0,
            acknowledged: new Uint8Array(3),
          })
        }
        log.info(`sent to target: ${trimmed}`)
        return true
      } catch (e) {
        log.warn(`sendChat failed: ${(e as Error).message}`)
        return false
      }
    },
    stop: async () => { cleanup('user stop') },
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_')
}
