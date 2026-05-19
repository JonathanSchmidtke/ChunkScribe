import path from 'node:path'
import fs from 'node:fs/promises'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import { log } from '../util/log'
import { emit } from '../gui/bus'
import type { WorldStore } from './store'
import type { PhaseTracker } from '../phase'
import type { RegistryCapture } from '../capture/registry'
import type { WorldStateCapture } from '../capture/worldState'
import type { EntityCapture } from '../capture/entities'
import type { ContainerCapture } from '../capture/containers'
import { planForDim, DimSavePlan } from './datapack'

const gzip = promisify(zlib.gzip)

let AnvilFactory: any
let nbt: any
try { AnvilFactory = require('prismarine-provider-anvil').Anvil } catch (e) { log.warn('prismarine-provider-anvil missing:', (e as Error).message) }
try { nbt = require('prismarine-nbt') }                              catch (e) { log.warn('prismarine-nbt missing:', (e as Error).message) }

export class WorldSaver {
  private registry: RegistryCapture | null = null
  private worldState: WorldStateCapture | null = null
  private entities: EntityCapture | null = null
  private containers: ContainerCapture | null = null
  private inFlight: Promise<void> | null = null

  constructor(
    private root: string,
    private version: string,
    private phase: PhaseTracker,
  ) {}

  attachRegistry(r: RegistryCapture)            { this.registry   = r }
  attachWorldState(s: WorldStateCapture)        { this.worldState = s }
  attachEntities(e: EntityCapture)              { this.entities   = e }
  attachContainers(c: ContainerCapture)         { this.containers = c }
  /** Provides a getter (called lazily at flush time) for the prismarine-registry
   *  instance that ChunkCapture mutated with the server's biome ordering. Anvil
   *  factory accepts a registry in place of a version string; passing ours
   *  ensures the writer's biomes[id].name lookup matches what we stored on the
   *  chunks. Without this, the writer falls back to vanilla-default ordering
   *  and biome names get scrambled on disk. */
  attachChunkRegistry(g: () => any)             { this.getChunkRegistry = g }
  private getChunkRegistry: () => any = () => null
  attachDimMapping(g: () => Map<string, string>) { this.getDimMapping = g }
  private getDimMapping: () => Map<string, string> = () => new Map()

  private dimSubpath(dim: string): string {
    if (dim === 'minecraft:overworld')   return ''
    if (dim === 'minecraft:the_nether')  return 'DIM-1'
    if (dim === 'minecraft:the_end')     return 'DIM1'
    const [ns, name] = dim.split(':')
    return path.join('dimensions', ns, name)
  }

  /** Look up the captured (server-side) geometry for a dim. Returns null
   *  if no chunks for this dim were captured or the dim_type didn't
   *  resolve — caller falls back to overworld defaults. */
  private dimGeometry(dim: string): { minY: number; height: number } {
    const dimType = this.getDimMapping().get(dim)
    if (dimType && this.registry) {
      const g = this.registry.dimensionGeometry(dimType)
      if (g) return { minY: g.minY, height: g.worldHeight }
    }
    return { minY: -64, height: 384 }
  }

  /** Build the save plan (vanilla vs custom dim_type) for a captured dim
   *  based on its captured geometry. Cached during a flush via planForDim. */
  private planFor(dim: string): DimSavePlan {
    return planForDim(dim, this.dimGeometry(dim))
  }

