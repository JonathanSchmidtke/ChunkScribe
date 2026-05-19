#!/usr/bin/env node
// Inspect a transformed world: biome distribution per dim, chunk Y range,
// block palette samples. Run after Transform to verify what actually ended
// up on disk vs what should be there.
// Usage: node scripts/audit-world.js <world-dir>

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const nbt = require('prismarine-nbt')

const root = process.argv[2]
if (!root) { console.error('usage: audit-world <world-dir>'); process.exit(1) }

function* regionDirs(d) {
  // Walks every region/ dir under the world (vanilla + datapack dims).
  const seen = new Set()
  const walk = (p, depth) => {
    if (depth > 6) return
    let entries
    try { entries = fs.readdirSync(p, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(p, e.name)
      if (e.isDirectory()) {
        if (e.name === 'region' && !seen.has(full)) { seen.add(full); /* yield in caller */ }
        walk(full, depth + 1)
      }
    }
  }
  walk(d, 0)
  for (const x of seen) yield x
}

async function inspectRegion(rdir) {
  const files = fs.readdirSync(rdir).filter(f => f.endsWith('.mca'))
  const biomeHits = new Map()
  let chunks = 0, parseFails = 0, minY = Infinity, maxY = -Infinity
  const blockHits = new Map()

  for (const f of files) {
    const buf = fs.readFileSync(path.join(rdir, f))
    for (let i = 0; i < 1024; i++) {
      const o = i * 4
      const offset = (buf[o] << 16) | (buf[o+1] << 8) | buf[o+2]
      const sectors = buf[o+3]
      if (!offset || !sectors) continue
      const start = offset * 4096
      const len = buf.readUInt32BE(start)
      const comp = buf[start+4]
      let raw
      try {
        const data = buf.slice(start+5, start+4+len)
        raw = comp === 1 ? zlib.gunzipSync(data) : comp === 2 ? zlib.inflateSync(data) : data
      } catch { parseFails++; continue }
      // Use protodef directly so we tolerate trailing junk (most chunks
      // have ~72 bytes after the root compound that prismarine-nbt's
      // `parse` rejects but MC reads happily).
      let parsed
      try { parsed = nbt.protos.big.parsePacketBuffer('nbt', raw).data }
      catch { parseFails++; continue }
      chunks++
      const v = parsed.value
      const sections = v.sections?.value?.value || v.Sections?.value?.value || []
      for (const sec of sections) {
        const sv = sec.value || sec
        const y = sv.Y?.value
        if (typeof y === 'number') { if (y < minY) minY = y; if (y > maxY) maxY = y }
        // Biome palette
        const bp = sv.biomes?.value?.palette?.value?.value || []
        for (const b of bp) if (typeof b === 'string') biomeHits.set(b, (biomeHits.get(b) || 0) + 1)
        // Block palette (just collect names, no per-block weighting)
        const blocks = sv.block_states?.value?.palette?.value?.value || []
        for (const blk of blocks) {
          const blkV = blk.value || blk
          const nm = blkV.Name?.value
          if (typeof nm === 'string') blockHits.set(nm, (blockHits.get(nm) || 0) + 1)
        }
      }
    }
  }
  return { chunks, parseFails, minY, maxY, biomeHits, blockHits }
}

;(async () => {
  console.log(`=== world audit: ${root} ===\n`)
  // level.dat snapshot
  try {
    const raw = fs.readFileSync(path.join(root, 'level.dat'))
    const dec = await nbt.parse(raw[0] === 0x1f ? zlib.gunzipSync(raw) : raw)
    const data = dec.parsed.value?.Data?.value
    console.log(`LevelName:    ${data?.LevelName?.value}`)
    console.log(`DataVersion:  ${data?.DataVersion?.value}`)
    console.log(`Spawn:        ${data?.SpawnX?.value},${data?.SpawnY?.value},${data?.SpawnZ?.value}`)
    const wgs = data?.WorldGenSettings?.value
    const dims = wgs?.dimensions?.value
    if (dims) console.log(`WGS dims:     ${Object.keys(dims).join(', ')}`)
    const enabled = data?.DataPacks?.value?.Enabled?.value?.value
    console.log(`Datapacks:    ${(enabled || []).join(', ') || '(none enabled)'}`)
  } catch (e) {
    console.log('level.dat read failed:', e.message)
  }
  console.log()

  for (const rdir of regionDirs(root)) {
    const rel = path.relative(root, rdir)
    console.log(`--- ${rel} ---`)
    const r = await inspectRegion(rdir)
    console.log(`chunks=${r.chunks} parseFails=${r.parseFails} sectionY=[${r.minY}..${r.maxY}]`)
    const topBiomes = [...r.biomeHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    console.log(`top biomes:`)
    for (const [n, c] of topBiomes) console.log(`  ${n}: ${c}`)
    if (r.biomeHits.size > 10) console.log(`  ... +${r.biomeHits.size - 10} more`)
    const topBlocks = [...r.blockHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    console.log(`top blocks (palette occurrences, not weight):`)
    for (const [n, c] of topBlocks) console.log(`  ${n}: ${c}`)
    console.log()
  }
})().catch(e => { console.error(e); process.exit(1) })
