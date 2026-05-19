import fs from 'node:fs/promises'
import fssync from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import http from 'node:http'
import { log } from '../util/log'
import { emit } from '../gui/bus'

interface CapturedPack {
  url: string
  hash: string
  uuid?: string
  forced?: boolean
  filePath: string  // absolute path to downloaded .zip
}

/**
 * Captures every resource pack the server pushes (configuration + play
 * phase) so the transformed world can load them automatically. Without
 * the server's pack, custom-modeled blocks (Gridlock's chests, beds,
 * flower pots, decorative furniture etc.) render as invisible because
 * the pack replaces the vanilla block models with `builtin/entity` +
 * custom display-entity art that needs pack assets.
 *
 * Download policy:
 *  - Same URL+hash: skip (already on disk)
 *  - HEAD-first with redirect follow, then GET
 *  - Capped at MAX_BYTES so a malicious or huge pack can't fill the disk
 *  - Stored under <scanDir>/resourcepacks/<short-hash>.zip
 */
export class ResourcePackCapture {
  private packs = new Map<string, CapturedPack>()
  private inflight = new Set<string>()
  private packsDir: string
  private downloadedCount = 0

  constructor(scanRoot: string) {
    this.packsDir = path.join(scanRoot, 'resourcepacks')
    fssync.mkdirSync(this.packsDir, { recursive: true })
  }

  /** Called by Capture.handle when a resource_pack_push / add_resource_pack
   *  packet arrives. Packet field names changed across versions; tolerate
   *  several shapes. */
  onPush(data: any) {
    const url: string | undefined =
      data?.url ?? data?.packUrl ?? data?.resourcePackUrl
    const hash: string | undefined =
      data?.hash ?? data?.packHash ?? data?.resourcePackHash ?? ''
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return

    const key = `${url}#${hash}`
    if (this.packs.has(key) || this.inflight.has(key)) return
    this.inflight.add(key)

    const fileName = `${shortHash(hash || url)}.zip`
    const filePath = path.join(this.packsDir, fileName)
    log.info(`resource pack push: ${url.slice(0, 80)}${url.length > 80 ? '…' : ''}`)

    this.download(url, filePath)
      .then(size => {
        this.packs.set(key, {
          url, hash: hash || '',
          uuid: uuidToString(data?.uuid),
          forced: !!data?.forced,
          filePath,
        })
        this.downloadedCount++
        log.info(`resource pack saved: ${path.basename(filePath)} (${(size / 1024).toFixed(1)} KB)`)
        emit({ type: 'log', level: 'info', msg: `resource pack saved (${(size / 1024).toFixed(1)} KB)`, ts: Date.now() })
      })
      .catch(e => log.warn(`resource pack download failed: ${(e as Error).message}`))
      .finally(() => this.inflight.delete(key))
  }

  /** Path list of downloaded packs in push order (used by saver). */
  list(): CapturedPack[] { return [...this.packs.values()] }
  count(): number { return this.downloadedCount }

  private download(url: string, dst: string): Promise<number> {
    const MAX_BYTES = 200 * 1024 * 1024 // 200 MB safety cap
    return new Promise((resolve, reject) => {
      const visit = (u: string, redirectsLeft: number) => {
        const lib = u.startsWith('https') ? https : http
        const req = lib.get(u, res => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.destroy()
            if (redirectsLeft <= 0) return reject(new Error('too many redirects'))
            return visit(new URL(res.headers.location, u).toString(), redirectsLeft - 1)
          }
          if (res.statusCode !== 200) return reject(new Error(`status ${res.statusCode}`))
          const out = fssync.createWriteStream(dst)
          let bytes = 0
          res.on('data', chunk => {
            bytes += chunk.length
            if (bytes > MAX_BYTES) { res.destroy(); out.destroy(); reject(new Error('pack exceeds 200MB cap')) }
          })
          res.pipe(out)
          out.on('finish', () => resolve(bytes))
          out.on('error', reject)
          res.on('error', reject)
        })
        req.on('error', reject)
        req.setTimeout(60_000, () => { req.destroy(new Error('download timeout')) })
      }
      visit(url, 5)
    })
  }
}

function shortHash(s: string): string {
  if (s && s.length >= 8) return s.slice(0, 16)
  // Fall back to a deterministic hash of the URL if no hash provided
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return `url-${(h >>> 0).toString(16)}`
}

function uuidToString(u: any): string | undefined {
  if (typeof u === 'string') return u
  // minecraft-protocol may give a 2-tuple of bigints or an int128 buffer
  if (Array.isArray(u) && u.length === 4) {
    return u.map(n => (n >>> 0).toString(16).padStart(8, '0')).join('-')
  }
  return undefined
}

/** Copy each captured pack into the transformed world. Modern MC reads
 *  `<world>/resources.zip` automatically as a world-specific pack — we use
 *  the FIRST pack the server pushed (typically the only one for game
 *  servers). Additional packs are also copied alongside in case the user
 *  wants to inspect / enable them. */
export async function bundlePacksIntoWorld(packsDir: string, worldDir: string): Promise<{ bundled: boolean; copied: number }> {
  let bundled = false
  let copied = 0
  try {
    const files = await fs.readdir(packsDir)
    const zips = files.filter(f => f.endsWith('.zip'))
    if (zips.length === 0) return { bundled, copied }
    // Sort by mtime ascending so the EARLIEST push (configuration phase
    // = the base server pack) wins the resources.zip slot.
    const stat = await Promise.all(zips.map(async f => ({ f, m: (await fs.stat(path.join(packsDir, f))).mtimeMs })))
    stat.sort((a, b) => a.m - b.m)
    const primary = stat[0].f
    await fs.copyFile(path.join(packsDir, primary), path.join(worldDir, 'resources.zip'))
    bundled = true
    // Copy any remaining packs into a sidecar folder for the user.
    if (stat.length > 1) {
      const side = path.join(worldDir, 'datapacks-extra')
      await fs.mkdir(side, { recursive: true })
      for (const { f } of stat.slice(1)) {
        await fs.copyFile(path.join(packsDir, f), path.join(side, f))
        copied++
      }
    }
  } catch (e) {
    log.warn(`bundle resource packs failed: ${(e as Error).message}`)
  }
  return { bundled, copied }
}
