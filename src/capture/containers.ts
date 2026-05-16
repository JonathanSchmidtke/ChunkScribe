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

    // Block entity NBT MUST have id + x + y + z fields. Without them, MC's
    // chunk loader logs "invalid type: null" and refuses the entire chunk →
    // black hole on the map. Map the open-screen window type to the most
    // likely block id; coords are in WORLD space (not chunk-local).
    const blockId = windowTypeToBlockId(w.windowType)
    const beNbt = {
      type: 'compound',
      name: '',
      value: {
        id: { type: 'string', value: blockId },
        x:  { type: 'int', value: w.pos.x },
        y:  { type: 'int', value: w.pos.y },
        z:  { type: 'int', value: w.pos.z },
        Items: { type: 'list', value: { type: 'compound', value: nbtItems } },
      },
    }
    try {
      chunk.setBlockEntity?.({ x: localX, y: w.pos.y, z: localZ }, beNbt)
      this.totalCaptured++
      log.info(`captured container ${blockId} @ ${w.pos.x},${w.pos.y},${w.pos.z} (${nbtItems.length} items)`)
      emit({ type: 'log', level: 'info', msg: `container saved (${nbtItems.length} items)`, ts: Date.now() })
    } catch (e) {
      log.dbg('container write failed:', (e as Error).message)
    }
  }
}

/**
 * Map the open_screen `windowType` to a Minecraft block id used in chunk
 * block-entity NBT. The window type tells us the GUI shape (e.g. 9x3 slots)
 * but the actual block could be chest/barrel/double-chest etc. We pick the
 * most common single-block id per shape — wrong-guess is harmless (MC will
 * still parse the chunk; the inventory just won't show if the block doesn't
 * match), but a MISSING id breaks the entire chunk.
 */
function windowTypeToBlockId(wt: string | undefined): string {
  if (!wt) return 'minecraft:chest'
  const t = wt.toLowerCase()
  if (t.includes('shulker'))        return 'minecraft:shulker_box'
  if (t.includes('hopper'))         return 'minecraft:hopper'
  if (t.includes('blast_furnace'))  return 'minecraft:blast_furnace'
  if (t.includes('smoker'))         return 'minecraft:smoker'
  if (t.includes('furnace'))        return 'minecraft:furnace'
  if (t.includes('brewing'))        return 'minecraft:brewing_stand'
  if (t.includes('beacon'))         return 'minecraft:beacon'
  if (t.includes('dispenser'))      return 'minecraft:dispenser'
  if (t.includes('dropper'))        return 'minecraft:dropper'
  // generic_9x{1,2,3,4,5,6} — chest is the most common backing block
  return 'minecraft:chest'
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
