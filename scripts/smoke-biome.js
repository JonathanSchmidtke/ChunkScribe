#!/usr/bin/env node
// Smoke test: simulate a server biome registry that's NOT alphabetical
// (server-ordered indices ≠ vanilla-ordered indices), apply the v0.9.17
// patch, then verify the writer's ID→name lookup gives the right name.

const RegistryFactory = require('prismarine-registry')
const reg = RegistryFactory('1.21.11')

console.log('Before patch — vanilla biome indexing:')
console.log(`  reg.biomes[28]?.name      = ${reg.biomes[28]?.name}   (vanilla alphabetical)`)
console.log(`  reg.biomesArray[28]?.name = ${reg.biomesArray[28]?.name}`)
console.log()

// Simulate Gridlock's server-ordered biome list. Put jungle at server-index
// 5 (NOT vanilla's 28). Anything other than vanilla's alphabetical order
// reveals whether our patch works.
const serverOrdered = [
  'minecraft:plains',          // server index 0
  'minecraft:nether_wastes',   // 1
  'minecraft:the_end',         // 2
  'minecraft:badlands',        // 3
  'minecraft:basalt_deltas',   // 4
  'minecraft:jungle',          // 5  ← jungle at index 5 (vanilla has it at 28)
  'gridlock:custom_jungle',    // 6  ← a custom biome
]

// Mirror the patch logic from ChunkCapture.patchBiomeRegistry
const vanillaByName = reg.biomesByName
const patched = []
for (let i = 0; i < serverOrdered.length; i++) {
  const bare = serverOrdered[i].replace(/^minecraft:/, '')
  const hit = vanillaByName[bare]
  if (hit) {
    patched[i] = { ...hit, id: i }
  } else {
    patched[i] = { ...vanillaByName.plains, id: i, _origName: serverOrdered[i] }
  }
}

reg.biomesArray = patched
const newBiomesById = {}
for (let i = 0; i < patched.length; i++) newBiomesById[i] = patched[i]
reg.biomes = newBiomesById

console.log('After patch — server-ordered indexing:')
for (let i = 0; i < serverOrdered.length; i++) {
  const writerLookup = 'minecraft:' + reg.biomes[i]?.name
  const expectedName = serverOrdered[i].startsWith('gridlock:') ? 'minecraft:plains' : serverOrdered[i]
  const ok = writerLookup === expectedName ? 'OK ' : 'FAIL'
  console.log(`  [${i}] writer would emit "${writerLookup}"  expected="${expectedName}"  ${ok}`)
}
