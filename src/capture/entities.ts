import { log } from '../util/log'
import type { WorldStore } from '../world/store'

interface CapturedEntity {
  networkId: number
  type: number | string         // numeric type from spawn_entity, or 'painting'
  uuid?: number[]               // 4 int32s
  x: number; y: number; z: number
  vx: number; vy: number; vz: number
  yaw: number; pitch: number; headYaw: number
  metadata?: any
  equipment?: any
  dim: string
}

/**
 * Tracks living entities (mobs, item frames, paintings, item drops,
 * armor stands, XP orbs) sent by the server. We treat each entity ID
 * as a record we update with spawn/metadata/position/equipment packets,
 * delete on destroy.
 *
 * Caveats (v1):
 *  - Entity type is a network numeric ID. Mapping to "minecraft:zombie"
 *    needs the entity_type registry that prismarine-registry ships with
 *    minecraft-data; we leave the numeric ID in place and let the saver
 *    resolve when writing NBT.
 *  - We don't decode entity-type-specific metadata (Age, IsBaby, custom
 *    name, ...). Metadata is stashed as a raw blob.
 *  - Items frames and paintings have a fixed orientation field we don't
 *    yet decode.
 */
export class EntityCapture {
  private entities = new Map<number, CapturedEntity>()
  totalEverSeen = 0

  constructor(
    private getStore: () => WorldStore,
    private getDim: () => string,
  ) {}

  onSpawn(p: any, packetName: string) {
    const id = p.entityId
    if (typeof id !== 'number') return
    const isPainting = packetName.includes('painting')
    const isOrb      = packetName.includes('xp') || packetName.includes('experience_orb')

    const e: CapturedEntity = {
      networkId: id,
      type: isPainting ? 'minecraft:painting'
          : isOrb      ? 'minecraft:experience_orb'
          : (p.type ?? p.entityType ?? -1),
      uuid: Array.isArray(p.objectUUID) ? p.objectUUID : Array.isArray(p.entityUUID) ? p.entityUUID : undefined,
      x: p.x ?? 0, y: p.y ?? 0, z: p.z ?? 0,
      vx: (p.velocityX ?? 0) / 8000,
      vy: (p.velocityY ?? 0) / 8000,
      vz: (p.velocityZ ?? 0) / 8000,
      yaw:    decodeAngle(p.yaw),
      pitch:  decodeAngle(p.pitch),
      headYaw: decodeAngle(p.headPitch ?? p.headYaw ?? p.yaw),
      dim: this.getDim(),
    }
    this.entities.set(id, e)
    this.totalEverSeen++
  }

  onMetadata(p: any) {
    const e = this.entities.get(p.entityId); if (!e) return
    e.metadata = p.metadata
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
    // entity_position is a delta in some versions, absolute in others.
    if (typeof p.x === 'number' && Math.abs(p.x) > 4) {
      e.x = p.x; e.y = p.y; e.z = p.z
    } else {
      // delta in 1/4096 of a block (or in 1/128 on legacy)
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
}

function decodeAngle(a: number | undefined): number {
  if (typeof a !== 'number') return 0
  // 1 byte angle: 0..255 maps to 0..360 deg
  return (a / 256) * 360
}
