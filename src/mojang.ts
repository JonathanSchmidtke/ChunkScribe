import https from 'node:https'
import { log } from './util/log'

interface Cape {
  id: string
  state: 'ACTIVE' | 'INACTIVE'
  url: string
  alias: string
}

interface Profile {
  id: string
  name: string
  capes: Cape[]
  skins: any[]
}

/**
 * Minimal client for the Mojang Java profile API. We use this to switch the
 * authenticated user's active cape after sign-in — useful for showing off a
 * MineCon 2011 cape on the target server. The user must already OWN the
 * cape; Mojang refuses to apply capes the account doesn't have.
 */
function apiCall(method: 'GET' | 'PUT' | 'DELETE', urlPath: string, token: string, body?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null
    const req = https.request(
      {
        hostname: 'api.minecraftservices.com',
        port: 443,
        path: urlPath,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          if ((res.statusCode ?? 0) >= 400) return reject(new Error(`${res.statusCode}: ${raw}`))
          try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) }
        })
      },
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

export async function getProfile(token: string): Promise<Profile> {
  return apiCall('GET', '/minecraft/profile', token)
}

export async function setActiveCape(token: string, capeId: string): Promise<void> {
  await apiCall('PUT', '/minecraft/profile/capes/active', token, { capeId })
}

export async function applyCape(
  token: string,
  alias: string,
): Promise<{ ok: boolean; error?: string; applied?: string }> {
  try {
    const profile = await getProfile(token)
    const owned = profile.capes.map((c) => c.alias).join(', ') || 'none'
    log.info(`mojang profile: ${profile.name} (owned capes: ${owned})`)

    const want = alias.replace(/\s+/g, '').toLowerCase()
    const cape = profile.capes.find((c) => c.alias.replace(/\s+/g, '').toLowerCase() === want)
    if (!cape) {
      return { ok: false, error: `cape "${alias}" not owned; available: ${owned}` }
    }
    if (cape.state === 'ACTIVE') {
      log.info(`cape "${cape.alias}" is already active`)
      return { ok: true, applied: cape.alias }
    }
    await setActiveCape(token, cape.id)
    log.info(`activated cape: ${cape.alias}`)
    return { ok: true, applied: cape.alias }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * Get the Mojang Java token via prismarine-auth, reusing the cache that
 * minecraft-protocol's createClient also reads from. Returns null if auth
 * fails (no internet, revoked token, etc.).
 */
export async function getMinecraftJavaToken(
  username: string | undefined,
  profilesFolder: string,
): Promise<string | null> {
  try {
    const { Authflow } = require('prismarine-auth')
    const flow = new Authflow(username || 'ChunkScribe', profilesFolder)
    const tok = await flow.getMinecraftJavaToken()
    return tok?.token || null
  } catch (e) {
    log.warn(`getMinecraftJavaToken failed: ${(e as Error).message}`)
    return null
  }
}
