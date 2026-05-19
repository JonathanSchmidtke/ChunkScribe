import fs from 'node:fs'
import path from 'node:path'
import { log } from './util/log'
import type { ProxyOpts } from './proxy'

const FILE = path.resolve('chunkscribe.config.json')

interface StoredConfig extends Partial<ProxyOpts> {
  /** Last user-chosen Minecraft saves directory (e.g. an ATLauncher
   *  instance). When set, defaultSavesDir() returns this instead of the
   *  vanilla %APPDATA%\.minecraft\saves path. Survives proxy restarts. */
  savesDir?: string
}

function readFile(): StoredConfig {
  try {
    if (!fs.existsSync(FILE)) return {}
    return JSON.parse(fs.readFileSync(FILE, 'utf8')) ?? {}
  } catch (e) {
    log.warn(`could not read ${FILE}: ${(e as Error).message}`)
    return {}
  }
}

function writeFile(cfg: StoredConfig) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2), 'utf8')
  } catch (e) {
    log.warn(`could not write ${FILE}: ${(e as Error).message}`)
  }
}

/**
 * Last-used proxy values persisted to disk so the user doesn't retype the
 * target server on every launch. `.env` (process.env) still takes
 * precedence — explicit config beats remembered config.
 */
export function loadSavedOpts(): Partial<ProxyOpts> {
  const cfg = readFile()
  if (Object.keys(cfg).length) log.info(`loaded saved settings from ${FILE}`)
  return cfg
}

export function saveOpts(opts: ProxyOpts) {
  const cur = readFile()
  writeFile({
    ...cur,
    targetHost: opts.targetHost,
    targetPort: opts.targetPort,
    msEmail:    opts.msEmail,
    listenPort: opts.listenPort,
    version:    opts.version,
    // outputDir intentionally not persisted — always auto-resolved to
    // Documents/ChunkScribe/scans (or OUTPUT_DIR env override).
    flushIntervalSec: opts.flushIntervalSec,
    cape:       opts.cape,
  })
}

export function loadSavedSavesDir(): string | undefined {
  return readFile().savesDir
}

export function saveSavesDir(savesDir: string) {
  const cur = readFile()
  writeFile({ ...cur, savesDir })
}
