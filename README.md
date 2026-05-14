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
Copy-Item .env.example .env
# edit .env: at minimum TARGET_HOST and TARGET_PORT
npm run dev
```

First run will pop a Microsoft device-code prompt in the console. Sign in with
the account that owns Minecraft. Tokens cache to `.auth/`.

In Minecraft (the same version you set in `MC_VERSION`):

- Multiplayer → Direct Connect → `127.0.0.1:25566`
- Play normally. Walk/fly around to load chunks. Each loaded chunk is captured.

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

All in `.env` (see `.env.example`):

| Key | Default | Purpose |
| --- | --- | --- |
| `LISTEN_HOST` | `127.0.0.1` | Proxy bind host |
| `LISTEN_PORT` | `25566` | Port your MC client connects to |
| `TARGET_HOST` | — | Real server hostname |
| `TARGET_PORT` | `25565` | Real server port |
| `MS_EMAIL` | — | Microsoft account hint (optional) |
| `MC_VERSION` | `1.21.11` | Protocol version, must match TARGET |
| `OUTPUT_DIR` | `~/Downloads` | Where worlds are written |
| `FLUSH_INTERVAL_SEC` | `30` | Periodic disk flush |
| `DEBUG` | — | Set to anything for verbose packet logs |

## How it works

1. **Inbound listener** (`mc.createServer`, offline-mode) accepts your client
   in cleartext.
2. **Outbound client** (`mc.createClient`, microsoft auth) connects to the
   real server, doing the encrypted handshake with your account's session.
3. Every packet is forwarded in both directions. Server→client packets are
   also passed through a capture pipeline that recognises:
   - configuration phase: `registry_data`, `feature_flags`
   - play phase: `level_chunk_with_light`, `block_update`,
     `section_blocks_update`, `block_entity_data`, `respawn`, `login`
4. Chunks are parsed via `prismarine-chunk` into the same column structure
   the vanilla save format uses, accumulated per-dimension in memory, and
   flushed to Anvil region files by `prismarine-provider-anvil`.
5. On flush, a minimal `level.dat` is written so the save opens in
   singleplayer.

## Known gaps

- **DataVersion in `level.dat`** is hardcoded ballpark; override with
  `MCWD_DATAVERSION` env if Minecraft complains.
- **Entities/players** are not captured (they're not part of the chunk
  packet stream you'd expect for "world download" — they're per-entity
  packets and would need a separate pipeline).
- **Light data** is loaded into chunks but Minecraft will recompute on
  first open.
- **Chunk batch acking** is left to minecraft-protocol's defaults; if you
  see the server slow chunk delivery to a crawl, that's the throttle.
- **No GUI.** Console only.

## Legal

You are responsible for complying with the terms of service of the servers
you connect to. Many servers prohibit world ripping. This project does not
target any specific server.

## License

MIT
