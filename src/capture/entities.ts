import { log } from '../util/log'
import { EntityTypeResolver } from './entityTypes'
import { decodeEntityMetadata, DecodedMetadata } from './entityMetadata'
import type { WorldStore } from '../world/store'

export interface CapturedEntity {
  networkId: number
  /** Resolved `minecraft:name`. Null until the type resolver finds it. */
  typeName: string | null
  /** Raw numeric type from the protocol — kept around in case the resolver lags. */
  numericType: number | null
  uuid?: number[]
  x: number; y: number; z: number
  vx: number; vy: number; vz: number
  yaw: number; pitch: number; headYaw: number
  meta: DecodedMetadata
  equipment?: any
  dim: string
}

/**
 * Tracks living entities (mobs, item frames, paintings, item drops,
 * armor stands, XP orbs) sent by the server. Each entity ID is a record
 * we update with spawn/metadata/position/equipment packets and delete
 * on destroy.
 */
export class EntityCapture {
  private entities = new Map<number, CapturedEntity>()
  totalEverSeen = 0

  constructor(
    private getStore: () => WorldStore,
    private getDim: () => string,
    private types: EntityTypeResolver,
  ) {}

  onSpawn(p: any, packetName: string) {
    const id = p.entityId
    if (typeof id !== 'number') return

    const isPainting = packetName.includes('painting')
    const isOrb      = packetName.includes('xp') || packetName.includes('experience_orb')

    let typeName: string | null = null
    let numericType: number | null = null

    if (isPainting)  typeName = 'minecraft:painting'
    else if (isOrb)  typeName = 'minecraft:experience_orb'
    else {
      numericType = (p.type ?? p.entityType ?? null) as number | null
      typeName = this.types.resolve(numericType ?? undefined)
    }

    const e: CapturedEntity = {
      networkId: id,
      typeName,
      numericType,
      uuid: Array.isArray(p.objectUUID) ? p.objectUUID : Array.isArray(p.entityUUID) ? p.entityUUID : undefined,
      x: p.x ?? 0, y: p.y ?? 0, z: p.z ?? 0,
      vx: (p.velocityX ?? 0) / 8000,
      vy: (p.velocityY ?? 0) / 8000,
      vz: (p.velocityZ ?? 0) / 8000,
      yaw:    decodeAngle(p.yaw),
      pitch:  decodeAngle(p.pitch),
      headYaw: decodeAngle(p.headPitch ?? p.headYaw ?? p.yaw),
      meta: {},
      dim: this.getDim(),
    }
    this.entities.set(id, e)
    this.totalEverSeen++
  }

  onMetadata(p: any) {
    const e = this.entities.get(p.entityId); if (!e) return
    const decoded = decodeEntityMetadata(p.metadata)
    // Merge — keep existing fields for indices we didn't see this time.
    Object.assign(e.meta, decoded)
  }

  onEquipment(p: any) {
    const e = this.entities.get(p.entityId); if (!e) return
    e.equipment = p.equipments ?? p.equipment
  }

  onVelocity(p: any) {
    const e = this.entities.get(p.entityId); if (!e) return
    e.vx = (p.velocityX ?? 0) / 8000
    e.vy = (p.velocityY ?? 0) / 8000
    e.vz = (p.velocityZ ?? 0) / 8000
  }

  onPosition(p: any) {
    const e = this.entities.get(p.entityId); if (!e) return
    // entity_teleport gives absolute coords; entity_position/entity_position_and_rotation
    // give deltas in fixed-point. We pick by magnitude — deltas are sub-block.
    if (typeof p.x === 'number' && Math.abs(p.x) > 4) {
      e.x = p.x; e.y = p.y; e.z = p.z
    } else {
      const scale = 4096
      e.x += (p.dX ?? 0) / scale
      e.y += (p.dY ?? 0) / scale
      e.z += (p.dZ ?? 0) / scale
    }
    if (typeof p.yaw   === 'number') e.yaw   = decodeAngle(p.yaw)
    if (typeof p.pitch === 'number') e.pitch = decodeAngle(p.pitch)
  }

  onRotation(p: any) {
    const e = this.entities.get(p.entityId); if (!e) return
    if (typeof p.headYaw === 'number') e.headYaw = decodeAngle(p.headYaw)
    if (typeof p.yaw     === 'number') e.yaw     = decodeAngle(p.yaw)
    if (typeof p.pitch   === 'number') e.pitch   = decodeAngle(p.pitch)
  }

  onDestroy(p: any) {
    const ids: number[] = Array.isArray(p.entityIds) ? p.entityIds
                       : typeof p.entityId === 'number' ? [p.entityId]
                       : []
    for (const id of ids) this.entities.delete(id)
  }

  /**
   * Late-attempt to resolve types for entities that spawned before the
   * registry was ready. Called from the saver before writing NBT.
   */
  resolvePending() {
    for (const e of this.entities.values()) {
      if (!e.typeName && e.numericType != null) {
        e.typeName = this.types.resolve(e.numericType)
      }
    }
  }

  /** Group entities by (dimension, chunkX, chunkZ) for save time. */
  byChunk(): Map<string, Map<string, CapturedEntity[]>> {
    const out = new Map<string, Map<string, CapturedEntity[]>>()
    for (const e of this.entities.values()) {
      const cx = Math.floor(e.x / 16), cz = Math.floor(e.z / 16)
      let perDim = out.get(e.dim)
      if (!perDim) { perDim = new Map(); out.set(e.dim, perDim) }
      const key = `${cx},${cz}`
      let bucket = perDim.get(key)
      if (!bucket) { bucket = []; perDim.set(key, bucket) }
      bucket.push(e)
    }
    return out
  }

  count(): number { return this.entities.size }
  countResolved(): number {
    let n = 0
    for (const e of this.entities.values()) if (e.typeName) n++
    return n
  }
}

function decodeAngle(a: number | undefined): number {
  if (typeof a !== 'number') return 0
  return (a / 256) * 360
}
