import { log } from '../util/log'
import { emit } from '../gui/bus'
import type { WorldStore } from '../world/store'

interface OpenWindow {
  windowId: number
  windowType?: string
  pos?: { x: number; y: number; z: number }
  items: any[]
}

/**
 * Captures container contents the player opens (chest, barrel, shulker,
 * brewing stand, furnace, hopper, double-chest...). Workflow:
 *
 *   1. Player right-clicks a block  -> client sends use_item_on
 *      We remember the position (noteInteraction).
 *   2. Server sends open_screen with a fresh windowId.
 *      We pair (windowId -> position).
 *   3. Server sends window_items / set_slot for that windowId.
 *      We accumulate the slots.
 *   4. Server or client closes the window.
 *      We write the slots into the block-entity NBT at that position.
 *
 * Caveats:
 *  - Server-side virtual menus (GUIs that don't back to a block) won't
 *    have a paired position; we just drop them.
 *  - Items NBT is the network shape, not the disk shape. Modern
 *    Minecraft tolerates the network components form in chunks.
 */
export class ContainerCapture {
  private lastInteraction: { x: number; y: number; z: number; ts: number } | null = null
  private open = new Map<number, OpenWindow>()
  totalCaptured = 0

  constructor(private getStore: () => WorldStore) {}

  noteInteraction(x: number, y: number, z: number) {
    this.lastInteraction = { x, y, z, ts: Date.now() }
  }

  onOpen(p: any) {
    const windowId = p.windowId ?? p.containerId
    if (typeof windowId !== 'number') return
    const recent = this.lastInteraction && (Date.now() - this.lastInteraction.ts) < 3000
      ? this.lastInteraction
      : null
    this.open.set(windowId, {
      windowId,
      windowType: typeof p.inventoryType === 'string' ? p.inventoryType :
                   typeof p.windowType === 'string'    ? p.windowType :
                   typeof p.windowType === 'number'    ? String(p.windowType) : undefined,
      pos: recent ? { x: recent.x, y: recent.y, z: recent.z } : undefined,
      items: [],
    })
    if (recent) log.dbg(`container open id=${windowId} @ ${recent.x},${recent.y},${recent.z}`)
  }

  onItems(p: any) {
    const windowId = p.windowId ?? p.containerId
    const w = this.open.get(windowId)
    if (!w) return
    const items = p.items ?? p.contents ?? []
    if (Array.isArray(items)) w.items = items.slice()
  }

  onSlot(p: any) {
    const windowId = p.windowId ?? p.containerId
    if (windowId === -1) return // cursor
    const w = this.open.get(windowId)
    if (!w) return
    const slot = p.slot
    if (typeof slot !== 'number') return
    while (w.items.length <= slot) w.items.push(emptyItem())
    w.items[slot] = p.item ?? p.itemStack ?? emptyItem()
  }

  onClose(p: any) {
    const windowId = p.windowId ?? p.containerId
    const w = this.open.get(windowId)
    if (!w) return
    this.open.delete(windowId)
    this.flushWindow(w)
  }

  /** Force-commit any still-open windows (called from saver on flush). */
  flushAll() {
    for (const w of this.open.values()) this.flushWindow(w)
    this.open.clear()
  }

  private flushWindow(w: OpenWindow) {
    if (!w.pos) { log.dbg(`container ${w.windowId} closed with no position — dropping`); return }
    if (w.items.length === 0) return

    const chunk = this.getStore().getColumn(Math.floor(w.pos.x / 16), Math.floor(w.pos.z / 16))
    if (!chunk) { log.dbg(`container @ ${w.pos.x},${w.pos.y},${w.pos.z} has no captured chunk — dropping`); return }

    const localX = ((w.pos.x % 16) + 16) % 16
    const localZ = ((w.pos.z % 16) + 16) % 16

    const nbtItems = w.items
      .map((it, i) => itemToNbt(it, i))
      .filter(Boolean)

    // Patch the chunk's block entity NBT for this position
    const beNbt = {
      type: 'compound',
      name: '',
      value: {
        Items: { type: 'list', value: { type: 'compound', value: nbtItems } },
        // id/x/y/z are filled in by Minecraft when it loads; chunk format
        // stores BE in a section-indexed list.
      },
    }
    try {
      chunk.setBlockEntity?.({ x: localX, y: w.pos.y, z: localZ }, beNbt)
      this.totalCaptured++
      log.info(`captured container @ ${w.pos.x},${w.pos.y},${w.pos.z} (${nbtItems.length} items)`)
      emit({ type: 'log', level: 'info', msg: `container saved (${nbtItems.length} items)`, ts: Date.now() })
    } catch (e) {
      log.dbg('container write failed:', (e as Error).message)
    }
  }
}

function emptyItem() { return { present: false } }

/** Convert a network-form item slot into a chunk-form NBT compound entry. */
function itemToNbt(it: any, slotIdx: number): any | null {
  if (!it || it.present === false || it.itemCount === 0) return null
  const idAny = it.itemId ?? it.id
  const id =
    typeof idAny === 'number' ? `numeric:${idAny}` :  // numeric IDs need a registry lookup; placeholder
    typeof idAny === 'string' ? idAny :
    null
  if (!id) return null
  const out: any = {
    Slot:  { type: 'byte',   value: slotIdx },
    id:    { type: 'string', value: id },
    Count: { type: 'byte',   value: it.itemCount ?? it.count ?? 1 },
  }
  if (it.nbtData) out.tag = it.nbtData
  if (it.components) out.components = it.components
  return out
}
