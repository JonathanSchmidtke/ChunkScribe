import { log } from '../util/log'
import { emitChunk } from '../gui/bus'
import type { PhaseTracker } from '../phase'
import type { WorldStore } from '../world/store'
import type { RegistryCapture } from './registry'

// prismarine-chunk / prismarine-registry are CJS factories.
// We resolve them lazily so a missing version manifests as a clear error
// rather than crashing the proxy on startup.
let ChunkFactory: any
let RegistryFactory: any
try { ChunkFactory    = require('prismarine-chunk') }    catch (e) { log.warn('prismarine-chunk not available:', (e as Error).message) }
try { RegistryFactory = require('prismarine-registry') } catch (e) { log.warn('prismarine-registry not available:', (e as Error).message) }

export class ChunkCapture {
  private ChunkClass: any = null
  /** Exposed so WorldSaver can pass the SAME (patched) registry into
   *  prismarine-provider-anvil. Without this, Anvil creates its own fresh
   *  prismarine-registry from the version string — our biome ID→name patch
   *  is never seen on the write path and chunks ship with vanilla-default
   *  biome names. */
  registry: any = null
  private capturedThisSession = 0
  private biomeRegistryPatched = false
  /** Chunks received in the current batch, not yet committed to the store.
   *  Held back so a periodic flush can't serialise a half-streamed chunk. */
  private pendingBatch = new Map<string, { x: number; z: number; chunk: any }>()

  constructor(
    private phase: PhaseTracker,
    private getStore: () => WorldStore,
    private version: string,
    private serverRegistry: RegistryCapture,
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

  /**
   * Replace prismarine-chunk's biome registry indexing with the server's
   * ordering, so chunk-packet biome IDs (which are server-registry indices)
   * deserialize to the right biome names. Without this, a chunk that the
   * server labelled biome-id 28 = gridlock:custom_jungle gets read as
   * vanilla biome-id 28 = `basalt_deltas` (or whatever the alphabetical
   * vanilla order says) → wrong colors, wrong mob spawns, wrong everything.
   * For custom biomes (gridlock:*) we substitute the closest vanilla biome
   * by temperature + grass color.
   */
  private patchBiomeRegistry() {
    if (this.biomeRegistryPatched) return
    if (!this.registry?.biomesArray) return
    const ordered = this.serverRegistry.biomesOrdered
    if (!ordered || ordered.length === 0) return

    const vanillaByName: Record<string, any> = this.registry.biomesByName || {}
    const vanillaArr: any[] = this.registry.biomesArray
    const patched: any[] = []
    let customRemapped = 0

    for (let serverIdx = 0; serverIdx < ordered.length; serverIdx++) {
      const fullName = ordered[serverIdx]
      const bare = fullName.replace(/^minecraft:/, '')
      const vanillaHit = vanillaByName[bare]
      if (vanillaHit) {
        // Vanilla biome under a different index than the server uses — same
        // entry, just placed at the server's index so prismarine-chunk
        // reads chunk IDs correctly.
        patched[serverIdx] = { ...vanillaHit, id: serverIdx }
      } else {
        // Custom / datapack biome — pick the closest vanilla equivalent
        // using the server-supplied biome definition (temperature, color).
        const customDef = this.serverRegistry.biomes[fullName]
        const closest = closestVanillaBiome(customDef, vanillaArr)
        patched[serverIdx] = { ...closest, id: serverIdx, name: closest.name, _origName: fullName }
        customRemapped++
      }
    }

    this.registry.biomesArray = patched
    // CRITICAL: prismarine-provider-anvil's chunk writer uses
    //   registry.biomes[biomeId].name
    // (by-ID dict, NOT biomesArray) to translate chunk biome palette IDs
    // into the names written to disk. We MUST also rewrite that dict, or
    // the saved chunk gets wrong biome names (overworld chunks tagged
    // basalt_deltas, end_midlands etc.) regardless of our biomesArray fix.
    const newBiomesById: Record<number, any> = {}
    for (let i = 0; i < patched.length; i++) newBiomesById[i] = patched[i]
    this.registry.biomes = newBiomesById
    // biomesByName lookup is name→data; doesn't need re-keying because
    // chunk-load only uses ID→name. Leaving vanilla-keyed.
    log.info(`biome registry patched: ${ordered.length} server biomes, ${customRemapped} custom remapped to closest vanilla`)
    this.biomeRegistryPatched = true
  }

  onChunk(p: any) {
    if (!this.ChunkClass) return
    if (!this.biomeRegistryPatched) this.patchBiomeRegistry()
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

      // Block entities in the chunk packet have shape
      //   { packedXZ, y, type, nbtData }
      // where packedXZ packs chunk-local coords (high nibble = x, low = z)
      // and nbtData is the actual NBT compound. Previously we passed the raw
      // network-form `be` object as the NBT — prismarine-chunk serialised
      // packedXZ/type as if they were NBT tags, producing malformed bytes
      // that closed the chunk's root compound early. MC then read the chunk
      // as empty → black hole at every BE-bearing chunk (~1.9% of explored
      // area, matching the gap pattern on the map).
      const blockEntities = p.blockEntities ?? p['block-entities']
      if (Array.isArray(blockEntities)) {
        for (const be of blockEntities) {
          let nbt = be?.nbtData
          // 1.18+ network format strips the `id` field from nbtData — it's
          // derived from be.type (registry index into block_entity_type).
          // nbtData itself might be empty / undefined for stateless BEs like
          // beds. We MUST synthesise id from the type or MC's BlockEntity
          // renderer never registers the entity:
          //   - bed/chest/sign/bell/banner/lectern/etc. use `builtin/entity`
          //     models — invisible without a BE the BlockEntityRenderer can
          //     hook (no BE = no rendering callback = invisible block with
          //     hitbox).
          // Previously we skipped these with `if (!v.id) continue` which is
          // why beds and chests came out invisible after capture.
          if (!nbt || typeof nbt !== 'object' || !nbt.value) {
            nbt = { type: 'compound', name: '', value: {} }
          }
          const localX = (be.packedXZ >> 4) & 0xF
          const localZ = be.packedXZ & 0xF
          const worldX = p.x * 16 + localX
          const worldZ = p.z * 16 + localZ
          const v = nbt.value
          if (!v.id) {
            const idName = this.resolveBlockEntityId(be.type)
            if (!idName) continue   // unknown type — can't safely inject
            v.id = { type: 'string', value: idName }
          }
          if (!v.x) v.x = { type: 'int', value: worldX }
          if (!v.y) v.y = { type: 'int', value: be.y }
          if (!v.z) v.z = { type: 'int', value: worldZ }
          try { chunk.setBlockEntity?.({ x: localX, y: be.y, z: localZ }, nbt) } catch {}
        }
      }

      // Stash in pendingBatch instead of committing straight to the store.
      // Without this, the periodic flush can serialise a chunk before target
      // finished sending all its block updates (chunk_batch_finished hasn't
      // arrived yet) → partial NBT on disk → MC crashes on chunk read.
      // Commit happens in onBatchFinished below.
      this.pendingBatch.set(`${p.x},${p.z}`, { x: p.x, z: p.z, chunk })
    } catch (e) {
      log.dbg(`chunk ${p.x},${p.z} parse failed: ${(e as Error).message}`)
    }
  }

