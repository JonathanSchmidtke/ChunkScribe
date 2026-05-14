# ChunkScribe

A Minecraft 1.21.11 MITM proxy that downloads the world to Anvil format while you play.

You point your Minecraft client at this proxy, it authenticates outbound to the real server with your Microsoft account, and as chunks stream in for you to see, they're written to disk as a singleplayer-loadable save.

## Status

Early. The protocol/auth relay is the solid part. Save fidelity depends on the
versions of `prismarine-chunk` / `prismarine-provider-anvil` / `minecraft-data`
keeping up with Mojang releases — if 1.21.11 isn't yet supported in those
packages, lower `MC_VERSION` in `.env` to a release that is.

## Setup

```powershell
cd "$env:USERPROFILE\Documents\Minecraft\MCWD"
npm install
Copy-Item .env.example .env       # optional — defaults work for the GUI
npm run dev
```

A browser tab opens at `http://127.0.0.1:7878` with the ChunkScribe GUI:

1. Enter the **target server** address (e.g. `play.example.com`)
2. Press **Start**
3. The first time you connect, a **Microsoft device-code prompt** appears in
   the console. Open the URL on any device, type the 8-char code, approve.
   Subsequent runs use the cached token in `.auth/` (no prompt).
4. In Minecraft, **Multiplayer → Direct Connect → `127.0.0.1:25566`**
5. Walk/fly around. Captured chunks appear as green squares on the live map.

## Output

By default, downloaded worlds land in your Downloads folder, in a subfolder
named after the server you connected to:

```
%USERPROFILE%\Downloads\<server-host>\
├── level.dat
├── region\           (overworld)
├── DIM-1\region\     (nether, if visited)
├── DIM1\region\      (end, if visited)
└── dimensions\...    (datapack dimensions)
```

To drop straight into Minecraft's saves so it appears in singleplayer
immediately, set `OUTPUT_DIR` in `.env`:

```
OUTPUT_DIR=%APPDATA%\.minecraft\saves
```

## Settings

You can edit settings live in the GUI (Connection / Local proxy / Output
panels) and press Start. To set persistent defaults, put them in `.env`
(see [.env.example](.env.example)):

| Key | Default | Purpose |
| --- | --- | --- |
| `LISTEN_HOST` | `127.0.0.1` | Proxy bind host |
| `LISTEN_PORT` | `25566` | Port your MC client connects to |
| `TARGET_HOST` | — | Real server hostname (filled in GUI if blank) |
| `TARGET_PORT` | `25565` | Real server port |
| `MS_EMAIL` | — | Microsoft account hint (optional) |
| `MC_VERSION` | `1.21.11` | Protocol version, must match TARGET |
| `OUTPUT_DIR` | `~/Downloads` | Where worlds are written |
| `FLUSH_INTERVAL_SEC` | `30` | Periodic disk flush |
| `GUI_PORT` | `7878` | HTTP port the GUI binds |
| `NO_BROWSER` | — | `1` = don't auto-open browser |
| `AUTO_START` | — | `1` = launch proxy on startup with `.env` values |
| `DEBUG` | — | Verbose packet logs |

## How it works

1. **GUI** (Node HTTP + WebSocket on `127.0.0.1:7878`) serves a small SPA
   with a settings form, live chunk map (canvas), and log tail.
2. **Inbound listener** (`mc.createServer`, offline-mode) accepts your MC
   client in cleartext on `127.0.0.1:25566`.
3. **Outbound client** (`mc.createClient`, microsoft auth) connects to the
   real server, doing the encrypted handshake with your account's session.
4. Every packet is forwarded in both directions. Server→client packets are
   also passed through a capture pipeline that recognises:
   - configuration phase: `registry_data`, `feature_flags`
   - play phase: `level_chunk_with_light`, `block_update`,
     `section_blocks_update`, `block_entity_data`, `respawn`, `login`
5. Chunks are parsed via `prismarine-chunk` into the same column structure
   the vanilla save format uses, accumulated per-dimension in memory,
   and flushed to Anvil region files by `prismarine-provider-anvil`.
6. Each captured chunk also fires an event on an internal bus → the GUI
   WebSocket → live map.
7. On flush, a minimal `level.dat` is written so the save opens in
   singleplayer.

## What's captured

| Capture | How | Save target |
| --- | --- | --- |
| Chunks (terrain, blocks, biomes) | `level_chunk_with_light` | Anvil region/ |
| Block updates (single + section) | `block_update`, `section_blocks_update` | patched into captured chunks |
| Block entities (signs, banners, beacons…) | `block_entity_data` | chunk NBT |
| **Container inventories** (chests, barrels, shulkers, hoppers, brewing, furnaces) | client `use_item_on` → server `open_screen` → `window_items` → `close_window` | block entity NBT — **only captures containers you open** |
| **Entities** (mobs, item frames, paintings, item drops, armor stands, XP orbs) | `spawn_entity` + metadata + position/velocity/rotation/equipment updates | per-chunk Entities NBT (best effort across `prismarine-chunk` versions) |
| **World state** (spawn, time of day, raining, thundering, difficulty, world border) | `spawn_position`, `update_time`, `game_state_change`, `server_difficulty`, `world_border_*` | `level.dat` |
| Registries + dimension geometry | `registry_data` config phase | drives chunk parser + dimension subfolders |

## Known gaps

- **DataVersion in `level.dat`** is hardcoded ballpark; override with
  `MCWD_DATAVERSION` env if Minecraft complains.
- **Entity types** are stored by network numeric ID for now; only entities
  the protocol gives us a string ID for (`minecraft:painting`,
  `minecraft:experience_orb`) are written to NBT. Mob writeouts depend
  on `prismarine-chunk` exposing `addEntity` / `entities[]`.
- **Mob metadata** (custom names, baby flag, variant, etc.) is captured
  as a raw blob but not yet decoded into NBT fields per entity type.
- **Player data** (your own inventory, XP, last position) — not captured.
- **Filled maps** — not captured.
- **Light data** is loaded into chunks but Minecraft will recompute on
  first open.
- **Chunk batch acking** is left to minecraft-protocol's defaults; if you
  see the server slow chunk delivery to a crawl, that's the throttle.

## Legal

You are responsible for complying with the terms of service of the servers
you connect to. Many servers prohibit world ripping. This project does not
target any specific server.

## License

MIT
