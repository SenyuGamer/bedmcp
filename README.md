# bedmcp

Let Claude test your Minecraft Bedrock add-on **in the real game**.

bedmcp is an MCP server for Claude Code. It runs a real Minecraft Bedrock client in the background
(through [Be.D.D.](https://github.com/LiteLDev/BeDD)) and a local test server (Bedrock Dedicated
Server + [LeviLamina](https://github.com/LiteLDev/LeviLamina)). Claude can then:

- rebuild your packs, reload scripts and rejoin the world in about 10 s;
- read the screen as text, click menus and forms, type, take screenshots;
- move, look, use items and blocks, run server commands, read the logs;
- add bot players (GameTest simulated players) to test multiplayer logic with one client;
- run a whole scenario in one call (walk to A, hit a mob, walk to B, read a form ...) while a
  journal records what happens in the world (spawns, damage, deaths, items, positions, TPS);
- profile the scripts and record videos of the game.

Each Claude session gets its own client, its own server and its own copy of your world, so several
chats can test at once. Your project's files and world are never changed.

It also ships a skill, `live-test`, that tells Claude which cycle to use for which change.

## Requirements

- **Windows 10/11** and **Node.js 22+**.
- Optional: **[ffmpeg](https://ffmpeg.org)** on PATH for video recording (`winget install Gyan.FFmpeg`).
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
             "config": { "default/variables.json": { "mode": "ARENA" } },
             "resourcePacks": ["packs/ArenaRP"] }
}
```

Claude passes `variant` on its first `dev_cycle`; only that session's test server is set up for it
(`properties` go to its `server.properties`, `config` JSON is merged over the project's `config/`,
`resourcePacks` are linked into the client and put on top of that world copy's resource pack stack).

**Other folders and git worktrees.** bedmcp reads the project folder once, when the chat starts.
A session that moves to another folder (or works in a git worktree) passes `project:"<folder>"`
to `setup_check`, `dev_cycle`, `build_packs` or `server_start`; it stays for the session. A
worktree is its own project, with its own build output, so a branch can be tested without
touching the packs another session uses. When the worktree has no `worlds/` (gitignored), the
main worktree's world is copied. `setup_check` warns when another live session uses the same
project folder, and when the client reports that the session works in a different folder.

## Machine settings

Optional, in `%USERPROFILE%\.bedmcp\config.json` (`BEDMCP_HOME` moves the folder; `BEDMCP_CONFIG`
points to one file instead):

| Key | Default |
|---|---|
| `bedd` | `%LOCALAPPDATA%\Programs\BeDD\BeDD.exe` |
| `beddHome` | `%USERPROFILE%\.bedd` (Be.D.D.'s data: clones, servers) |
| `stateDir` | `%USERPROFILE%\.bedd\bedmcp` (sessions, locks, world backups) |
| `maxClients` | `3` parallel sessions |
| `slotIdleMinutes` | `60`: a session idle this long with no client running loses its slot to a session that needs one (chats left open in the background keep their MCP alive) |
| `server` | `{ "name": "bedmcp", "port": 19140 }`; slot N uses `bedmcp-N` and port 19140 + 2(N-1) |
| `hotMod` | `true` (BedmcpHot, below) |
| `bots` | `true` (the bot pack) |
| `ffmpeg` | `ffmpeg` on PATH (for `record`) |
| `recordDir` | `stateDir\recordings` |
| `projects` | `{ "<folder>": { ...bedmcp.json keys } }`, for projects you can't add a file to |

## Tools

- Setup: `setup_check`, `server_sessions`
- Loop: `dev_cycle` (build, reload, leave, rejoin, screenshot)
- Scenarios: `sequence` (many steps in one call), `walk_to` (walk like a player, no teleport)
- World as data: `world_events` (journal of spawns, damage, deaths, items, positions, TPS), `profiler` (script CPU profile)
- Code: `debug` (script debugger: breakpoints in TypeScript, stack, variables, eval, live engine stats)
- Server: `server_start`, `server_stop`, `server_restart`, `server_command`, `server_logs`, `build_packs`, `world_import`
- Client: `game_launch`, `game_stop`, `game_status`, `game_join`, `game_leave`, `session_stop`, `pack_sync`
- See: `screenshot`, `record` (MP4/GIF video), `ui_read`, `wait_for_screen`, `player_state`, `entities`
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

### Sequences and the world journal

`sequence` runs a list of steps in one call, e.g.

```json
{ "record": true, "closeScreens": true, "track": ["minecraft:pig", "Rival"], "steps": [
  { "bot": { "op": "spawn", "name": "Rival" } },
  { "walk_to": "minecraft:pig", "within": 2.3 },
  { "attack": { "target": "minecraft:pig", "count": 3 } },
  { "screenshot": "after the hits" },
  { "walk_to": [36.5, 101, -6.5], "sprint": true },
  { "look_at": "Rival" },
  { "tps": 5 }
]}
```

Steps: `walk_to`, `look_at`, `look`, `attack`, `use`, `wait`, `screenshot`, `ui_read`, `ui_click`,
`key`, `command`, `chat`, `bot`, `hotbar`, `jump`, `move`, `tps`. Targets are `[x, y, z]`, a player or
bot name, an entity id, or a type (the nearest). `walk_to` turns toward the target and holds forward
(jumping small steps, slowing down near the end); it is a straight line, not path finding, and it
reports a form or menu that takes the input (`closeScreens` presses ESC on them). `attack` is a real
left click at the crosshair.

While a sequence runs, bedmcp's pack keeps a journal of the world from the Script API events (spawn,
remove, die, hurt with cause and attacker, hit, pickup, drop, effect, entity triggers, join/leave,
block break/place/interact, item use, chat, scriptevent), the positions of `track`ed entities and the
TPS. Each step returns the events that happened during it; the end gives the TPS and tick times over
the run, the server's errors, and the video. `world_events` uses the same journal by hand.

`profiler` runs BDS's script profiler (`script profiler start|stop`) and lists the functions that took
the most CPU time (the runtime's own scheduler is marked idle).

### Script debugger

`debug` speaks the protocol of Mojang's "Minecraft Bedrock Debugger" for VS Code. bedmcp listens on
loopback and the test server connects to it (`script debugger connect`; bedmcp's server.properties
turns on `allow-outbound-script-debugging`). The server's own `listen` mode accepts a socket on this
BDS but never answers it, so it stays off.

```
debug {action:"attach"}                                   # the project's pack with a source map
debug {action:"break", file:"src/foo.ts", lines:[120]}     # TypeScript, mapped through the .js.map
debug {action:"wait", timeoutSec:30}                      # stack (in .ts) + the top frame's variables
debug {action:"eval", expression:"player.name", frameId:0}
debug {action:"continue"}  /  next / step_in / step_out
debug {action:"stats"}     /  logs / detach
```

A stopped script holds the whole server tick, so bedmcp continues by itself after `holdSec`
(default 60). The debugger works on one pack per session: a breakpoint in another pack re-attaches
to that pack.

### Video

`record` captures the game's own frames through Be.D.D. (no screen capture), so it works with the
window hidden and the monitor off: about 28 fps captured at 1024 px, encoded by ffmpeg to MP4 (H.264)
or GIF, no sound. `clip` records N seconds; `start`/`stop` records while Claude acts with other tools.
The Windows session must be unlocked: on a locked PC (lock screen, or a remote session that left it
locked) Windows throttles the game to ~1-2 fps. Screenshots still work then, so `record` checks for
the lock screen and warns, and warns on any capture under 10 fps.
The skill tells Claude to record only when the user asks for a video.

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
