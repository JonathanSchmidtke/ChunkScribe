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
    // Field names vary across versions; try the common ones defensively.
    this.dimensionName = p.worldName ?? p.dimension?.name ?? p.dimension ?? this.dimensionName
    this.dimensionType = p.worldType ?? p.dimensionType ?? this.dimensionType
    this.viewDistance = p.viewDistance ?? this.viewDistance
    this.hashedSeed = BigInt(p.hashedSeed ?? 0)
    this.gameMode = p.gameMode ?? this.gameMode
    log.info(`play login: dim=${this.dimensionName} type=${this.dimensionType} view=${this.viewDistance}`)
  }

  onRespawn(p: any) {
    const prev = this.dimensionName
    this.dimensionName = p.worldName ?? p.dimension ?? this.dimensionName
    this.dimensionType = p.worldType ?? p.dimensionType ?? this.dimensionType
    if (prev !== this.dimensionName) log.info(`dimension change: ${prev} -> ${this.dimensionName}`)
  }
}
