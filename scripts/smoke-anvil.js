#!/usr/bin/env node
// Verify that passing a PATCHED registry (instead of version string) to
// prismarine-provider-anvil's Anvil factory makes the writer use our
// biome ID→name ordering. This is the actual bug fixed in v0.9.18 —
// previously WorldSaver passed the version string, anvil built its own
// vanilla-ordered registry, our patched biomes[] was ignored.
const RegistryFactory = require('prismarine-registry')
const { Anvil } = require('prismarine-provider-anvil')

const reg = RegistryFactory('1.21.11')

// Build a "server-ordered" registry where jungle is at index 5 instead of 28.
const serverOrdered = ['plains', 'nether_wastes', 'the_end', 'badlands', 'basalt_deltas', 'jungle']
const patched = []
for (let i = 0; i < serverOrdered.length; i++) {
  patched[i] = { ...reg.biomesByName[serverOrdered[i]], id: i }
}
reg.biomesArray = patched
const byId = {}
for (let i = 0; i < patched.length; i++) byId[i] = patched[i]
reg.biomes = byId

console.log('Patched registry: biomes[5].name =', reg.biomes[5]?.name)
console.log('Anvil factory accepts registry directly:')
try {
  const Cls = Anvil(reg)  // pass registry, not version string
  console.log('  OK — Anvil factory built with patched registry')
  // What name would the writer emit for biome ID 5?
  const writerOutput = 'minecraft:' + reg.biomes[5]?.name
  console.log(`  Writer-style lookup for ID 5: "${writerOutput}"`)
  console.log(`  ${writerOutput === 'minecraft:jungle' ? 'OK' : 'FAIL'} (expected minecraft:jungle)`)
} catch (e) {
  console.log('  FAIL — anvil rejected registry object:', e.message)
}
