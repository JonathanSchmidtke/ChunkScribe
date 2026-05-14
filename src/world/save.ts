import path from 'node:path'
import fs from 'node:fs/promises'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import { log } from '../util/log'
import type { WorldStore } from './store'
import type { PhaseTracker } from '../phase'
import type { RegistryCapture } from '../capture/registry'

const gzip = promisify(zlib.gzip)

let AnvilFactory: any
let nbt: any
try { AnvilFactory = require('prismarine-provider-anvil').Anvil } catch (e) { log.warn('prismarine-provider-anvil missing:', (e as Error).message) }
try { nbt = require('prismarine-nbt') }                              catch (e) { log.warn('prismarine-nbt missing:', (e as Error).message) }

export class WorldSaver {
  private registry: RegistryCapture | null = null
  private inFlight: Promise<void> | null = null

  constructor(
    private root: string,
    private version: string,
    private phase: PhaseTracker,
  ) {}

  attachRegistry(r: RegistryCapture) { this.registry = r }

  private dimSubpath(dim: string): string {
    if (dim === 'minecraft:overworld')   return ''
    if (dim === 'minecraft:the_nether')  return 'DIM-1'
    if (dim === 'minecraft:the_end')     return 'DIM1'
    // datapack / custom dimensions
    const [ns, name] = dim.replace(/^minecraft:/, 'minecraft:').split(':')
    return path.join('dimensions', ns, name)
  }

  /**
   * Flush all captured columns to Anvil region files. Serialised so a
   * periodic timer firing while a previous flush is still running won't
   * double-write the same regions.
   */
  async flush(stores: Map<string, WorldStore>): Promise<void> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.doFlush(stores).finally(() => { this.inFlight = null })
    return this.inFlight
  }

  private async doFlush(stores: Map<string, WorldStore>) {
    if (!AnvilFactory) { log.err('cannot save: prismarine-provider-anvil not installed'); return }
    await fs.mkdir(this.root, { recursive: true })

    let totalSaved = 0
    for (const [dim, store] of stores) {
      if (store.size() === 0) continue
      const dir = path.join(this.root, this.dimSubpath(dim))
      await fs.mkdir(path.join(dir, 'region'), { recursive: true })

      let provider: any
      try {
        const Cls = AnvilFactory(this.version)
        provider = new Cls(dir)
      } catch (e) {
        log.err(`anvil provider init failed for ${this.version}: ${(e as Error).message}`)
        continue
      }

      let n = 0
      for (const [key, column] of store.entries()) {
        const [x, z] = key.split(',').map(Number)
        try {
          await provider.save(x, z, column)
          n++
        } catch (e) {
          log.dbg(`save ${dim} ${x},${z} failed: ${(e as Error).message}`)
        }
      }
      log.info(`flushed ${n}/${store.size()} columns of ${dim} -> ${dir}`)
      totalSaved += n
    }

    if (totalSaved > 0) await this.writeLevelDat()
  }

  /**
   * Minimal level.dat. Modern Minecraft is picky — if anything is off
   * it will refuse to load the save. We write the bare minimum and
   * rely on the launcher / vanilla to recover defaults for the rest.
   *
   * The DataVersion below targets 1.21.x; the launcher will warn but
   * still open it. Override via MCWD_DATAVERSION env if you need exact.
   */
  private async writeLevelDat() {
    if (!nbt) return
    const dataVersion = parseInt(process.env.MCWD_DATAVERSION || '3953', 10) // 1.21.x ballpark
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
            GameType: { type: 'int', value: 3 }, // spectator — safe default
            Difficulty: { type: 'byte', value: 2 },
            allowCommands: { type: 'byte', value: 1 },
            hardcore: { type: 'byte', value: 0 },
            initialized: { type: 'byte', value: 1 },
            SpawnX: { type: 'int', value: 0 },
            SpawnY: { type: 'int', value: 64 },
            SpawnZ: { type: 'int', value: 0 },
            Time:    { type: 'long', value: bigintToLongPair(0n) },
            DayTime: { type: 'long', value: bigintToLongPair(0n) },
            LastPlayed: { type: 'long', value: bigintToLongPair(now) },
            RandomSeed: { type: 'long', value: bigintToLongPair(this.phase.hashedSeed) },
            GameRules: { type: 'compound', value: {} },
            WorldGenSettings: {
              type: 'compound',
              value: {
                seed: { type: 'long', value: bigintToLongPair(this.phase.hashedSeed) },
                generate_features: { type: 'byte', value: 0 },
                dimensions: { type: 'compound', value: {} },
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
    log.info(`wrote level.dat (DataVersion=${dataVersion})`)
  }
}

/** prismarine-nbt encodes long as [highInt32, lowInt32] tuple. */
function bigintToLongPair(v: bigint): [number, number] {
  const hi = Number((v >> 32n) & 0xffffffffn) | 0
  const lo = Number(v & 0xffffffffn) | 0
  return [hi, lo]
}
