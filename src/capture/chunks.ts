import { log } from '../util/log'
import type { PhaseTracker } from '../phase'
import type { WorldStore } from '../world/store'

// prismarine-chunk / prismarine-registry are CJS factories.
// We resolve them lazily so a missing version manifests as a clear error
// rather than crashing the proxy on startup.
let ChunkFactory: any
let RegistryFactory: any
try { ChunkFactory    = require('prismarine-chunk') }    catch (e) { log.warn('prismarine-chunk not available:', (e as Error).message) }
try { RegistryFactory = require('prismarine-registry') } catch (e) { log.warn('prismarine-registry not available:', (e as Error).message) }

export class ChunkCapture {
  private ChunkClass: any = null
  private registry: any = null
  private capturedThisSession = 0

  constructor(
    private phase: PhaseTracker,
    private getStore: () => WorldStore,
    private version: string,
  ) {
    if (!ChunkFactory || !RegistryFactory) {
      log.err('prismarine deps missing — chunks will not be captured')
      return
    }
    try {
      this.registry = RegistryFactory(version)
      this.ChunkClass = ChunkFactory(this.registry)
    } catch (e) {
      log.err(`prismarine-chunk init failed for ${version}: ${(e as Error).message}`)
      log.err('Try lowering MC_VERSION in .env to a supported release (e.g. 1.21.4).')
    }
  }

  onChunk(p: any) {
    if (!this.ChunkClass) return
    try {
      const chunk = new this.ChunkClass({
        x: p.x,
        z: p.z,
        worldHeight: this.phase.worldHeight,
        minY: this.phase.minY,
      })

      // prismarine-chunk's load signature varies a bit across versions.
      // Try the canonical 1.18+ shape first, fall back to older signatures.
      const data = p.chunkData ?? p.data
      try {
        chunk.load(data, p.bitMap ?? true, p.skyLightMask, p.blockLightMask)
      } catch {
        try { chunk.load(data, true) }
        catch { chunk.networkLoad?.(data) }
      }

      // Block entities arrive in the same packet on modern versions
      const blockEntities = p.blockEntities ?? p['block-entities']
      if (Array.isArray(blockEntities)) {
        for (const be of blockEntities) {
          try { chunk.setBlockEntity?.({ x: be.x, y: be.y, z: be.z }, be) } catch {}
        }
      }

      this.getStore().setColumn(p.x, p.z, chunk)
      this.capturedThisSession++
      if (this.capturedThisSession % 100 === 0) {
        log.info(`captured ${this.capturedThisSession} chunks (current dim: ${this.phase.dimensionName})`)
      }
    } catch (e) {
      log.dbg(`chunk ${p.x},${p.z} parse failed: ${(e as Error).message}`)
    }
  }

  onUnload(p: any) {
    // The server unloading a chunk does NOT mean we should drop it —
    // we want to keep what we've already seen. Just trace it.
    log.dbg('unload', p.chunkX ?? p.x, p.chunkZ ?? p.z)
  }
}