  async flush(stores: Map<string, WorldStore>): Promise<void> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.doFlush(stores).finally(() => { this.inFlight = null })
    return this.inFlight
  }

  private async doFlush(stores: Map<string, WorldStore>) {
    if (!AnvilFactory) { log.err('cannot save: prismarine-provider-anvil not installed'); return }
    await fs.mkdir(this.root, { recursive: true })

    // Final-flush any half-open containers so we don't lose recent opens.
    try { this.containers?.flushAll() } catch (e) { log.warn('container flushAll failed:', e) }

    // Patch entity NBT into chunks before saving them.
    if (this.entities) this.applyEntitiesToChunks(stores)

    let totalSaved = 0
    for (const [dim, store] of stores) {
      if (store.size() === 0) continue
      const dir = path.join(this.root, this.dimSubpath(dim))
      const regionDir = path.join(dir, 'region')
      await fs.mkdir(regionDir, { recursive: true })

      let provider: any
      try {
        // Pass the patched prismarine-registry instance (from ChunkCapture)
        // rather than the version string. anvil's chunk-write path resolves
        // biome ID→name via registry.biomes[id].name; using the patched
        // registry keeps the write path consistent with what was captured.
        const patchedReg = this.getChunkRegistry()
        const Cls = AnvilFactory(patchedReg ?? this.version)
        // prismarine-provider-anvil's Anvil class doesn't auto-append /region —
        // it writes .mca files into whatever path it's handed. Pass the region
        // dir directly so files land in the canonical Mojang layout
        // (<dim>/region/r.X.Z.mca) and listScans / vanilla MC find them.
        provider = new Cls(regionDir)
      } catch (e) {
        log.err(`anvil provider init failed for ${this.version}: ${(e as Error).message}`)
        continue
      }

      // Columns were parsed at the server's actual dim geometry (via
      // the registry resolver in capture/index.ts) so they already have
      // the right minY/height. No clipping/shifting at save time —
      // sections land at their captured Y coords. The dim_type we
      // reference in level.dat + datapack matches that geometry, so MC
      // accepts the chunks intact.
      let n = 0
      for (const [key, column] of store.entries()) {
        const [x, z] = key.split(',').map(Number)
        try { await provider.save(x, z, column); n++ }
        catch (e) { log.dbg(`save ${dim} ${x},${z} failed: ${(e as Error).message}`) }
      }
      log.info(`flushed ${n}/${store.size()} columns of ${dim} -> ${dir} (geometry minY=${this.dimGeometry(dim).minY} height=${this.dimGeometry(dim).height})`)
      totalSaved += n
    }

    if (totalSaved > 0) {
      await this.writeLevelDat(stores)
      await this.writeRegistryDatapack()
      await this.dumpCapturedRegistryDebug()
      this.logTeleportHints(stores)
    }
    emit({ type: 'flush', total: totalSaved, ok: totalSaved })
  }

  /** Diagnostic: serialise the captured dim_type registry to JSON so we
   *  can see the exact NBT shape Gridlock ships. Written next to the scan
   *  root so it travels with the scan if shared. */
  private async dumpCapturedRegistryDebug() {
    if (!this.registry) return
    try {
      const payload = {
        dimensionTypes: this.registry.dimensionTypes,
        dimensionTypesOrdered: (this.registry as any).dimensionTypesOrdered ?? [],
      }
      const file = path.join(this.root, 'chunkscribe-debug.json')
      await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8')
      log.info(`wrote registry debug dump: ${file}`)
    } catch (e) {
      log.warn(`registry debug dump failed: ${(e as Error).message}`)
    }
  }

  /** Print one /execute-in-dim /tp command per captured dim, aimed at the
   *  middle chunk of that dim. Saves the user from wandering through void
   *  trying to find where the captured terrain actually sits on the map. */
  private logTeleportHints(stores: Map<string, WorldStore>) {
    log.info('--- TP HINTS (paste into MC chat to jump to captured terrain) ---')
    for (const [dim, store] of stores) {
      const keys = Array.from(store.keys())
      if (keys.length === 0) continue
      const mid = keys[Math.floor(keys.length / 2)]
      const [cx, cz] = mid.split(',').map(Number)
      const x = cx * 16 + 8, z = cz * 16 + 8
      log.info(`  ${dim}  /execute in ${dim} run tp @s ${x} 200 ${z}   (${store.size()} chunks)`)
    }
    log.info('-----------------------------------------------------------------')
  }

  /** Persist the server's biome / dimension_type / dimension registry as
   *  a per-world datapack inside the scan dir. Transform copies the scan
   *  to <world>/, so the datapack ends up at <world>/datapacks/chunkscribe/
   *  and gets enabled in level.dat via enableDatapackInLevelDat. Without
   *  this datapack, custom biomes (gridlock:* and any vanilla-named biomes
   *  the server overrode) render with vanilla colors instead of Gridlock's. */
  private async writeRegistryDatapack() {
    if (!this.registry) return
    try {
      const { writeServerRegistryDatapack, buildVoidDimensionEntries } = await import('./datapack')
      const plans: DimSavePlan[] = []
      for (const [dimName] of this.getDimMapping()) plans.push(this.planFor(dimName))
      const dims = buildVoidDimensionEntries(plans)
      await writeServerRegistryDatapack(this.root, {
        biomes: this.registry.biomes,
        dimensionTypes: this.registry.dimensionTypes,
        dimensions: dims,
      })
    } catch (e) {
      log.warn(`registry datapack write failed: ${(e as Error).message}`)
    }
  }

  /**
   * Best-effort: try chunk.addEntity() or chunk.entities.push(); otherwise
   * write a sidecar entities.json so the data isn't lost. Vanilla won't
   * read the sidecar — it's for diagnostics / external tools.
   */
  private applyEntitiesToChunks(stores: Map<string, WorldStore>) {
    if (!this.entities) return
    // Last chance to resolve any entity types that spawned before the
    // registry was populated.
    this.entities.resolvePending()

    const grouped = this.entities.byChunk()
    let written = 0, dropped = 0
    for (const [dim, perChunk] of grouped) {
      const store = stores.get(dim); if (!store) continue
      for (const [key, list] of perChunk) {
        const [cx, cz] = key.split(',').map(Number)
        const chunk = store.getColumn(cx, cz); if (!chunk) continue
        for (const e of list) {
          const nbtEntity = entityToNbt(e)
          if (!nbtEntity) { dropped++; continue }
          try {
            // Only write entities through prismarine-chunk's official API.
            // The previous __entities sidecar attached non-standard data to the
            // chunk object which the anvil writer happily serialised — vanilla
            // MC then failed to parse those chunks ("malformed NBT") so the
            // whole region became a black hole on the map. Drop instead.
            if (typeof chunk.addEntity === 'function') {
              chunk.addEntity(nbtEntity); written++
            } else if (Array.isArray(chunk.entities)) {
              chunk.entities.push(nbtEntity); written++
            } else {
              dropped++
            }
          } catch { dropped++ }
        }
      }
    }
    if (written + dropped > 0) log.info(`entities patched into chunks: ${written} written, ${dropped} dropped (unresolved type)`)
  }

  private async writeLevelDat(stores: Map<string, WorldStore>) {
    if (!nbt) return
    const ws = this.worldState
    // MC 1.21.11 release: 4671. Earlier default (3953) was 1.20.x and made
    // MC silently "upgrade" the chunks on first open, which is lossy and
    // can shift block states. Override via MCWD_DATAVERSION env if needed.
    const dataVersion = parseInt(process.env.MCWD_DATAVERSION || '4671', 10)
    const now = BigInt(Date.now())

    // Find a real captured chunk to spawn into. Without this the player
    // lands at (0, -6, 0) in a void-flat dim and falls forever. We pick
    // the dim with the most chunks (skipping vanilla and lobby) and use
    // the centre of one of its chunks as Player.Pos.
    const spawn = this.pickRealSpawn(stores)

    const tag = {
      type: 'compound',
      name: '',
      value: {
        Data: {
          type: 'compound',
          value: {
            version: { type: 'int', value: 19133 },
            DataVersion: { type: 'int', value: dataVersion },
            LevelName: { type: 'string', value: 'ChunkScribe Download' },
            GameType: { type: 'int', value: 3 },
            Difficulty: { type: 'byte', value: ws?.difficulty ?? 2 },
            DifficultyLocked: { type: 'byte', value: ws?.difficultyLocked ? 1 : 0 },
            allowCommands: { type: 'byte', value: 1 },
            hardcore: { type: 'byte', value: 0 },
            initialized: { type: 'byte', value: 1 },
            SpawnX: { type: 'int', value: spawn.x },
            SpawnY: { type: 'int', value: spawn.y },
            SpawnZ: { type: 'int', value: spawn.z },
            SpawnAngle: { type: 'float', value: ws?.spawnAngle ?? 0 },
            Time:       { type: 'long', value: bigintToLongPair(absBig(ws?.worldAge   ?? 0n)) },
            DayTime:    { type: 'long', value: bigintToLongPair(absBig(ws?.timeOfDay  ?? 0n)) },
            LastPlayed: { type: 'long', value: bigintToLongPair(now) },
            RandomSeed: { type: 'long', value: bigintToLongPair(this.phase.hashedSeed) },
            raining:        { type: 'byte', value: ws?.raining ? 1 : 0 },
            thundering:     { type: 'byte', value: ws?.thunder ? 1 : 0 },
            rainTime:       { type: 'int',  value: 0 },
            thunderTime:    { type: 'int',  value: 0 },
            BorderCenterX:        { type: 'double', value: ws?.borderCenterX ?? 0 },
            BorderCenterZ:        { type: 'double', value: ws?.borderCenterZ ?? 0 },
            BorderSize:           { type: 'double', value: ws?.borderDiameter ?? 60_000_000 },
            BorderSafeZone:       { type: 'double', value: 5 },
            BorderWarningBlocks:  { type: 'double', value: ws?.borderWarnBlocks ?? 5 },
            BorderWarningTime:    { type: 'double', value: ws?.borderWarnTime ?? 15 },
            GameRules: { type: 'compound', value: {} },
            // Force the player to spawn in the gridlock-namespaced overworld
            // (or whatever the player's captured dim was), because that's
            // where the captured chunks live. Without this, MC spawns the
            // player in vanilla minecraft:overworld which has NO chunks
            // (we no longer squash gridlock:overworld onto it), so the
            // player sees void everywhere until they /tp to gridlock:overworld.
            Player: { type: 'compound', value: this.buildPlayerNbt(spawn) },
            // Write a full vanilla 3-dim worldgen preset PLUS every custom
            // dim we visited. MC's codec rejects the level.dat if any dim
            // referenced by `dimensions/<ns>/<name>/region/` ISN'T declared
            // in WorldGenSettings.dimensions. The custom dims point at the
            // dim_type the server told us (e.g. gridlock:nether ->
            // gridlock:nether_dimtype), preserving Y-range and ceiling/skylight
            // properties so chunks load at their original coordinates.
            WorldGenSettings: {
              type: 'compound',
              value: {
                seed:              { type: 'long', value: bigintToLongPair(this.phase.hashedSeed) },
                generate_features: { type: 'byte', value: 1 },
                bonus_chest:       { type: 'byte', value: 0 },
                dimensions: {
                  type: 'compound',
                  value: this.buildAllDimensions(),
                },
              },
            },
          },
        },
      },
    }
    const uncompressed = nbt.writeUncompressed(tag, 'big')
    const buf: Buffer = Buffer.isBuffer(uncompressed) ? uncompressed : Buffer.from(uncompressed)
    const out = await gzip(buf)
    await fs.writeFile(path.join(this.root, 'level.dat'), out)
    log.info(`wrote level.dat (DataVersion=${dataVersion}, spawn=${ws?.spawnX ?? 0},${ws?.spawnY ?? 64},${ws?.spawnZ ?? 0})`)
  }

  /** Pick the dim with the most captured chunks (skipping vanilla + lobby
   *  dims) and return the centre coordinate of one of its chunks. Falls
   *  back to (0,80,0) only if no captured chunks exist anywhere — that's
   *  void territory, but in that case there's nothing to spawn into. */
  private pickRealSpawn(stores: Map<string, WorldStore>): { dim: string; x: number; y: number; z: number } {
    const skipLobby = /\b(limbo|lobby|hub|spawn_area|waiting|queue|game_lobby)\b/i
    // Score each candidate. Prefer an "overworld" dim by name (that's the
    // map players actually want to spawn into), then fall back to whichever
    // dim has the most chunks. Pick the MIDDLE captured chunk's center —
    // first/last chunks are often the edge of the captured area.
    let best: { dim: string; score: number; cx: number; cz: number } | null = null
    for (const [dim, store] of stores) {
      if (skipLobby.test(dim)) continue
      const size = store.size()
      if (size === 0) continue
      const keys = Array.from(store.keys())
      const mid = keys[Math.floor(keys.length / 2)]
      const [cx, cz] = mid.split(',').map(Number)
      const isOverworld = /overworld/i.test(dim)
      const score = size + (isOverworld ? 1_000_000 : 0)
      if (!best || score > best.score) best = { dim, score, cx, cz }
    }
    if (!best) return { dim: this.phase.dimensionName || 'minecraft:overworld', x: 0, y: 80, z: 0 }
    return { dim: best.dim, x: best.cx * 16 + 8, y: 200, z: best.cz * 16 + 8 }
  }

  /** Build a minimal Player NBT pinning the player at the picked spawn.
   *  Creative + flying + mayfly so the player floats above the captured
   *  chunk regardless of where the actual surface is. */
  private buildPlayerNbt(spawn: { dim: string; x: number; y: number; z: number }): any {
    return {
      Dimension: { type: 'string', value: spawn.dim },
      Pos: {
        type: 'list',
        value: { type: 'double', value: [spawn.x + 0.5, spawn.y, spawn.z + 0.5] },
      },
      Rotation: {
        type: 'list',
        value: { type: 'float', value: [0, 0] },
      },
      Motion: {
        type: 'list',
        value: { type: 'double', value: [0, 0, 0] },
      },
      OnGround:    { type: 'byte', value: 0 },
      Air:         { type: 'short', value: 300 },
      Fire:        { type: 'short', value: -20 },
      Health:      { type: 'float', value: 20 },
      foodLevel:   { type: 'int', value: 20 },
      foodSaturationLevel: { type: 'float', value: 5 },
      XpLevel:     { type: 'int', value: 0 },
      XpP:         { type: 'float', value: 0 },
      XpTotal:     { type: 'int', value: 0 },
      Score:       { type: 'int', value: 0 },
      playerGameType: { type: 'int', value: 1 }, // creative; allowCommands=1 anyway
      Inventory:   { type: 'list', value: { type: 'compound', value: [] } },
      EnderItems:  { type: 'list', value: { type: 'compound', value: [] } },
      abilities: {
        type: 'compound',
        value: {
          flying:        { type: 'byte', value: 1 },
          mayfly:        { type: 'byte', value: 1 },
          invulnerable:  { type: 'byte', value: 1 },
          mayBuild:      { type: 'byte', value: 1 },
          instabuild:    { type: 'byte', value: 1 },
          walkSpeed:     { type: 'float', value: 0.1 },
          flySpeed:      { type: 'float', value: 0.05 },
        },
      },
    }
  }

  /** Compose the WorldGenSettings.dimensions compound. Vanilla three dims
   *  use a noise-generator preset (so MC accepts the codec); custom dims
   *  each get a void-flat generator pointing at the custom dim_type the
   *  chunkscribe datapack ships (e.g. gridlock:end_dtype with end effects). */
  private buildAllDimensions(): any {
    const out: any = {
      'minecraft:overworld':  vanillaDimension('minecraft:overworld'),
      'minecraft:the_nether': vanillaDimension('minecraft:the_nether'),
      'minecraft:the_end':    vanillaDimension('minecraft:the_end'),
    }
    for (const [dimName] of this.getDimMapping()) {
      if (dimName in out) continue
      const plan = this.planFor(dimName)
      out[dimName] = voidDimensionForType(plan.dimTypeRef)
    }
    return out
  }
}

