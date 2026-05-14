import { log } from '../util/log'
import type { PhaseTracker } from '../phase'
import { RegistryCapture } from './registry'
import { ChunkCapture } from './chunks'
import { BlockUpdateCapture } from './blockUpdates'
import { BlockEntityCapture } from './blockEntities'
import { WorldStore } from '../world/store'
import type { WorldSaver } from '../world/save'

/**
 * Per-session capture dispatcher. Owns one WorldStore per dimension
 * the player has visited, plus the parsed registry data we need at
 * save time.
 */
export class Capture {
  readonly stores: Map<string, WorldStore> = new Map()
  readonly registry = new RegistryCapture()
  private readonly chunks: ChunkCapture
  private readonly blocks: BlockUpdateCapture
  private readonly entities: BlockEntityCapture

  constructor(private phase: PhaseTracker, private saver: WorldSaver, version: string) {
    this.chunks   = new ChunkCapture(phase, () => this.activeStore(), version)
    this.blocks   = new BlockUpdateCapture(() => this.activeStore())
    this.entities = new BlockEntityCapture(() => this.activeStore())
    saver.attachRegistry(this.registry)
  }

  private activeStore(): WorldStore {
    let s = this.stores.get(this.phase.dimensionName)
    if (!s) {
      s = new WorldStore(this.phase.dimensionName)
      this.stores.set(this.phase.dimensionName, s)
      log.info(`new dimension store: ${this.phase.dimensionName}`)
    }
    return s
  }

  handle(meta: any, data: any) {
    const name: string = meta.name
    const state: string = meta.state

    if (state === 'configuration') {
      switch (name) {
        case 'registry_data':         return this.registry.onRegistry(data)
        case 'feature_flags':         return this.registry.onFeatureFlags(data)
        case 'select_known_packs':    return // server is asking, client answers — no capture
      }
      return
    }

    if (state !== 'play') return

    switch (name) {
      case 'login':
        this.phase.onPlayLogin(data)
        this.adoptDimensionGeometry()
        return

      case 'respawn':
        this.phase.onRespawn(data)
        this.adoptDimensionGeometry()
        return

      case 'map_chunk':
      case 'level_chunk_with_light':
        return this.chunks.onChunk(data)

      case 'unload_chunk':
        return this.chunks.onUnload(data)

      case 'block_change':
      case 'block_update':
        return this.blocks.onSingle(data)

      case 'multi_block_change':
      case 'section_blocks_update':
      case 'update_section_blocks':
        return this.blocks.onSection(data)

      case 'tile_entity_data':
      case 'block_entity_data':
        return this.entities.onUpdate(data)
    }
  }

  private adoptDimensionGeometry() {
    const geom = this.registry.dimensionGeometry(this.phase.dimensionType)
    if (geom) {
      this.phase.worldHeight = geom.worldHeight
      this.phase.minY = geom.minY
      log.dbg(`dim geometry: height=${geom.worldHeight} minY=${geom.minY}`)
    }
  }
}
