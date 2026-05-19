import { log } from '../util/log'

/**
 * Captures configuration-phase data: registry contents (dimensions,
 * biomes, damage types, etc.) and feature flags. These are needed to
 * (a) know world height/biome list for chunk parsing, and (b) write
 * a valid level.dat that Minecraft will open.
 */
export class RegistryCapture {
  registries: Record<string, any> = {}
  featureFlags: string[] = []
  dimensionTypes: Record<string, any> = {}
  /** Ordered dim_type names as the server registered them. The `dimension`
   *  field on the 1.21+ SpawnInfo packet (login/respawn) is a varint INDEX
   *  into this registry, not a name. Without the ordered list we can't
   *  map gridlock:nether → gridlock:nether_dimtype and every custom dim
   *  falls back to minecraft:overworld dim_type. */
  dimensionTypesOrdered: string[] = []
  biomes: Record<string, any> = {}
  /** Ordered biome names as the server defined them. Index here = the
   *  numeric biome ID used in chunk-packet biome palettes. Critical for
   *  remapping custom biomes (gridlock:custom_jungle etc.) to vanilla
   *  equivalents so the saved world renders the right colors. */
  biomesOrdered: string[] = []

  onRegistry(p: any) {
    if (!p?.id) return
    this.registries[p.id] = p
    log.dbg('registry', p.id, '+', (p.entries?.length ?? 0))

    if (p.id === 'minecraft:dimension_type' && Array.isArray(p.entries)) {
      this.dimensionTypesOrdered = []
      for (const e of p.entries) {
        const name = e.key ?? e.id
        this.dimensionTypes[name] = e.value ?? e
        this.dimensionTypesOrdered.push(name)
      }
      log.info(`captured ${this.dimensionTypesOrdered.length} dim_types from server registry`)
      // Print each dim_type's resolved geometry so we can see at a glance
      // whether the recursive resolver picked everything up correctly.
      for (let i = 0; i < this.dimensionTypesOrdered.length; i++) {
        const name = this.dimensionTypesOrdered[i]
        const dt = this.dimensionTypes[name]
        const h = findNbtInt(dt, 'height')
        const m = findNbtInt(dt, 'min_y')
        log.info(`  [${i}] ${name}  min_y=${m}  height=${h}`)
      }
    }
    if (p.id === 'minecraft:worldgen/biome' && Array.isArray(p.entries)) {
      this.biomesOrdered = []
      for (const e of p.entries) {
        const name = e.key ?? e.id
        this.biomes[name] = e.value ?? e
        this.biomesOrdered.push(name)
      }
      log.info(`captured ${this.biomesOrdered.length} biomes from server registry`)
    }
  }

  onFeatureFlags(p: any) {
    this.featureFlags = p?.features ?? []
    log.dbg('feature flags:', this.featureFlags.join(','))
  }

  /** Resolve the registry-index dim_type that arrives on SpawnInfo to its
   *  full name (e.g. 6 → "gridlock:nether_dimtype"). Returns null if the
   *  index is out of range or the dim_type registry hasn't arrived yet. */
  dimensionTypeByIndex(index: number): string | null {
    if (!Number.isFinite(index)) return null
    return this.dimensionTypesOrdered[index] ?? null
  }

  /** Look up worldHeight / minY for a dim_type. Registry entries come
   *  through prismarine-nbt with variable nesting (`{type:'compound',value:{...}}`
   *  vs already-unwrapped, sometimes inside `element`, sometimes both).
   *  Walk the subtree recursively for `height` / `min_y` instead of
   *  hard-coding paths — that lets us tolerate whatever shape the server
   *  ships without per-server patching. */
  dimensionGeometry(typeId: string): { worldHeight: number; minY: number } | null {
    const dt = this.dimensionTypes[typeId]
    if (!dt) {
      log.warn(`  dim_type "${typeId}" not in registry. Known keys: ${Object.keys(this.dimensionTypes).join(', ')}`)
      return null
    }
    const height = findNbtInt(dt, 'height')
    const minY   = findNbtInt(dt, 'min_y')
    if (typeof height === 'number' && typeof minY === 'number') return { worldHeight: height, minY }
    log.warn(`  dim_type "${typeId}" missing height/min_y. top-keys=${Object.keys(dt).join(',')}  height=${JSON.stringify(height)} min_y=${JSON.stringify(minY)}`)
    return null
  }
}

/** Walk an NBT subtree (compound, tagged compound, or already-unwrapped
 *  plain object) looking for a field with the given key. Returns its
 *  integer value or undefined. We descend through:
 *   - tagged-NBT wrappers (`{type:'compound',value:{...}}`)
 *   - registry-entry wrappers (`{element:{...}}` from 1.20.2+ shape)
 *   - plain compounds
 *  We DO NOT descend into arrays or further sub-compounds beyond those
 *  three patterns — that would risk pulling a nested unrelated `height`
 *  out of a sub-structure (e.g., monster_spawn_light_level providers
 *  sometimes carry a `min`/`max` pair). */
function findNbtInt(node: any, key: string): number | undefined {
  if (!node || typeof node !== 'object') return undefined
  // Direct hit
  if (key in node) {
    const v = node[key]
    if (typeof v === 'number') return v
    if (v && typeof v === 'object' && typeof v.value === 'number') return v.value
  }
  // Descend through `value` (tagged-NBT wrapper) and `element` (registry-entry wrapper).
  if (node.value && typeof node.value === 'object' && !Array.isArray(node.value)) {
    const v = findNbtInt(node.value, key)
    if (typeof v === 'number') return v
  }
  if (node.element && typeof node.element === 'object' && !Array.isArray(node.element)) {
    const v = findNbtInt(node.element, key)
    if (typeof v === 'number') return v
  }
  return undefined
}