function voidDimensionForType(dimType: string): any {
  return {
    type: 'compound',
    value: {
      type: { type: 'string', value: dimType },
      generator: {
        type: 'compound',
        value: {
          type: { type: 'string', value: 'minecraft:flat' },
          settings: {
            type: 'compound',
            value: {
              biome:    { type: 'string', value: 'minecraft:the_void' },
              features: { type: 'byte', value: 0 },
              lakes:    { type: 'byte', value: 0 },
              layers:   { type: 'list', value: { type: 'end', value: [] } },
              structure_overrides: { type: 'list', value: { type: 'end', value: [] } },
            },
          },
        },
      },
    },
  }
}

function entityToNbt(e: any): any | null {
  const id: string | null = e.typeName ?? null
  if (!id) return null   // unresolved numeric type — skip rather than corrupt the save

  const m = e.meta ?? {}
  const v: any = {
    id:        { type: 'string', value: id },
    Pos:       { type: 'list',  value: { type: 'double', value: [e.x, e.y, e.z] } },
    Motion:    { type: 'list',  value: { type: 'double', value: [e.vx, e.vy, e.vz] } },
    Rotation:  { type: 'list',  value: { type: 'float',  value: [e.yaw, e.pitch] } },
    OnGround:  { type: 'byte',  value: 0 },
    Air:       { type: 'short', value: clampShort(m.Air ?? 300) },
    Fire:      { type: 'short', value: m.OnFire ? 200 : -20 },
    Invulnerable: { type: 'byte', value: 0 },
    Glowing:   { type: 'byte',  value: m.Glowing   ? 1 : 0 },
    Invisible: { type: 'byte',  value: m.Invisible ? 1 : 0 },
    Silent:    { type: 'byte',  value: m.Silent    ? 1 : 0 },
    NoGravity: { type: 'byte',  value: m.NoGravity ? 1 : 0 },
  }
  if (Array.isArray(e.uuid) && e.uuid.length === 4) {
    v.UUID = { type: 'intArray', value: e.uuid }
  }
  if (typeof m.CustomName === 'string') {
    v.CustomName = { type: 'string', value: m.CustomName }
    if (m.CustomNameVisible) v.CustomNameVisible = { type: 'byte', value: 1 }
  }
  if (typeof m.Health === 'number') {
    v.Health = { type: 'float', value: m.Health }
  }
  if (typeof m.IsBaby === 'boolean') {
    v.IsBaby = { type: 'byte', value: m.IsBaby ? 1 : 0 }
  }
  if (typeof m.TicksFrozen === 'number' && m.TicksFrozen > 0) {
    v.TicksFrozen = { type: 'int', value: m.TicksFrozen }
  }
  // Size field for Slime / MagmaCube / Phantom. Without it, MC defaults
  // to Size=0 and renders the entity scaled to nothing — visible only as
  // a wireframe hitbox in F3+B mode. Metadata gives us the network-side
  // size (1 small, 2 medium, 4 big for slime/magma); disk NBT stores
  // (size - 1), reconstructed via `setSize(getInt(Size) + 1)`.
  if (typeof m.SizeInt === 'number' && /^(minecraft:)?(slime|magma_cube|phantom)$/.test(id)) {
    const diskSize = Math.max(0, m.SizeInt - 1)
    v.Size = { type: 'int', value: diskSize }
  }
  if (typeof m.Pose === 'string' && m.Pose !== 'STANDING') {
    v.Pose = { type: 'compound', value: {} } // vanilla rebuilds on tick; leaving as empty marker
  }
  return { type: 'compound', name: '', value: v }
}

