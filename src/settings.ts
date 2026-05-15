import fs from 'node:fs'
import path from 'node:path'
import { log } from './util/log'
import type { ProxyOpts } from './proxy'

const FILE = path.resolve('chunkscribe.config.json')

/**
 * Last-used values persisted to disk so the user doesn't retype the
 * target server on every launch. `.env` (process.env) still takes
 * precedence — explicit config beats remembered config.
 */
export function loadSavedOpts(): Partial<ProxyOpts> {
  try {
    if (!fs.existsSync(FILE)) return {}
    const raw = fs.readFileSync(FILE, 'utf8')
    const j = JSON.parse(raw)
    log.info(`loaded saved settings from ${FILE}`)
    return j ?? {}
  } catch (e) {
    log.warn(`could not read ${FILE}: ${(e as Error).message}`)
    return {}
  }
}

export function saveOpts(opts: ProxyOpts) {
  try {
    const payload = {
      targetHost: opts.targetHost,
      targetPort: opts.targetPort,
      msEmail:    opts.msEmail,
      listenPort: opts.listenPort,
      version:    opts.version,
      outputDir:  opts.outputDir,
      flushIntervalSec: opts.flushIntervalSec,
    }
    fs.writeFileSync(FILE, JSON.stringify(payload, null, 2), 'utf8')
  } catch (e) {
    log.warn(`could not write ${FILE}: ${(e as Error).message}`)
  }
}
