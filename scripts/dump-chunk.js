#!/usr/bin/env node
// Dump a single chunk from a region file. Usage:
//   node scripts/dump-chunk.js <region-dir> <cx> <cz>
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const nbt = require('prismarine-nbt')

const dir = process.argv[2]
const cx = parseInt(process.argv[3], 10)
const cz = parseInt(process.argv[4], 10)
const rx = Math.floor(cx / 32)
const rz = Math.floor(cz / 32)
const localX = ((cx % 32) + 32) % 32
const localZ = ((cz % 32) + 32) % 32
const slotIdx = localX + localZ * 32

const fp = path.join(dir, `r.${rx}.${rz}.mca`)
const buf = fs.readFileSync(fp)
const offEntry = slotIdx * 4
const offset = (buf[offEntry] << 16) | (buf[offEntry+1] << 8) | buf[offEntry+2]
const sectors = buf[offEntry+3]
console.log(`chunk ${cx},${cz} → region ${rx},${rz} slot ${slotIdx} sectors=${sectors} offset=${offset}`)
if (!offset || !sectors) { console.log('not present'); process.exit(0) }
const start = offset * 4096
const len = buf.readUInt32BE(start)
const comp = buf[start+4]
console.log(`payload bytes=${len} comp=${comp}`)
const data = buf.slice(start + 5, start + 4 + len)
const raw = comp === 1 ? zlib.gunzipSync(data) : comp === 2 ? zlib.inflateSync(data) : data
console.log(`decompressed=${raw.length}b`)
;(async () => {
  try {
    const { parsed, metadata } = await nbt.parse(raw)
    console.log(`PARSED OK, consumed ${metadata.size}/${raw.length} bytes (trailing ${raw.length - metadata.size})`)
    console.log('top-level keys:', Object.keys(parsed.value || {}))
    if (raw.length - metadata.size > 0) {
      console.log('trailing bytes (hex):', raw.slice(metadata.size, Math.min(raw.length, metadata.size + 80)).toString('hex'))
    }
  } catch (e) {
    console.log('parse failed:', e.message)
    const m = e.message.match(/at (\d+):/)
    const endPos = m ? +m[1] : 0
    console.log(`bytes around supposed-end (${endPos-8}..${endPos+96}):`)
    console.log(raw.slice(Math.max(0, endPos-8), Math.min(raw.length, endPos+96)).toString('hex'))
    console.log('first 32 bytes:', raw.slice(0, 32).toString('hex'))
  }
})()
