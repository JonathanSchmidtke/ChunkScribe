import mc from 'minecraft-protocol'
import path from 'node:path'
import { log } from './util/log'
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

export function startProxy(opts: ProxyOpts) {
  const worldDir = path.join(opts.outputDir, sanitize(opts.targetHost))
  log.info(`listening on ${opts.listenHost}:${opts.listenPort} -> ${opts.targetHost}:${opts.targetPort}`)
  log.info(`world output: ${worldDir}`)

  const server = mc.createServer({
    'online-mode': false,
    host: opts.listenHost,
    port: opts.listenPort,
    version: opts.version,
    motd: 'ChunkScribe Proxy',
    maxPlayers: 1,
    keepAlive: false, // let the target server's keep-alives flow through
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

    let ended = false
    const teardown = async (reason: string) => {
      if (ended) return
      ended = true
      log.info(`teardown: ${reason}`)
      try { await saver.flush(capture.stores) } catch (e) { log.err('final flush failed:', e) }
      try { client.end(reason) } catch {}
      try { target.end(reason) } catch {}
      if (flushTimer) clearInterval(flushTimer)
    }

    const flushTimer = opts.flushIntervalSec > 0
      ? setInterval(() => {
          saver.flush(capture.stores).catch(e => log.warn('periodic flush failed:', e))
        }, opts.flushIntervalSec * 1000)
      : null

    // client -> server: pure forward
    client.on('packet', (data: any, meta: any) => {
      if (target.state !== client.state) return
      try { target.write(meta.name, data) }
      catch (e) { log.dbg('c->s write failed', meta.name, (e as Error).message) }
    })

    // server -> client: tap then forward
    target.on('packet', (data: any, meta: any) => {
      phase.observe(meta.state)
      try { capture.handle(meta, data) }
      catch (e) { log.dbg('capture failed', meta.name, (e as Error).message) }
      if (client.state !== target.state) return
      try { client.write(meta.name, data) }
      catch (e) { log.dbg('s->c write failed', meta.name, (e as Error).message) }
    })

    client.on('end',   () => teardown('client disconnect'))
    target.on('end',   () => teardown('target disconnect'))
    client.on('error', (e: any) => { log.err('client error:', e?.message); teardown('client error') })
    target.on('error', (e: any) => { log.err('target error:', e?.message); teardown('target error') })

    // Mirror disconnect packets so the user sees the real kick reason
    target.on('kick_disconnect',  (p: any) => log.warn('kicked (play):',  p?.reason))
    target.on('disconnect',       (p: any) => log.warn('disconnected:',   p?.reason))
  })

  server.on('error', (e: any) => log.err('server error:', e?.message))
  return server
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_')
}
