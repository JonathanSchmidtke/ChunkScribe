import { log } from '../util/log'
import type { WorldStore } from '../world/store'

/**
 * Late-arriving block entity data (signs, chests, banners...).
 * Apply onto the chunk that already holds the block.
 */
export class BlockEntityCapture {
  constructor(private getStore: () => WorldStore) {}

  onUpdate(p: any) {
    const loc = p.location ?? { x: p.x, y: p.y, z: p.z }
    const nbt = p.nbtData ?? p.nbt
    if (!loc || !nbt) return

    const cx = Math.floor(loc.x / 16)
    const cz = Math.floor(loc.z / 16)
    const chunk = this.getStore().getColumn(cx, cz)
    if (!chunk) return

    try {
      chunk.setBlockEntity?.({ x: ((loc.x % 16) + 16) % 16, y: loc.y, z: ((loc.z % 16) + 16) % 16 }, nbt)
    } catch (e) {
      log.dbg('block entity apply failed', (e as Error).message)
    }
  }
}
