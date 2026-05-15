/**
 * Visual-only cape override. The proxy rewrites the textures property on the
 * `player_info` packet for the local player UUID so MC's renderer pulls a
 * different cape texture. Mojang doesn't have to "give" us the cape because
 * we're not asking Mojang — we're hand-feeding the client the URL.
 *
 * Stripping `signature` is required: the client trusts unsigned properties
 * only when secure-chat enforcement is off (it is, in our synthetic login).
 *
 * What other players on the server see is unaffected — that's served by
 * Mojang's session server based on the real account.
 */

const CAPE_HASHES: Record<string, string> = {
  // Aliases are case-insensitive, whitespace-insensitive.
  'minecon2011': '953cac8b779fe41383e675ee2b86071a71658f2180f56fbce8aa315ea70e2ed6',
  'minecon2012': 'a2e8d97ec79100e90a75d369d1b3ba81273c4f82bc1b737e934eed4a854be1b6',
  'minecon2013': '153b1a0dfcbae953cdeb6f2c2bf6bf79943a3f32f1f2e2c10a52a4f5b53ed29c',
  'minecon2015': 'b0cc08840700447322d953a02b965f1d65a13a603bf64b17c803c21446fe1635',
  'minecon2016': 'e7dfea16dc83c97df01a12fabbd1216359c0cd0ea42f9999b6e97c584963e980',
  'migrator':    '2340c0e03dd24a11b15a8b33c2a7e9e32abb2051b2481d0ba7defd635ca7a933',
  'vanilla':     'e7dfea16dc83c97df01a12fabbd1216359c0cd0ea42f9999b6e97c584963e980',
  'founders':    '7d8e4b65a01e1238fa7b41b40c4d088a08c2f3175c8aebd17adabf5b5cce04e8',
  'mojang':      '5786fe99be377dfb6858859f926c4dbc995751e91cee373468c5fbf4865e7151',
}

export function capeUrlForAlias(alias: string): string | null {
  const key = alias.trim().toLowerCase().replace(/\s+/g, '')
  const hash = CAPE_HASHES[key]
  // HTTPS — modern MC (1.20.5+) silently drops textures with http:// URLs.
  return hash ? `https://textures.minecraft.net/texture/${hash}` : null
}

export function knownCapeAliases(): string[] {
  return Object.keys(CAPE_HASHES)
}

function uuidEq(a: any, b: any): boolean {
  if (!a || !b) return false
  return String(a).replace(/-/g, '').toLowerCase() === String(b).replace(/-/g, '').toLowerCase()
}

/**
 * Mutate-in-place an outgoing `player_info` packet so the entry for
 * `selfUuid` has the textures property's CAPE.url set to `capeUrl`. Other
 * players in the same packet are left alone.
 *
 * Returns true if it modified anything (used only for tracing).
 */
export function injectCapeIntoPlayerInfo(data: any, selfUuid: string, capeUrl: string): boolean {
  const list = Array.isArray(data?.data) ? data.data : []
  let modified = false
  for (const entry of list) {
    if (!uuidEq(entry?.uuid ?? entry?.UUID ?? entry?.id, selfUuid)) continue
    const props =
      entry?.player?.properties ??
      entry?.playerData?.properties ??
      entry?.properties ??
      entry?.actions?.find?.((a: any) => a?.name === 'add_player')?.properties
    if (!Array.isArray(props)) continue

    for (const prop of props) {
      if (prop?.name !== 'textures') continue
      try {
        const decoded = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8'))
        if (!decoded.textures) decoded.textures = {}
        decoded.textures.CAPE = { url: capeUrl }
        // Upgrade URLs to HTTPS — 1.20.5+ rejects http://
        if (decoded.textures?.SKIN?.url) {
          decoded.textures.SKIN.url = String(decoded.textures.SKIN.url).replace(/^http:\/\//, 'https://')
        }
        prop.value = Buffer.from(JSON.stringify(decoded)).toString('base64')
        // Keep the original Mojang signature + signatureRequired untouched.
        // The signature will mismatch our edited content, BUT vanilla MC
        // skips the signature check whenever the profile UUID being rendered
        // matches the local player's own UUID (Antonio32a's well-known trick).
        // Stripping the signature was triggering the "fallback to default
        // Steve, no overlay layers, no cape" code path — keeping it intact
        // lets the UUID-match skip apply and the textures render.
        modified = true
      } catch {
        // unparseable — leave alone
      }
    }
  }
  return modified
}
