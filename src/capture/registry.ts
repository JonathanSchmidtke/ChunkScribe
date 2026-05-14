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
  biomes: Record<string, any> = {}

  onRegistry(p: any) {
    if (!p?.id) return
    this.registries[p.id] = p
    log.dbg('registry', p.id, '+', (p.entries?.length ?? 0))

    if (p.id === 'minecraft:dimension_type' && Array.isArray(p.entries)) {
      for (const e of p.entries) this.dimensionTypes[e.key ?? e.id] = e.value ?? e
    }
    if (p.id === 'minecraft:worldgen/biome' && Array.isArray(p.entries)) {
      for (const e of p.entries) this.biomes[e.key ?? e.id] = e.value ?? e
    }
  }

  onFeatureFlags(p: any) {
    this.featureFlags = p?.features ?? []
    log.dbg('feature flags:', this.featureFlags.join(','))
  }

  /** Look up worldHeight / minY for the active dimension type, if known. */
  dimensionGeometry(typeId: string): { worldHeight: number; minY: number } | null {
    const dt = this.dimensionTypes[typeId]
    if (!dt) return null
    const height = dt.height ?? dt.element?.height
    const minY   = dt.min_y  ?? dt.element?.min_y
    if (typeof height === 'number' && typeof minY === 'number') return { worldHeight: height, minY }
    return null
  }
}
