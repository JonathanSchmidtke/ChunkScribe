import 'dotenv/config'
import os from 'node:os'
import path from 'node:path'
import { log } from './util/log'
import { startProxy } from './proxy'

function defaultDownloadsDir(): string {
  // Honour USERPROFILE\Downloads on Windows, $HOME/Downloads elsewhere.
  return path.join(os.homedir(), 'Downloads')
}

function required(name: string, val: string | undefined): string {
  if (!val) {
    log.err(`missing required env var ${name} (copy .env.example to .env and fill it in)`)
    process.exit(1)
  }
  return val
}

function main() {
  const opts = {
    listenHost: process.env.LISTEN_HOST || '127.0.0.1',
    listenPort: parseInt(process.env.LISTEN_PORT || '25566', 10),
    targetHost: required('TARGET_HOST', process.env.TARGET_HOST),
    targetPort: parseInt(process.env.TARGET_PORT || '25565', 10),
    msEmail: process.env.MS_EMAIL || undefined,
    version: process.env.MC_VERSION || '1.21.11',
    outputDir: process.env.OUTPUT_DIR
      ? path.resolve(process.env.OUTPUT_DIR.replace(/^%([^%]+)%/, (_, n) => process.env[n] || ''))
      : defaultDownloadsDir(),
    flushIntervalSec: parseInt(process.env.FLUSH_INTERVAL_SEC || '30', 10),
  }

  log.info(`ChunkScribe starting (mc ${opts.version})`)

  const server = startProxy(opts)

  const shutdown = (sig: string) => {
    log.info(`received ${sig}, shutting down`)
    try { server.close() } catch {}
    setTimeout(() => process.exit(0), 1000).unref()
  }
  process.on('SIGINT',  () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main()
