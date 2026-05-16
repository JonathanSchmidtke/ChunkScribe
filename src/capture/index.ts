import { log } from '../util/log'
import { emit } from '../gui/bus'
import type { PhaseTracker } from '../phase'
import { RegistryCapture } from './registry'
import { ChunkCapture } from './chunks'
import { BlockUpdateCapture } from './blockUpdates'
import { BlockEntityCapture } from './blockEntities'
import { WorldStateCapture } from './worldState'
import { ContainerCapture } from './containers'
import { EntityCapture } from './entities'
import { EntityTypeResolver } from './entityTypes'
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
  readonly worldState = new WorldStateCapture()
  readonly containers: ContainerCapture
  readonly mobs: EntityCapture
  private readonly chunks: ChunkCapture
  private readonly blocks: BlockUpdateCapture
  private readonly blockEntities: BlockEntityCapture

  constructor(private phase: PhaseTracker, private saver: WorldSaver, version: string) {
    this.chunks        = new ChunkCapture(phase, () => this.activeStore(), version)
    this.blocks        = new BlockUpdateCapture(() => this.activeStore())
    this.blockEntities = new BlockEntityCapture(() => this.activeStore())
    this.containers    = new ContainerCapture(() => this.activeStore())
    const typeResolver = new EntityTypeResolver(version)
    this.mobs          = new EntityCapture(() => this.activeStore(), () => this.phase.dimensionName, typeResolver)
    saver.attachRegistry(this.registry)
    saver.attachWorldState(this.worldState)
    saver.attachEntities(this.mobs)
    saver.attachContainers(this.containers)
  }

  private activeStore(): WorldStore {
    let s = this.stores.get(this.phase.dimensionName)
    if (!s) {
      s = new WorldStore(this.phase.dimensionName)
      this.stores.set(this.phase.dimensionName, s)
      log.info(`new dimension store: ${this.phase.dimensionName}`)
    }
    emit({ type: 'dim', dim: this.phase.dimensionName })
    return s
  }

  /** Aggregate chunk counts by dimension for status events. */
  chunksByDim(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [dim, store] of this.stores) out[dim] = store.size()
    return out
  }

  /** Force-commit any chunks still pending a batch_finished ack — called
   *  on Stop so we don't lose the last partial batch. */
  drainPendingChunks() { this.chunks.drainPending() }

  /** Coord lists for replay to a fresh GUI client (so the chunk map can
   *  rebuild itself after a page reload). */
  chunkCoordsByDim(): Record<string, [number, number][]> {
    const out: Record<string, [number, number][]> = {}
    for (const [dim, store] of this.stores) {
      const list: [number, number][] = []
      for (const key of store.keys()) {
        const [x, z] = key.split(',').map(Number)
        list.push([x, z])
      }
      out[dim] = list
    }
    return out
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

      case 'chunk_batch_finished':
        return this.chunks.onBatchFinished()

      case 'block_change':
      case 'block_update':
        return this.blocks.onSingle(data)

      case 'multi_block_change':
      case 'section_blocks_update':
      case 'update_section_blocks':
        return this.blocks.onSection(data)

      case 'tile_entity_data':
      case 'block_entity_data':
        return this.blockEntities.onUpdate(data)

      // ---- world state ----
      case 'spawn_position':         return this.worldState.onSpawnPosition(data)
      case 'time_update':
      case 'update_time':            return this.worldState.onTime(data)
      case 'game_state_change':      return this.worldState.onGameStateChange(data)
      case 'server_difficulty':      return this.worldState.onDifficulty(data)
      case 'initialize_world_border':return this.worldState.onBorderInit(data)
      case 'world_border_size':      return this.worldState.onBorderSize(data)
      case 'world_border_center':    return this.worldState.onBorderCenter(data)

      // ---- container inventories ----
      case 'open_window':
      case 'open_screen':            return this.containers.onOpen(data)
      case 'window_items':
      case 'set_container_content':  return this.containers.onItems(data)
      case 'set_slot':
      case 'set_container_slot':     return this.containers.onSlot(data)
      case 'close_window':
      case 'close_container':        return this.containers.onClose(data)

      // ---- entities ----
      case 'spawn_entity':
      case 'spawn_entity_living':
      case 'spawn_living_entity':
      case 'spawn_entity_painting':
      case 'spawn_painting':
      case 'spawn_entity_experience_orb':
      case 'spawn_xp_orb':           return this.mobs.onSpawn(data, name)
      case 'entity_metadata':        return this.mobs.onMetadata(data)
      case 'entity_equipment':       return this.mobs.onEquipment(data)
      case 'entity_velocity':        return this.mobs.onVelocity(data)
      case 'entity_teleport':
      case 'entity_position':
      case 'entity_position_and_rotation':
      case 'entity_move_look':       return this.mobs.onPosition(data)
      case 'entity_look':
      case 'entity_head_rotation':   return this.mobs.onRotation(data)
      case 'destroy_entity':
      case 'destroy_entities':
      case 'remove_entities':        return this.mobs.onDestroy(data)
    }
  }

  /** Hook for the proxy to register the player's right-clicks (used_item_on)
   *  so we can pair an open_screen with the block position. */
  observeClientPacket(meta: any, data: any) {
    const name: string = meta.name
    if (meta.state !== 'play') return
    if (name === 'use_item_on' || name === 'block_place' || name === 'player_block_placement') {
      const loc = data?.location ?? data?.pos ?? data
      if (typeof loc?.x === 'number') this.containers.noteInteraction(loc.x, loc.y, loc.z)
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
