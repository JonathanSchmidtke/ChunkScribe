import { log } from './util/log'

export type Phase = 'handshaking' | 'status' | 'login' | 'configuration' | 'play'

/**
 * Tracks protocol state and dimension metadata. The configuration phase
 * (1.20.2+) carries registry/dimension data the world save needs;
 * later respawn/dimension-change packets update active dimension.
 */
export class PhaseTracker {
  phase: Phase = 'login'
  dimensionName = 'minecraft:overworld'
  dimensionType = 'minecraft:overworld'
  /** Index of the active dim_type in the captured `minecraft:dimension_type`
   *  registry. 1.21+ SpawnInfo carries this as a varint; we resolve it to
   *  a full name (dimensionType) via RegistryCapture at capture time. */
  dimensionTypeIndex = -1
  worldHeight = 384
  minY = -64
  viewDistance = 12
  hashedSeed: bigint = 0n
  gameMode = 0
  dataVersion = 0

  observe(state: string | undefined) {
    if (state && state !== this.phase) {
      log.dbg('phase ->', state)
      this.phase = state as Phase
    }
  }

  onPlayLogin(p: any) {
    // 1.21.x bundles dimension/seed/gamemode inside a worldState SpawnInfo
    // sub-container; older versions had them at the top level. Read both.
    // SpawnInfo.dimension is a varint INDEX into the dim_type registry —
    // RegistryCapture resolves it to a full name in Capture.adoptDimensionGeometry.
    const ws = p.worldState ?? {}
    this.dimensionName = ws.name ?? p.worldName ?? p.dimension?.name ?? p.dimension ?? this.dimensionName
    this.dimensionTypeIndex = pickDimTypeIndex(ws, p, this.dimensionTypeIndex)
    this.viewDistance = p.viewDistance ?? this.viewDistance
    this.hashedSeed = BigInt((ws.hashedSeed ?? p.hashedSeed ?? 0) as any)
    const gm = ws.gamemode ?? p.gameMode
    this.gameMode = typeof gm === 'number' ? gm : this.gameMode
    log.info(`play login: dim=${this.dimensionName} typeIdx=${this.dimensionTypeIndex} view=${this.viewDistance}`)
  }

  onRespawn(p: any) {
    const prev = this.dimensionName
    const ws = p.worldState ?? {}
    this.dimensionName = ws.name ?? p.worldName ?? p.dimension ?? this.dimensionName
    this.dimensionTypeIndex = pickDimTypeIndex(ws, p, this.dimensionTypeIndex)
    if (prev !== this.dimensionName) log.info(`dimension change: ${prev} -> ${this.dimensionName} (typeIdx=${this.dimensionTypeIndex})`)
  }
}

/** SpawnInfo.dimension is a varint in 1.21; older schemas exposed it as
 *  `worldType` / `dimensionType` strings. Prefer the numeric index when
 *  present and fall through. Strings are handled by the caller via
 *  registry lookup. */
function pickDimTypeIndex(ws: any, p: any, prev: number): number {
  const candidate = ws?.dimension ?? p?.worldType ?? p?.dimensionType
  return typeof candidate === 'number' ? candidate : prev
}
