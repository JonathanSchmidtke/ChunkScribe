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

  private dimSubpath(dim: string): string {
    if (dim === 'minecraft:overworld')   return ''
    if (dim === 'minecraft:the_nether')  return 'DIM-1'
    if (dim === 'minecraft:the_end')     return 'DIM1'
    const [ns, name] = dim.split(':')
    return path.join('dimensions', ns, name)
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
        const Cls = AnvilFactory(this.version)
        // prismarine-provider-anvil's Anvil class doesn't auto-append /region —
        // it writes .mca files into whatever path it's handed. Pass the region
        // dir directly so files land in the canonical Mojang layout
        // (<dim>/region/r.X.Z.mca) and listScans / vanilla MC find them.
        provider = new Cls(regionDir)
      } catch (e) {
        log.err(`anvil provider init failed for ${this.version}: ${(e as Error).message}`)
        continue
      }

      let n = 0
      for (const [key, column] of store.entries()) {
        const [x, z] = key.split(',').map(Number)
        try { await provider.save(x, z, column); n++ }
        catch (e) { log.dbg(`save ${dim} ${x},${z} failed: ${(e as Error).message}`) }
      }
      log.info(`flushed ${n}/${store.size()} columns of ${dim} -> ${dir}`)
      totalSaved += n
    }

    if (totalSaved > 0) await this.writeLevelDat()
    emit({ type: 'flush', total: totalSaved, ok: totalSaved })
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
            if (typeof chunk.addEntity === 'function') chunk.addEntity(nbtEntity)
            else if (Array.isArray(chunk.entities))    chunk.entities.push(nbtEntity)
            else {
              (chunk as any).__entities ??= []
              ;(chunk as any).__entities.push(nbtEntity)
            }
            written++
          } catch { dropped++ }
        }
      }
    }
    if (written + dropped > 0) log.info(`entities patched into chunks: ${written} written, ${dropped} dropped (unresolved type)`)
  }

  private async writeLevelDat() {
    if (!nbt) return
    const ws = this.worldState
    const dataVersion = parseInt(process.env.MCWD_DATAVERSION || '3953', 10)
    const now = BigInt(Date.now())

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
            SpawnX: { type: 'int', value: ws?.spawnX ?? 0 },
            SpawnY: { type: 'int', value: ws?.spawnY ?? 64 },
            SpawnZ: { type: 'int', value: ws?.spawnZ ?? 0 },
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
            // Write a full vanilla 3-dim worldgen preset so MC accepts the
            // level.dat on load. Omitting WorldGenSettings triggers
            // "Overworld settings missing" — MC's codec is strict. The
            // void-mode Transform overrides this with a void-flat preset
            // when the user wants unscanned chunks to stay empty.
            WorldGenSettings: {
              type: 'compound',
              value: {
                seed:              { type: 'long', value: bigintToLongPair(this.phase.hashedSeed) },
                generate_features: { type: 'byte', value: 1 },
                bonus_chest:       { type: 'byte', value: 0 },
                dimensions: {
                  type: 'compound',
                  value: {
                    'minecraft:overworld':  vanillaDimension('minecraft:overworld'),
                    'minecraft:the_nether': vanillaDimension('minecraft:the_nether'),
                    'minecraft:the_end':    vanillaDimension('minecraft:the_end'),
                  },
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
