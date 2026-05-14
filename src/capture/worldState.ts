import { log } from '../util/log'

/**
 * Server-pushed world state we want to bake into level.dat:
 * spawn point, time of day, weather, difficulty, world border.
 *
 * Packet names below cover several recent protocol revisions —
 * minecraft-protocol exposes whichever one matches the version, so
 * we tolerate either by registering both.
 */
export class WorldStateCapture {
  spawnX = 0
  spawnY = 64
  spawnZ = 0
  spawnAngle = 0

  worldAge: bigint = 0n
  timeOfDay: bigint = 0n

  raining = false
  thunder = false
  rainLevel = 0
  thunderLevel = 0

  difficulty: number | null = null
  difficultyLocked = false

  borderCenterX = 0
  borderCenterZ = 0
  borderDiameter = 60_000_000
  borderWarnBlocks = 5
  borderWarnTime = 15

  // ---- spawn ----
  onSpawnPosition(p: any) {
    const loc = p.location ?? p
    if (typeof loc?.x === 'number') {
      this.spawnX = loc.x; this.spawnY = loc.y; this.spawnZ = loc.z
      this.spawnAngle = p.angle ?? 0
      log.dbg(`world spawn -> ${this.spawnX},${this.spawnY},${this.spawnZ}`)
    }
  }

  // ---- time ----
  onTime(p: any) {
    if (typeof p?.age === 'bigint')        this.worldAge   = p.age
    else if (typeof p?.age === 'number')   this.worldAge   = BigInt(p.age)
    if (typeof p?.time === 'bigint')       this.timeOfDay  = p.time
    else if (typeof p?.time === 'number')  this.timeOfDay  = BigInt(p.time)
    // protocol stores "negative time" to indicate doDaylightCycle=false;
    // we keep the sign, write the absolute as DayTime.
  }

  // ---- weather ----
  onGameStateChange(p: any) {
    // reason codes (modern):
    // 1 = end raining, 2 = begin raining, 7 = rain level change, 8 = thunder level change
    const reason = p.reason
    const value = p.gameMode ?? p.value
    switch (reason) {
      case 1: this.raining = false; break
      case 2: this.raining = true;  break
      case 7: this.rainLevel    = value ?? 0; break
      case 8: this.thunderLevel = value ?? 0; break
    }
    this.thunder = this.raining && this.thunderLevel > 0
  }

  // ---- difficulty ----
  onDifficulty(p: any) {
    this.difficulty       = p.difficulty ?? p.value ?? null
    this.difficultyLocked = !!(p.difficultyLocked ?? p.locked)
  }

  // ---- world border ----
  onBorderInit(p: any) {
    this.borderCenterX     = p.x ?? this.borderCenterX
    this.borderCenterZ     = p.z ?? this.borderCenterZ
    this.borderDiameter    = p.newDiameter ?? p.diameter ?? this.borderDiameter
    this.borderWarnBlocks  = p.warningBlocks ?? this.borderWarnBlocks
    this.borderWarnTime    = p.warningTime ?? this.borderWarnTime
  }
  onBorderSize(p: any)   { this.borderDiameter = p.newDiameter ?? p.diameter ?? this.borderDiameter }
  onBorderCenter(p: any) { this.borderCenterX = p.x ?? this.borderCenterX; this.borderCenterZ = p.z ?? this.borderCenterZ }
}
