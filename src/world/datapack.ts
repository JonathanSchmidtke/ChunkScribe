import fs from 'node:fs/promises'
import path from 'node:path'
import { log } from '../util/log'

/**
 * Write a per-world datapack so MC loads our custom dimensions when opening
 * the save. Two outputs:
 *
 *   data/<ns>/dimension/<name>.json          — one per captured custom dim
 *   data/chunkscribe/dimension_type/...json  — synthesised dim_types for
 *                                              dims whose captured geometry
 *                                              doesn't match any vanilla
 *                                              dim_type
 *
 * Strategy:
 *   - If the server's captured geometry for the dim exactly matches a
 *     vanilla dim_type (minY=-64,h=384 / minY=0,h=128 / minY=0,h=256),
 *     point the dim at that vanilla dim_type. All native game behaviours
 *     (bed explosions, lava flow, end gateway, dragon respawn) work for
 *     free, and we don't ship a dim_type JSON for it.
 *   - Otherwise, synthesise a sanitised dim_type with the captured
 *     geometry + flavour-appropriate effects (nether fog if "nether" in
 *     the dim's name, end sky if "end", etc.) + the right native-behaviour
 *     fields (bed_works=false in nether/end, ultrawarm/piglin_safe etc.).
 *
 * Server-captured biomes are NOT round-tripped — Gridlock's contain custom
 * fields (`attributes`, `skybox`) that MC's strict codec rejects. Biome
 * NAMES on chunks render with vanilla colors as a fallback.
 */

interface CapturedRegistryData {
  biomes: Record<string, any>
  dimensionTypes: Record<string, any>
  dimensions?: Record<string, any>
}

const PACK_FORMAT = 48 // MC 1.21.x

export interface DimSavePlan {
  /** The dim name (e.g. "gridlock:nether"). */
  dimName: string
  /** Which dim_type the dim should reference. Either a vanilla ID or one
   *  of our synthesised "chunkscribe:..." ones. */
  dimTypeRef: string
  /** Set when we're shipping a custom dim_type JSON file in the pack. */
  customDimType?: {
    /** Filename namespace + name, e.g. { ns: "chunkscribe", name: "gridlock_nether" }. */
    ns: string
    name: string
    /** The JSON content. */
    json: Record<string, any>
  }
}

const VANILLA_GEOMETRIES = [
  { type: 'minecraft:overworld',  minY: -64, height: 384 },
  { type: 'minecraft:the_nether', minY: 0,   height: 128 },
  { type: 'minecraft:the_end',    minY: 0,   height: 256 },
]

/** Decide which dim_type a captured custom dim should reference on disk.
 *  Vanilla types are preferred (native game behaviour); custom is only
 *  emitted when the captured geometry doesn't match any vanilla type. */
export function planForDim(dimName: string, captured: { minY: number; height: number } | null): DimSavePlan {
  // Try to match a vanilla geometry exactly.
  if (captured) {
    const vanilla = VANILLA_GEOMETRIES.find(v => v.minY === captured.minY && v.height === captured.height)
    if (vanilla) return { dimName, dimTypeRef: vanilla.type }
  }
  // Custom geometry — emit a sanitised dim_type beside the dim JSON.
  const slug = dimName.replace(/:/g, '_').replace(/[^a-z0-9_]/gi, '_').toLowerCase()
  const ns = 'chunkscribe'
  const name = `${slug}_dtype`
  const ref = `${ns}:${name}`
  return {
    dimName,
    dimTypeRef: ref,
    customDimType: { ns, name, json: synthDimType(dimName, captured) },
  }
}

/** Build a valid 1.21.x dim_type JSON. Fields derived per Mojang's codec:
 *  any missing required field → silent pack rejection. Native game
 *  behaviour (bed explosions, lava flow, etc.) is keyed off the
 *  `ultrawarm` / `bed_works` / `respawn_anchor_works` / `piglin_safe`
 *  fields, NOT off the dim_type name — so a custom dim_type can fully
 *  emulate vanilla nether mechanics. */
function synthDimType(dimName: string, captured: { minY: number; height: number } | null): Record<string, any> {
  const tag = dimName.toLowerCase()
  const isNether = tag.includes('nether')
  const isEnd    = tag.includes('end')

  // Use captured geometry if we have it; otherwise fall back to a
  // permissive overworld-shaped range so any chunk we captured fits.
  const minY   = captured?.minY ?? -64
  const height = captured?.height ?? 384

  return {
    ultrawarm: isNether,
    natural: !isEnd,
    coordinate_scale: 1.0,
    has_skylight: !isNether && !isEnd,
    has_ceiling: isNether,
    ambient_light: isNether ? 0.1 : 0.0,
    ...(isEnd ? { fixed_time: 6000 } : {}),
    piglin_safe: isNether,
    bed_works: !isNether && !isEnd,         // beds explode in nether + end
    respawn_anchor_works: isNether,
    has_raids: !isNether && !isEnd,
    logical_height: height,
    min_y: minY,
    height,
    infiniburn: isNether ? '#minecraft:infiniburn_nether'
              : isEnd    ? '#minecraft:infiniburn_end'
                         : '#minecraft:infiniburn_overworld',
    effects: isNether ? 'minecraft:the_nether'
           : isEnd    ? 'minecraft:the_end'
                      : 'minecraft:overworld',
    monster_spawn_light_level: { type: 'minecraft:uniform', value: { min_inclusive: 0, max_inclusive: 7 } },
    monster_spawn_block_light_limit: 0,
  }
}