  onUnload(p: any) {
    // The server unloading a chunk does NOT mean we should drop it —
    // we want to keep what we've already seen. Just trace it.
    log.dbg('unload', p.chunkX ?? p.x, p.chunkZ ?? p.z)
  }

  /** Called when target sends chunk_batch_finished — every chunk in the
   *  pending batch is now fully delivered and safe to write to disk. */
  onBatchFinished() {
    if (this.pendingBatch.size === 0) return
    const store = this.getStore()
    const dim = this.phase.dimensionName
    for (const { x, z, chunk } of this.pendingBatch.values()) {
      store.setColumn(x, z, chunk)
      this.capturedThisSession++
      emitChunk({ x, z, dim })
    }
    if (this.capturedThisSession % 500 < this.pendingBatch.size) {
      log.info(`captured ${this.capturedThisSession} chunks (current dim: ${dim})`)
    }
    this.pendingBatch.clear()
  }

  /** Force-commit any pending chunks (final flush at session end). */
  drainPending() { this.onBatchFinished() }

  /** Lazily-built map from block_entity_type registry index → BE id string
   *  (e.g. 12 → "minecraft:bed"). Source is the captured server registry. */
  private beTypeById: string[] | null = null

  private resolveBlockEntityId(typeIdx: any): string | null {
    if (typeof typeIdx !== 'number') return null
    if (this.beTypeById == null) {
      const reg = this.serverRegistry.registries['minecraft:block_entity_type']
      if (!reg?.entries || !Array.isArray(reg.entries)) {
        // No registry yet — bail; next chunk will retry.
        return null
      }
      const arr: string[] = reg.entries.map((e: any) => e.key ?? e.id ?? '')
      this.beTypeById = arr
      log.info(`block_entity_type registry: ${arr.length} entries (sample: ${arr.slice(0, 5).join(',')})`)
    }
    return this.beTypeById[typeIdx] ?? null
  }
}

/**
 * Pick the vanilla biome whose temperature + grass-color profile is closest
 * to a custom server biome. Used to remap datapack biomes (gridlock:*) to
 * something MC will actually render with reasonable colors.
 *
 * The server biome definition from registry_data looks like:
 *   { temperature: 0.8, downfall: 0.4, has_precipitation: 1,
 *     effects: { grass_color: 6975545, sky_color: ..., fog_color: ..., ... } }
 * Older shape: { temperature, downfall, effects: {...} } at the top level,
 * sometimes wrapped in { element: {...} }.
 */
function closestVanillaBiome(serverDef: any, vanillaArr: any[]): any {
  const PLAINS = vanillaArr.find(b => b.name === 'plains') || vanillaArr[0]
  if (!serverDef || vanillaArr.length === 0) return PLAINS

  const def = serverDef.element ?? serverDef
  const sTemp  = num(def.temperature)
  const sRain  = def.has_precipitation === 1 || def.has_precipitation === true || def.has_precipitation === 'true'
  const sGrass = num(def.effects?.grass_color ?? def.effects?.grass_color_modifier_value)
  const sFog   = num(def.effects?.fog_color)

  let best = PLAINS
  let bestScore = Infinity
  for (const v of vanillaArr) {
    if (v.dimension && v.dimension !== 'overworld') continue // overworld→overworld bias
    const dTemp  = sTemp == null  ? 0 : Math.abs((num(v.temperature) ?? 0.5) - sTemp) * 4
    const dRain  = (v.has_precipitation === sRain) ? 0 : 1.5
    const dGrass = sGrass == null ? 0 : colorDist(sGrass, num(v.color) ?? 0) / 200
    const dFog   = sFog   == null ? 0 : colorDist(sFog,   num(v.color) ?? 0) / 800
    const score = dTemp + dRain + dGrass + dFog
    if (score < bestScore) { bestScore = score; best = v }
  }
  return best
}

function num(v: any): number | null {
  if (typeof v === 'number') return v
  if (typeof v === 'string') { const n = Number(v); return Number.isFinite(n) ? n : null }
  return null
}

function colorDist(a: number, b: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff
  const dr = ar - br, dg = ag - bg, db = ab - bb
  return Math.sqrt(dr*dr + dg*dg + db*db)
}
