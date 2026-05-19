#!/usr/bin/env node
// Scan all .mca files in a region dir and report whether specific block IDs
// appear in any palette. Usage:
//   node scripts/grep-blocks.js <region-dir> bed flower_pot potted_oak_sapling
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const [,, dir, ...needles] = process.argv
const files = fs.readdirSync(dir).filter(f => f.endsWith('.mca'))

const found = new Map()
for (const n of needles) found.set(n, 0)

for (const f of files) {
  const buf = fs.readFileSync(path.join(dir, f))
  for (let i = 0; i < 1024; i++) {
    const off = i * 4
    const offset = (buf[off] << 16) | (buf[off+1] << 8) | buf[off+2]
    const sectors = buf[off+3]
    if (!offset || !sectors) continue
    const start = offset * 4096
    const len = buf.readUInt32BE(start)
    const comp = buf[start+4]
    try {
      const data = buf.slice(start+5, start+4+len)
      const raw = comp === 1 ? zlib.gunzipSync(data) : comp === 2 ? zlib.inflateSync(data) : data
      const s = raw.toString('latin1')
      for (const n of needles) {
        const re = new RegExp(`minecraft:${n}\\b`, 'g')
        const m = s.match(re)
        if (m) found.set(n, found.get(n) + m.length)
      }
    } catch {}
  }
}
for (const [n, c] of found) console.log(`minecraft:${n}: ${c} occurrences across all chunks`)