export async function writeServerRegistryDatapack(
  worldDir: string,
  reg: CapturedRegistryData,
): Promise<{ packDir: string; dimCount: number; customDimTypeCount: number }> {
  const packDir = path.join(worldDir, 'datapacks', 'chunkscribe')
  await fs.mkdir(packDir, { recursive: true })

  const mcmeta = {
    pack: {
      pack_format: PACK_FORMAT,
      supported_formats: { min_inclusive: 41, max_inclusive: 99 },
      description: 'ChunkScribe: captured custom dimensions.',
    },
  }
  await fs.writeFile(path.join(packDir, 'pack.mcmeta'), JSON.stringify(mcmeta, null, 2))

  let dimCount = 0
  let customDimTypeCount = 0
  const customDimTypesWritten = new Set<string>()

  for (const [fullName, def] of Object.entries(reg.dimensions ?? {})) {
    if (!def || !(def as any).__json) continue
    const { __json, __plan, ...json } = def as any
    const { ns, name } = splitName(fullName)

    // Dim entry.
    const dimDst = path.join(packDir, 'data', ns, 'dimension', `${name}.json`)
    await fs.mkdir(path.dirname(dimDst), { recursive: true })
    await fs.writeFile(dimDst, JSON.stringify(json, null, 2))
    dimCount++

    // Custom dim_type, if needed.
    const plan: DimSavePlan | undefined = __plan
    if (plan?.customDimType) {
      const cdt = plan.customDimType
      const key = `${cdt.ns}:${cdt.name}`
      if (!customDimTypesWritten.has(key)) {
        const dst = path.join(packDir, 'data', cdt.ns, 'dimension_type', `${cdt.name}.json`)
        await fs.mkdir(path.dirname(dst), { recursive: true })
        await fs.writeFile(dst, JSON.stringify(cdt.json, null, 2))
        customDimTypesWritten.add(key)
        customDimTypeCount++
      }
    }
  }

  log.info(`datapack: chunkscribe written (${dimCount} dims, ${customDimTypeCount} custom dim_types)`)
  return { packDir, dimCount, customDimTypeCount }
}

function splitName(full: string): { ns: string; name: string } {
  const i = full.indexOf(':')
  if (i < 0) return { ns: 'minecraft', name: full }
  return { ns: full.slice(0, i), name: full.slice(i + 1) }
}

/**
 * Synthesise a dim JSON for each captured custom dim, using its plan
 * (which selects vanilla-or-custom dim_type and carries the custom JSON
 * if needed). The void-flat generator means chunks not in our captured
 * region files stay empty rather than regenerating with worldgen.
 *
 * Vanilla dim names are skipped — those are governed by level.dat
 * WorldGenSettings, and writing a datapack entry trips MC's duplicate-dim
 * check.
 *
 * Entries are marked `__json: true` so the writer emits them as-is
 * (real JSON booleans, not the 0/1 ints prismarine-nbt would produce).
 */
export function buildVoidDimensionEntries(plans: DimSavePlan[]): Record<string, any> {
  const out: Record<string, any> = {}
  for (const plan of plans) {
    const dn = plan.dimName
    if (dn === 'minecraft:overworld' || dn === 'minecraft:the_nether' || dn === 'minecraft:the_end') continue
    out[dn] = {
      __json: true,
      __plan: plan,
      type: plan.dimTypeRef,
      generator: {
        type: 'minecraft:flat',
        settings: {
          biome: 'minecraft:the_void',
          features: false,
          lakes: false,
          layers: [],
          structure_overrides: [],
        },
      },
    }
  }
  return out
}

/**
 * Patch level.dat to enable the chunkscribe datapack on next world load.
 * MC reads Data.DataPacks.Enabled (list of strings).
 */
export function enableDatapackInLevelDat(levelDataTag: any, packId = 'file/chunkscribe'): void {
  const data = levelDataTag?.value?.Data?.value
  if (!data) return
  const dp = data.DataPacks
  if (!dp) {
    data.DataPacks = {
      type: 'compound',
      value: {
        Enabled:  { type: 'list', value: { type: 'string', value: [packId, 'vanilla'] } },
        Disabled: { type: 'list', value: { type: 'string', value: [] } },
      },
    }
    return
  }
  const enabled = dp.value?.Enabled?.value
  if (!enabled || !Array.isArray(enabled.value)) {
    dp.value.Enabled = { type: 'list', value: { type: 'string', value: [packId, 'vanilla'] } }
    return
  }
  if (!enabled.value.includes(packId)) enabled.value.unshift(packId)
}
