#!/usr/bin/env node
// Repair a resource pack zip whose EOCD claims to be a split archive
// (disk number 0xFFFF, bogus CD size/offset). Modern Mojang server packs
// ship like this so simple unzippers reject them; MC's loader skips the
// EOCD entirely and walks the CDH chain directly.
//
// What we do: scan for the real CDH chain, recompute total entries / CD
// size / CD offset, and rewrite a clean EOCD pointing at the real chain
// with disk number = 0. The underlying file data + CDH entries are
// untouched — they were always correct.
//
// Usage: node scripts/repair-zip.js <in.zip> <out.zip>

const fs = require('fs')

const [, , inPath, outPath] = process.argv
if (!inPath || !outPath) { console.error('usage: repair-zip <in.zip> <out.zip>'); process.exit(1) }

const buf = fs.readFileSync(inPath)

// Find first CDH signature (PK\x01\x02) — that's the real CD start.
let cdStart = -1
for (let i = 0; i < buf.length - 3; i++) {
  if (buf[i] === 0x50 && buf[i+1] === 0x4b && buf[i+2] === 0x01 && buf[i+3] === 0x02) {
    cdStart = i; break
  }
}
if (cdStart < 0) { console.error('no CDH found'); process.exit(2) }

// Find last EOCD signature (PK\x05\x06)
let eocdAt = -1
for (let i = buf.length - 22; i >= 0; i--) {
  if (buf[i] === 0x50 && buf[i+1] === 0x4b && buf[i+2] === 0x05 && buf[i+3] === 0x06) {
    eocdAt = i; break
  }
}
if (eocdAt < 0) { console.error('no EOCD found'); process.exit(3) }

const cdSize = eocdAt - cdStart

// Count CDH entries by walking the chain. Each CDH is variable-sized
// (header + filename + extra + comment).
let entryCount = 0
let p = cdStart
while (p < eocdAt) {
  if (buf[p] !== 0x50 || buf[p+1] !== 0x4b || buf[p+2] !== 0x01 || buf[p+3] !== 0x02) break
  const fnameLen = buf.readUInt16LE(p + 28)
  const extraLen = buf.readUInt16LE(p + 30)
  const commentLen = buf.readUInt16LE(p + 32)
  p += 46 + fnameLen + extraLen + commentLen
  entryCount++
}

console.log(`CD at ${cdStart}, size ${cdSize}, ${entryCount} entries, EOCD at ${eocdAt}`)

// Rebuild EOCD record (22 bytes, no comment).
const eocd = Buffer.alloc(22)
eocd.writeUInt32LE(0x06054b50, 0)
eocd.writeUInt16LE(0,            4)   // disk number
eocd.writeUInt16LE(0,            6)   // disk with CD
eocd.writeUInt16LE(entryCount,   8)   // entries on this disk
eocd.writeUInt16LE(entryCount,  10)   // total entries
eocd.writeUInt32LE(cdSize,      12)
eocd.writeUInt32LE(cdStart,     16)
eocd.writeUInt16LE(0,           20)   // comment length

// Output = original bytes up to (but not including) the old EOCD, then new EOCD.
const out = Buffer.concat([buf.slice(0, eocdAt), eocd])
fs.writeFileSync(outPath, out)
console.log(`wrote ${out.length} bytes -> ${outPath}`)
