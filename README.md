# bedmcp

Let Claude test your Minecraft Bedrock add-on **in the real game**.

bedmcp is an MCP server for Claude Code. It runs a real Minecraft Bedrock client in the background
(through [Be.D.D.](https://github.com/LiteLDev/BeDD)) and a local test server (Bedrock Dedicated
Server + [LeviLamina](https://github.com/LiteLDev/LeviLamina)). Claude can then:

- rebuild your packs, reload scripts and rejoin the world in about 10 s;
- read the screen as text, click menus and forms, type, take screenshots;
- move, look, use items and blocks, run server commands, read the logs;
- add bot players (GameTest simulated players) to test multiplayer logic with one client.

Each Claude session gets its own client, its own server and its own copy of your world, so several
chats can test at once. Your project's files and world are never changed.

It also ships a skill, `live-test`, that tells Claude which cycle to use for which change.

## Requirements

- **Windows 10/11** and **Node.js 22+**.
- **Minecraft Bedrock 1.26.60 (GDK)**, owned and signed in.
- **[LeviLauncher](https://github.com/LiteLDev/LeviLauncher) 1.1+**, with an instance of 1.26.60 that
  has **LeviLamina 26.60.x**. Start it once and sign in.
- **[Be.D.D.](https://github.com/LiteLDev/BeDD/releases) 0.4+**: run `bedd-windows-x64-setup.exe`.

bedmcp follows the game version Be.D.D. supports (1.26.60 for Be.D.D. 0.4). Disk: about 800 MB per
client clone and 600 MB per test server (one of each per parallel session).

## Install

As a Claude Code plugin (MCP server + skill):

```
/plugin marketplace add SenyuGamer/bedmcp
/plugin install bedmcp@bedmcp
```

Then restart Claude Code (or run `/reload-plugins`), open your add-on's folder and ask Claude to run
`setup_check`. It lists what bedmcp found and the fix for anything missing.

Or by hand, without the plugin:

```
git clone https://github.com/SenyuGamer/bedmcp
cd bedmcp
npm install
claude mcp add bedmcp --scope user -- node <path to bedmcp>\src\index.mjs
```

(Copy `skills/live-test` into your project's `.claude/skills/` to get the skill.)

## Your project

Open Claude Code in your add-on's folder. Without any config bedmcp looks for:

- **Packs**: every folder with a `manifest.json` up to 3 levels down (behavior packs: `data` or
  `script` modules; resource packs: `resources`).
- **World**: the only world folder in `worlds/`.

For anything else, add a `bedmcp.json` in the project root (see
[bedmcp.example.json](bedmcp.example.json)). Every key is optional:

| Key | What |
|---|---|
| `world` | the world to test in: a world folder (relative path), or a name in `worlds/` |
| `behaviorPacks`, `resourcePacks` | pack folders, if the search above does not find the right ones |
| `build` | build steps run by `build_packs` / `dev_cycle`: `[{ "cmd", "args", "cwd" }]` |
| `serverProperties` | `server.properties` keys for the test server (`gamemode`, `difficulty` ...) |
| `variants` | several games or maps in one repository (below) |

The world needs the **Beta APIs** experiment if your scripts (or the bots) use beta modules.

**BDS-style projects.** If the project folder is itself a server folder (`server.properties`,
`development_behavior_packs`, `development_resource_packs`, `worlds/`), bedmcp uses it as it is: its
world (`level-name`), its pack folders, its `config/` and its game settings. If you also run that
server by hand, bedmcp sees it and never copies or touches the world while it runs.

**Variants.** One repository with several games, each with its own world and settings:

```json
"variants": {
  "lobby": { "label": "Lobby", "hint": "lobby map, code in src/lobby", "world": "worlds/Lobby" },
  "arena": { "label": "Arena", "world": "worlds/Arena",
             "properties": { "view-distance": "8" },
             "config": { "default/variables.json": { "mode": "ARENA" } } }
}
```

Claude passes `variant` on its first `dev_cycle`; only that session's test server is set up for it
(`properties` go to its `server.properties`, `config` JSON is merged over the project's `config/`).

## Machine settings

Optional, in `%USERPROFILE%\.bedmcp\config.json` (`BEDMCP_HOME` moves the folder; `BEDMCP_CONFIG`
points to one file instead):

| Key | Default |
|---|---|
| `bedd` | `%LOCALAPPDATA%\Programs\BeDD\BeDD.exe` |
| `beddHome` | `%USERPROFILE%\.bedd` (Be.D.D.'s data: clones, servers) |
| `stateDir` | `%USERPROFILE%\.bedd\bedmcp` (sessions, locks, world backups) |
| `maxClients` | `3` parallel sessions |
| `server` | `{ "name": "bedmcp", "port": 19140 }`; slot N uses `bedmcp-N` and port 19140 + 2(N-1) |
| `hotMod` | `true` (BedmcpHot, below) |
| `bots` | `true` (the bot pack) |
| `projects` | `{ "<folder>": { ...bedmcp.json keys } }`, for projects you can't add a file to |

## Tools

- Setup: `setup_check`, `server_sessions`
- Loop: `dev_cycle` (build, reload, leave, rejoin, screenshot)
- Server: `server_start`, `server_stop`, `server_restart`, `server_command`, `server_logs`, `build_packs`, `world_import`
- Client: `game_launch`, `game_stop`, `game_status`, `game_join`, `game_leave`, `session_stop`, `pack_sync`
- See: `screenshot`, `ui_read`, `wait_for_screen`, `player_state`, `entities`
- Act: `ui_click`, `ui_type`, `ui_scroll`, `interact_block`, `teleport`, `look`, `move`, `hotbar`, `mouse_button`, `game_action`, `key`, `type_text`, `mouse`, `client_chat`, `release_input`
- Multiplayer: `bot`
- Anything else: `bedd_call` (a raw Be.D.D. WebSocket op)

## How it works

- **One client and one server per session.** Every client clone signs in with the same Microsoft
  account, and a server that already had one clone of that account refuses another one. So each
  session (each Claude chat) claims a slot: client clone `<version>-N` and server `bedmcp-N`.
- **Test servers.** The first is made with `BeDD.exe server init` on first use (BDS + LeviLamina +
  Be.D.D.'s server module, several minutes); the others are copies of it. bedmcp's
  [server.properties](server.properties) is applied on top (offline mode, NetherNet on 127.0.0.1).
  Servers run under Be.D.D., so they outlive the MCP; bedmcp stops them only with `stop` and never
  kills one (that can corrupt a world).
- **Your packs** are linked (junctions), never copied: every build is live on every test server. In
  a non-BDS project they are linked one by one and turned on in the world copy.
- **Your world** is copied fresh at every server start; the old copy is backed up to
  `stateDir\backups` (newest 10 per server).
- **The client loads your resource packs from disk** (a link in the clone, listed as a global pack),
  so a join downloads nothing and every rejoin reloads them: an RP change is a leave + rejoin.
- **Bots** are bedmcp's own behavior pack (`botpack/`), added to the test server's world copy only.
  Requests go through `/scriptevent bedmcp:bot`; the reply comes back as the output of the pack's
  custom command `/bedmcp:botreply`.

### BedmcpHot

`mod/` is a small LeviLamina client mod that bedmcp installs into every clone. A leave + rejoin
normally runs two full resource reloads: the title screen's packs on leave, the world's on join. The
mod skips the first one, so a rejoin takes ~8 s instead of ~12 s. `"hotMod": false` turns it off.

The built mod is in `mod/bin`. To build it (LLVM 22 on PATH, [xmake](https://xmake.io); the link step
stores only the `.pdb` file name in the DLL, `/PDBALTPATH:%_PDB%`, so no build-machine path ships):

```
cd mod
xmake f -y -m release -p windows -a x64
xmake -y
```

## Limits

- Windows only, and one game version at a time (Be.D.D.'s).
- Bots have no screen (no forms, HUD), no player properties, and their entity taps may not raise
  `playerInteractWithEntity`. They cover server logic, not what a second player sees.
- One client per session: two real players on one server need two Microsoft accounts.

## Development

```
node scripts/try.mjs                                  # list the tools
set BEDMCP_DAEMON_PORT=7788 && node scripts/daemon.mjs   # one session; POST http://127.0.0.1:7788/<tool> with JSON
curl -X POST http://127.0.0.1:7788/quit               # end it: closes its client, stops its server
```

## License

MIT ([LICENSE](LICENSE)). The built client mod contains header code of LeviLamina (LGPL-3.0),
nlohmann/json and EnTT (MIT): see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Credits

Built on [Be.D.D.](https://github.com/LiteLDev/BeDD), [LeviLamina](https://github.com/LiteLDev/LeviLamina)
and [LeviLauncher](https://github.com/LiteLDev/LeviLauncher) by LiteLDev. Not affiliated with Mojang or Microsoft.
