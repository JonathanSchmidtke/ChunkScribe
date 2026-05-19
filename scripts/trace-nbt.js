#!/usr/bin/env node
// Trace NBT byte-by-byte to find where the structure goes wrong.
// Usage: node scripts/trace-nbt.js <region-dir> <cx> <cz>
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const TAG = {
  0:'End', 1:'Byte', 2:'Short', 3:'Int', 4:'Long', 5:'Float', 6:'Double',
  7:'ByteArray', 8:'String', 9:'List', 10:'Compound', 11:'IntArray', 12:'LongArray',
}

const [,, dir, cxs, czs] = process.argv
const cx = +cxs, cz = +czs
const rx = Math.floor(cx / 32), rz = Math.floor(cz / 32)
const buf = fs.readFileSync(path.join(dir, `r.${rx}.${rz}.mca`))
const slot = ((cx % 32) + 32) % 32 + ((cz % 32) + 32) % 32 * 32
const off = (buf[slot*4] << 16) | (buf[slot*4+1] << 8) | buf[slot*4+2]
const start = off * 4096
const len = buf.readUInt32BE(start)
const comp = buf[start+4]
const data = buf.slice(start + 5, start + 4 + len)
const raw = comp === 1 ? zlib.gunzipSync(data) : comp === 2 ? zlib.inflateSync(data) : data

let p = 0
const stack = []
const indent = () => '  '.repeat(stack.length)

function readShort() { const v = raw.readInt16BE(p); p += 2; return v }
function readInt()   { const v = raw.readInt32BE(p); p += 4; return v }
function readLong()  { const v = raw.readBigInt64BE(p); p += 8; return v }
function readFloat() { const v = raw.readFloatBE(p); p += 4; return v }
function readDouble(){ const v = raw.readDoubleBE(p); p += 8; return v }
function readStr() { const len = readShort(); const s = raw.slice(p, p + len).toString('utf8'); p += len; return s }

function skipValue(type) {
  switch (type) {
    case 1: p += 1; return
    case 2: p += 2; return
    case 3: p += 4; return
    case 4: p += 8; return
    case 5: p += 4; return
    case 6: p += 8; return
    case 7: { const n = readInt(); p += n; return }
    case 8: { const n = readShort(); p += n; return }
    case 9: { const et = raw[p++]; const n = readInt(); for (let i=0;i<n;i++) { if (et===10) parseCompound(`[${i}]`); else if (et===9) skipValue(9); else skipValue(et) } return }
    case 10: parseCompound('<anon>'); return
    case 11: { const n = readInt(); p += n*4; return }
    case 12: { const n = readInt(); p += n*8; return }
  }
}

function parseCompound(name) {
  stack.push(name)
  console.log(`${indent()}{ ${name}  @ ${p-name.length}`)
  while (p < raw.length) {
    const startField = p
    const t = raw[p++]
    if (t === 0) {
      console.log(`${indent()}} END @ ${startField}`)
      stack.pop()
      return
    }
    if (t === undefined || t > 12) { console.log(`${indent()}!!BAD TAG ${t} @ ${startField}`); return }
    let fname
    try { fname = readStr() } catch (e) { console.log(`${indent()}!!BAD NAME @ ${startField}: ${e.message}`); return }
    const valStart = p
    console.log(`${indent()}  ${TAG[t]} "${fname}" @ ${startField} val@${valStart}`)
    try { skipValue(t) } catch (e) { console.log(`${indent()}!!SKIP FAIL: ${e.message}`); return }
  }
}

try {
  const rootType = raw[p++]
  const rootName = readStr()
  console.log(`root type=${TAG[rootType]} name="${rootName}"`)
  parseCompound('root')
  console.log(`parsed up to ${p}/${raw.length} (trailing ${raw.length - p})`)
} catch (e) {
  console.log('CRASH at', p, e.message)
}
