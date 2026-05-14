import 'dotenv/config'
import os from 'node:os'
import path from 'node:path'
import open from 'open'
import { log } from './util/log'
import { startGui } from './gui/server'
import type { ProxyOpts } from './proxy'

function defaultDownloadsDir(): string {
  return path.join(os.homedir(), 'Downloads')
}

function loadDefaults(): ProxyOpts {
  const expand = (s: string | undefined) =>
    s ? path.resolve(s.replace(/%([^%]+)%/g, (_, n) => process.env[n] || '')) : ''

  return {
    listenHost: process.env.LISTEN_HOST || '127.0.0.1',
    listenPort: parseInt(process.env.LISTEN_PORT || '25566', 10),
    targetHost: process.env.TARGET_HOST || '',
    targetPort: parseInt(process.env.TARGET_PORT || '25565', 10),
    msEmail:    process.env.MS_EMAIL || undefined,
    version:    process.env.MC_VERSION || '1.21.11',
    outputDir:  expand(process.env.OUTPUT_DIR) || defaultDownloadsDir(),
    flushIntervalSec: parseInt(process.env.FLUSH_INTERVAL_SEC || '30', 10),
  }
}

function main() {
  const defaults = loadDefaults()
  const guiPort  = parseInt(process.env.GUI_PORT || '7878', 10)
  const autoStart = process.env.AUTO_START === '1' && !!defaults.targetHost
  const noBrowser = process.env.NO_BROWSER === '1'

  // src/ runs from dist/ in build mode, from src/ via tsx in dev.
  // The public dir lives one level above whichever it is.
  const publicDir = findPublicDir()

  log.info(`ChunkScribe starting (mc ${defaults.version})`)

  const gui = startGui({ port: guiPort, defaults, publicDir, autoStart })

  if (!noBrowser) {
    setTimeout(() => {
      open(gui.url).catch((e: Error) => log.warn('could not open browser:', e.message))
    }, 250)
  }
  log.info(`open ${gui.url} in your browser`)

  const shutdown = (sig: string) => {
    log.info(`received ${sig}, shutting down`)
    try { gui.close() } catch {}
    setTimeout(() => process.exit(0), 500).unref()
  }
  process.on('SIGINT',  () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

function findPublicDir(): string {
  // dev (tsx): __dirname == .../src      -> ../public
  // build:     __dirname == .../dist     -> ../public
  const candidates = [
    path.resolve(__dirname, '..', 'public'),
    path.resolve(process.cwd(), 'public'),
  ]
  for (const c of candidates) {
    try { require('node:fs').statSync(path.join(c, 'index.html')); return c } catch {}
  }
  return candidates[0]
}

main()
