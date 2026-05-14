/**
 * Decode entity metadata into NBT-shaped fields.
 *
 * Minecraft metadata is a sparse list of `{ key, type, value }` entries.
 * Indices 0..7 are defined on `Entity` (base class) and are reliable across
 * all entity types. 8..14 are `LivingEntity` and apply to every mob. From 15
 * onward indices are per-subclass and vary release-to-release, so we only
 * decode the universally-applicable subset plus a few well-known ones.
 *
 * minecraft-protocol pre-decodes metadata values; for an Optional<T> the
 * `present`/`value` shape varies. We tolerate either `null` (absent) or
 * a wrapped { present, value } object.
 */
export interface DecodedMetadata {
  CustomName?: string         // JSON text component, written as-is
  CustomNameVisible?: boolean
  Silent?: boolean
  NoGravity?: boolean
  Glowing?: boolean
  Invisible?: boolean
  OnFire?: boolean
  Sneaking?: boolean
  Sprinting?: boolean
  Air?: number
  Pose?: string
  TicksFrozen?: number
  Health?: number             // LivingEntity index 9
  IsBaby?: boolean            // common index 16/17 on age-able mobs
}

const POSE_NAMES = [
  'STANDING', 'FALL_FLYING', 'SLEEPING', 'SWIMMING', 'SPIN_ATTACK', 'CROUCHING',
  'LONG_JUMPING', 'DYING', 'CROAKING', 'USING_TONGUE', 'SITTING', 'ROARING',
  'SNIFFING', 'EMERGING', 'DIGGING', 'SLIDING', 'SHOOTING', 'INHALING',
]

export function decodeEntityMetadata(meta: any): DecodedMetadata {
  const out: DecodedMetadata = {}
  if (!meta) return out

  // minecraft-protocol may give us an array or a keyed object
  const entries: any[] = Array.isArray(meta) ? meta
                       : typeof meta === 'object' ? Object.values(meta)
                       : []

  for (const entry of entries) {
    if (!entry || typeof entry.key !== 'number') continue
    const v = unwrapOptional(entry.value)
    switch (entry.key) {
      case 0: { // Entity flags (byte)
        const flags = v | 0
        out.OnFire    = (flags & 0x01) !== 0
        out.Sneaking  = (flags & 0x02) !== 0
        out.Sprinting = (flags & 0x08) !== 0
        out.Invisible = (flags & 0x20) !== 0
        out.Glowing   = (flags & 0x40) !== 0
        break
      }
      case 1: out.Air = numOr(v, 300); break
      case 2: if (v != null) out.CustomName = chatToString(v); break
      case 3: out.CustomNameVisible = !!v; break
      case 4: out.Silent = !!v; break
      case 5: out.NoGravity = !!v; break
      case 6: out.Pose = typeof v === 'number' ? POSE_NAMES[v] ?? 'STANDING' : 'STANDING'; break
      case 7: out.TicksFrozen = numOr(v, 0); break

      // LivingEntity (8..14). 8 = hand state flags (skip).
      case 9: if (typeof v === 'number') out.Health = v; break

      // Common AgeableMob / Zombie baby flag. Index drifted between
      // versions (16 on older, 17 on newer). If we see a boolean at
      // either we treat it as IsBaby. False-positives are harmless
      // since the saved NBT just gets an extra IsBaby=false.
      case 16:
      case 17:
        if (typeof v === 'boolean') out.IsBaby = v
        break
    }
  }
  return out
}

function unwrapOptional(v: any): any {
  if (v && typeof v === 'object' && 'present' in v) return v.present ? v.value : null
  return v
}
function numOr(v: any, d: number): number { return typeof v === 'number' ? v : d }

/**
 * Render a chat-component value as a JSON string suitable for the
 * CustomName NBT field. Minecraft accepts either a JSON object string
 * or a plain string. We pass through whatever shape we got.
 */
function chatToString(v: any): string {
  if (typeof v === 'string') return v
  try { return JSON.stringify(v) } catch { return String(v) }
}
