const fs = require('node:fs')
const zlib = require('node:zlib')
const nbt = require('prismarine-nbt')

const buf = fs.readFileSync(process.argv[2])
const raw = buf[0] === 0x1f ? zlib.gunzipSync(buf) : buf
const tag = nbt.parseUncompressed(raw, 'big')
const data = tag.value.Data.value

console.log('LevelName:', data.LevelName?.value)
console.log('SpawnX:', data.SpawnX?.value, 'SpawnY:', data.SpawnY?.value, 'SpawnZ:', data.SpawnZ?.value)
console.log('Player.Dimension:', data.Player?.value?.Dimension?.value)
console.log('Player.Pos:', JSON.stringify(data.Player?.value?.Pos?.value?.value))

const dims = data.WorldGenSettings?.value?.dimensions?.value || {}
console.log('--- WGS dims ---')
for (const [k, v] of Object.entries(dims)) {
  const t = v.value?.type?.value
  const g = v.value?.generator?.value?.type?.value
  console.log(`  ${k}  type=${t}  gen=${g}`)
}
