import { log } from './util/log'

/**
 * Skin/cape rewriting for the proxy player.
 *
 * The user's actual Mojang skin already comes through the player_info
 * packet (target server queries Mojang's session servers using the UUID
 * our proxy authenticates with). We just intercept that packet and tack
 * a Minecon 2011 cape onto the textures payload before forwarding to the
 * MC client.
 *
 * NOTE: this only affects what YOUR MC client renders. Other players on
 * the target server will still see whatever Mojang says — cape changes
 * can't be forged across an online-mode auth boundary.
 */

const MINECON_2011_CAPE_HASH = '953cac8b779fe41383e675ee2b86071a71658f2180f56fbce8aa315ea70e2ed6'
const MINECON_2011_CAPE_URL  = `https://textures.minecraft.net/texture/${MINECON_2011_CAPE_HASH}`

/** Mutates `data` in-place; returns it for chaining. */
export function injectCape(data: any, onlyUuid?: string | undefined): any {
  if (!data) return data

  // 1.21.x: data.data is the entries array (player_info_update).
  // Older: data.players or data.entries. We tolerate any of them.
  const entries: any[] | undefined =
    Array.isArray(data?.data)     ? data.data :
    Array.isArray(data?.players)  ? data.players :
    Array.isArray(data?.entries)  ? data.entries :
    Array.isArray(data)           ? data :
    undefined
  if (!entries) return data

  for (const entry of entries) {
    if (onlyUuid && !uuidMatches(entry.uuid ?? entry.UUID, onlyUuid)) continue

    // The properties live either at entry.player.properties (segmented action
    // shape) or directly on entry.properties (flat shape) depending on version.
    const propsArr: any[] | undefined =
      Array.isArray(entry?.player?.properties) ? entry.player.properties :
      Array.isArray(entry?.add_player?.properties) ? entry.add_player.properties :
      Array.isArray(entry?.properties) ? entry.properties :
      undefined
    if (!propsArr) continue

    const tex = propsArr.find((p: any) => p?.name === 'textures' || p?.key === 'textures')
    if (!tex || typeof tex.value !== 'string') continue

    try {
      const json = JSON.parse(Buffer.from(tex.value, 'base64').toString('utf8'))
      if (!json.textures) json.textures = {}
      json.textures.CAPE = { url: MINECON_2011_CAPE_URL }
      tex.value = Buffer.from(JSON.stringify(json)).toString('base64')
      // We rewrote the payload — the Mojang signature no longer matches.
      // Clear it so the client renders unsigned (vanilla allows this).
      tex.signature = undefined
      if ('isSigned' in tex) tex.isSigned = false
    } catch (e) {
      log.dbg(`cape inject parse fail: ${(e as Error).message}`)
    }
  }
  return data
}

function uuidMatches(packetUuid: any, str: string): boolean {
  const norm = (s: string) => s.replace(/-/g, '').toLowerCase()
  const want = norm(str)
  if (typeof packetUuid === 'string') return norm(packetUuid) === want
  if (Array.isArray(packetUuid) && packetUuid.length === 4) {
    const hex = packetUuid.map(n => (n >>> 0).toString(16).padStart(8, '0')).join('')
    return hex === want
  }
  return false
}
