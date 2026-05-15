import 'dotenv/config'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { log } from './util/log'
import { startGui } from './gui/server'
import { loadSavedOpts } from './settings'
import type { ProxyOpts } from './proxy'

/**
 * Open a URL in the user's default browser. We use OS commands directly
 * instead of the npm `open` package because (a) modern `open` is ESM-only
 * and breaks our CJS build, and (b) `start ""` on Windows is bulletproof.
 */
function openBrowser(url: string) {
  log.info(`opening browser: ${url}`)
  try {
    if (process.platform === 'win32') {
      // `start "" "url"` — empty title is required when the path has quotes
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', shell: false }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    }
  } catch (e) {
    log.warn('could not open browser:', (e as Error).message)
  }
}

function defaultDownloadsDir(): string {
  // Each scan lands in Documents/ChunkScribe/scans/<server>/ so they're
  // organised and easy to find (no more lost-in-Downloads). Auto-create
  // the parent so the first run "just works".
  const dir = path.join(os.homedir(), 'Documents', 'ChunkScribe', 'scans')
  try { require('node:fs').mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}

function loadDefaults(): ProxyOpts {
  const expand = (s: string | undefined) =>
    s ? path.resolve(s.replace(/%([^%]+)%/g, (_, n) => process.env[n] || '')) : ''

  // Resolution order, highest priority first:
  //   1. .env / process.env (explicit user override)
  //   2. chunkscribe.config.json (last-used values saved on Start)
  //   3. Hardcoded defaults
  const saved = loadSavedOpts()

  return {
    listenHost: process.env.LISTEN_HOST || '0.0.0.0',
    listenPort: parseInt(process.env.LISTEN_PORT || '', 10) || saved.listenPort || 25566,
    targetHost: process.env.TARGET_HOST || saved.targetHost || '',
    targetPort: parseInt(process.env.TARGET_PORT || '', 10) || saved.targetPort || 25565,
    msEmail:    process.env.MS_EMAIL    || saved.msEmail    || undefined,
    version:    process.env.MC_VERSION  || saved.version    || '1.21.11',
    outputDir:  expand(process.env.OUTPUT_DIR) || saved.outputDir || defaultDownloadsDir(),
    flushIntervalSec:
      parseInt(process.env.FLUSH_INTERVAL_SEC || '', 10) ||
      saved.flushIntervalSec ||
      30,
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
    setTimeout(() => openBrowser(gui.url), 400)
  } else {
    log.info(`open ${gui.url} in your browser`)
  }

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
