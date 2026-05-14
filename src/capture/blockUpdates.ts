import { log } from '../util/log'
import type { WorldStore } from '../world/store'

/**
 * Applies single-block and section-bulk updates to already-captured
 * chunks. We don't synthesise chunks from these — they're updates,
 * not full data — but they keep the saved world in sync with what
 * the player actually observed.
 */
export class BlockUpdateCapture {
  constructor(private getStore: () => WorldStore) {}

  onSingle(p: any) {
    // Modern shape: { location: { x, y, z }, type: stateId }
    const loc = p.location ?? p.pos ?? { x: p.x, y: p.y, z: p.z }
    const stateId = p.type ?? p.blockState ?? p.blockId
    if (!loc || typeof stateId !== 'number') return

    const cx = Math.floor(loc.x / 16)
    const cz = Math.floor(loc.z / 16)
    const chunk = this.getStore().getColumn(cx, cz)
    if (!chunk) return
    try {
      chunk.setBlockStateId?.({ x: ((loc.x % 16) + 16) % 16, y: loc.y, z: ((loc.z % 16) + 16) % 16 }, stateId)
    } catch (e) {
      log.dbg('block update apply failed', (e as Error).message)
    }
  }

  onSection(p: any) {
    // 1.16.2+ section update: chunkCoordinates packed long + records[]
    // minecraft-protocol decodes chunkX/chunkY/chunkZ for us; records have packed positions.
    const cx = p.chunkX ?? p.chunkCoordinates?.x
    const cy = p.chunkY ?? p.chunkCoordinates?.y
    const cz = p.chunkZ ?? p.chunkCoordinates?.z
    if (typeof cx !== 'number' || typeof cz !== 'number') return

    const chunk = this.getStore().getColumn(cx, cz)
    if (!chunk) return

    const records: any[] = p.records ?? []
    for (const r of records) {
      // r is typically a packed long: stateId << 12 | (x<<8 | z<<4 | y)
      let stateId: number, lx: number, ly: number, lz: number
      if (typeof r === 'bigint' || (Array.isArray(r) && r.length === 2)) {
        const v = typeof r === 'bigint' ? r : (BigInt(r[0]) << 32n) | BigInt(r[1] >>> 0)
        stateId = Number(v >> 12n)
        const pos = Number(v & 0xfffn)
        lx = (pos >> 8) & 0xf
        lz = (pos >> 4) & 0xf
        ly = pos & 0xf
      } else if (typeof r === 'object' && r !== null) {
        stateId = r.blockId ?? r.state ?? r.type
        lx = r.x; ly = r.y; lz = r.z
      } else continue

      try {
        chunk.setBlockStateId?.({ x: lx, y: (cy ?? 0) * 16 + ly, z: lz }, stateId)
      } catch {}
    }
  }
}
