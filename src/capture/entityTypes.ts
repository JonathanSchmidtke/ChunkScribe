import { log } from '../util/log'

/**
 * Maps protocol entity type numeric IDs to "minecraft:zombie"-style names.
 *
 * Source of truth: prismarine-registry, which is backed by minecraft-data.
 * The mapping is version-specific (network IDs reshuffle whenever Mojang
 * adds/removes an entity). We resolve lazily so a missing data version
 * surfaces as a clear warning instead of breaking startup.
 */
export class EntityTypeResolver {
  private byId = new Map<number, string>()
  private warnedMisses = new Set<number>()

  constructor(version: string) {
    let RegistryFactory: any
    try { RegistryFactory = require('prismarine-registry') } catch (e) {
      log.warn('prismarine-registry not available — entity types will stay numeric'); return
    }
    let registry: any
    try { registry = RegistryFactory(version) } catch (e) {
      log.warn(`prismarine-registry init failed for ${version}: ${(e as Error).message}`); return
    }

    // prismarine-registry surfaces entity data in a few shapes across versions.
    // Try each shape; whichever populates first wins.
    this.ingest(registry.entitiesArray, (e: any) => e?.id, (e: any) => e?.name)
    this.ingest(registry.entitiesByName, (_e: any, _k: string) => undefined, (e: any) => e?.name, /*useEntityIdField*/ true)
    if (this.byId.size === 0 && registry.entities) {
      // Object indexed by id
      for (const key of Object.keys(registry.entities)) {
        const numKey = Number(key)
        if (!Number.isNaN(numKey)) {
          const e = registry.entities[key]
          if (e?.name) this.byId.set(numKey, qualify(e.name))
        }
      }
    }

    log.info(`entity type resolver loaded: ${this.byId.size} entries for ${version}`)
  }

  /**
   * @param useEntityIdField when iterating *byName, the numeric id lives on the entry itself
   *                         (e.entityId / e.internalId / e.id) — use that as the key.
   */
  private ingest(
    src: any,
    getId: (e: any, k?: string) => number | undefined,
    getName: (e: any) => string | undefined,
    useEntityIdField = false,
  ) {
    if (!src) return
    if (Array.isArray(src)) {
      for (const e of src) {
        const id = getId(e); const name = getName(e)
        if (typeof id === 'number' && name) this.byId.set(id, qualify(name))
      }
    } else {
      for (const k of Object.keys(src)) {
        const e = src[k]
        const id = useEntityIdField ? (e?.id ?? e?.internalId ?? e?.entityId) : getId(e, k)
        const name = getName(e)
        if (typeof id === 'number' && name) this.byId.set(id, qualify(name))
      }
    }
  }

  resolve(numericType: number | undefined): string | null {
    if (typeof numericType !== 'number') return null
    const hit = this.byId.get(numericType)
    if (hit) return hit
    if (!this.warnedMisses.has(numericType)) {
      this.warnedMisses.add(numericType)
      log.dbg(`unresolved entity type id=${numericType}`)
    }
    return null
  }
}

function qualify(name: string): string {
  return name.includes(':') ? name : `minecraft:${name}`
}
