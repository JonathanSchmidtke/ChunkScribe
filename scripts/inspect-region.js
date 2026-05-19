#!/usr/bin/env node
// Region-file analyzer: counts populated chunks vs missing sectors vs corrupt NBT.
// Usage: node scripts/inspect-region.js <region-dir>

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const nbt = require('prismarine-nbt')

const dir = process.argv[2]
if (!dir) { console.error('usage: inspect-region <region-dir>'); process.exit(1) }

const files = fs.readdirSync(dir).filter(f => f.endsWith('.mca'))

;(async () => {
  let totalPresent = 0, totalCorrupt = 0, allCorrupt = []
  for (const f of files) {
    const m = f.match(/r\.(-?\d+)\.(-?\d+)\.mca/)
    if (!m) continue
    const rx = +m[1], rz = +m[2]
    const buf = fs.readFileSync(path.join(dir, f))
    if (buf.length < 8192) { console.log(`${f}: too small (${buf.length}b)`); continue }

    let present = 0, corrupt = 0
    const corruptList = []
    for (let i = 0; i < 1024; i++) {
      const off = i * 4
      const offset = (buf[off] << 16) | (buf[off+1] << 8) | buf[off+2]
      const sectors = buf[off+3]
      if (offset === 0 || sectors === 0) continue
      present++
      const start = offset * 4096
      if (start + 5 > buf.length) { corrupt++; continue }
      const len = buf.readUInt32BE(start)
      const comp = buf[start + 4]
      const data = buf.slice(start + 5, start + 4 + len)
      try {
        const raw = comp === 1 ? zlib.gunzipSync(data) : comp === 2 ? zlib.inflateSync(data) : data
        const cx = rx * 32 + (i & 31)
        const cz = rz * 32 + (i >> 5)
        try {
          await nbt.parse(raw)
        } catch (e) {
          const m = e.message.match(/still have (\d+) bytes/)
          const leftover = m ? +m[1] : 0
          // MC tolerates trailing junk; only count as broken when the parser
          // gave up so early that the chunk is effectively empty.
          if (leftover > 1000) {
            corrupt++
            corruptList.push([cx, cz, `severe ${leftover}b leftover`])
          }
        }
      } catch (e) {
        corrupt++
        const cx = rx * 32 + (i & 31)
        const cz = rz * 32 + (i >> 5)
        corruptList.push([cx, cz, 'decompress: ' + e.message])
      }
    }
    console.log(`${f}: ${present} present, ${corrupt} corrupt`)
    if (corruptList.length) {
      for (const [cx, cz, msg] of corruptList.slice(0, 5)) {
        console.log(`  corrupt ${cx},${cz}: ${msg}`)
      }
      if (corruptList.length > 5) console.log(`  ... +${corruptList.length - 5} more`)
    }
    totalPresent += present
    totalCorrupt += corrupt
    allCorrupt.push(...corruptList)
  }
  console.log(`\nTOTAL: ${totalPresent} chunks present, ${totalCorrupt} corrupt (${((totalCorrupt / Math.max(1, totalPresent)) * 100).toFixed(1)}%)`)
})()