function clampShort(n: number): number {
  if (n > 32767) return 32767
  if (n < -32768) return -32768
  return n | 0
}

function bigintToLongPair(v: bigint): [number, number] {
  const hi = Number((v >> 32n) & 0xffffffffn) | 0
  const lo = Number(v & 0xffffffffn) | 0
  return [hi, lo]
}
function absBig(v: bigint): bigint { return v < 0n ? -v : v }

/** Vanilla worldgen preset for one of the 3 standard dimensions. Used as
 *  the default WorldGenSettings.dimensions entries so MC's strict codec
 *  finds an "Overworld settings" entry on level.dat load. */
function vanillaDimension(typeId: string): any {
  let generator: any
  if (typeId === 'minecraft:the_end') {
    generator = {
      type: 'compound',
      value: {
        type: { type: 'string', value: 'minecraft:noise' },
        biome_source: {
          type: 'compound',
          value: { type: { type: 'string', value: 'minecraft:the_end' } },
        },
        settings: { type: 'string', value: 'minecraft:end' },
      },
    }
  } else {
    // overworld + nether both use multi_noise with a preset
    const preset = typeId === 'minecraft:the_nether' ? 'minecraft:nether' : 'minecraft:overworld'
    const settings = typeId === 'minecraft:the_nether' ? 'minecraft:nether' : 'minecraft:overworld'
    generator = {
      type: 'compound',
      value: {
        type: { type: 'string', value: 'minecraft:noise' },
        biome_source: {
          type: 'compound',
          value: {
            type:   { type: 'string', value: 'minecraft:multi_noise' },
            preset: { type: 'string', value: preset },
          },
        },
        settings: { type: 'string', value: settings },
      },
    }
  }
  return {
    type: 'compound',
    value: {
      type: { type: 'string', value: typeId },
      generator,
    },
  }
}
