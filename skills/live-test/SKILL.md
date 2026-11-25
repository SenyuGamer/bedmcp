---
name: live-test
description: Test a Minecraft Bedrock add-on change in the real game with the bedmcp tools. Use when the user asks to "test it in game", "check it in game", "reload", "try it", or to see how something looks or behaves in Minecraft. Picks the fastest cycle for what changed, reads the errors it produced, and adds bot players for multiplayer checks. Opening the game takes 1-2 minutes: use it ONLY when the user asks, or when the question truly cannot be answered from the code, JSON, logs or files.
---

# Live test loop (bedmcp)

**When to use it at all:** only when the user asked for an in-game test or look, or when a check truly cannot be done from the code, JSON, logs or files. After an ordinary code change, do not open the game on your own: say it was not tested in game and offer to test it.

bedmcp gives every Claude session its own pair: a real Minecraft Bedrock client (Be.D.D., in the background, its own slot) and its own test server (BDS + LeviLamina), with its own copy of the project's world. The project's packs are linked into every test server, so every build is live there. The project's files are never changed.

## First time in a project

1. `setup_check`: shows what bedmcp found (world, packs, build steps, variants) and how to fix anything missing. If something is missing, tell the user the fix it gives; do not guess.
2. `dev_cycle {build:false}`: starts the server and the client side by side and joins (~45 s; the very first run also makes the test server and clones the client, several minutes).

## Pick the variant (only if the project has them)

If `setup_check` lists variants (several games or maps in one repository), pass `variant` on the first `dev_cycle` or `server_start`; it stays for the session. Pick it from the task and the code you are changing; for shared code, ask the user which one to test. Switching restarts this session's server (~60-90 s).

## Pick the cycle by what changed

| Change | Do this | Time |
|---|---|---|
| Scripts only, while in the world | `build_packs`, then `server_command {command:"reload", scriptLogs:true}` | seconds |
| Resource pack, JSON UI, HUD, lang, textures | `dev_cycle {build:false}`: leaves the world and rejoins; nothing restarts | ~10 s |
| Scripts + resource pack | `dev_cycle {}`: builds, reloads the server, leaves and rejoins | ~10 s + build |
| Behavior pack JSON (entities, items, blocks, recipes) | `dev_cycle {restartServer:true}`: the server reads them only at start | ~60-90 s |
| Nothing running yet | `dev_cycle {build:false}` | ~45 s |

Do not restart the server or the client for resource pack work. If a change does not show after a fast cycle, `dev_cycle {build:false, restartClient:true}`. A failed join is retried by `dev_cycle` itself (client restart, then server restart).

Facts behind the table:
- The client loads the project's resource packs from disk (linked, nothing downloaded), and every join reloads them, so leave + rejoin shows RP changes.
- A new pack version (manifest `version`) changes the client's global pack list, read only at start: `dev_cycle` restarts the client by itself then.
- `reload` reloads scripts and functions only, not entity/item/block JSON.
- Every server start takes a fresh copy of the project's world. Map changes made on the test server are thrown away: edit the original world, then `server_stop` + `world_import` + `dev_cycle`.

## After every cycle

1. Read the `dev_cycle` output: step times, `server started with N error lines`, `server errors since join`.
2. `server_logs {filter:"ERROR|error|Exception|\\[Scripting\\].*(warn|error)", lines:80}` for script errors.
3. Look at the screenshot `dev_cycle` returns: in the world, custom UI drawn (raw `ui.xxx` keys or missing textures mean the RP did not apply).
4. A form that opens on join: `ui_read`, then `ui_click` its button, or `key ESC`.

## See and act

- See: `screenshot`, `ui_read` (the screen as text with element ids), `wait_for_screen`, `player_state`, `entities`.
- Act: `ui_click`, `ui_type`, `ui_scroll`, `move`, `look`, `teleport`, `interact_block`, `hotbar`, `mouse_button`, `key`, `client_chat`, `server_command` (as the server: `execute as <player> at @s run ...`).
- Prefer `ui_read` + `ui_click` over screenshots and pixel clicks: exact and cheap.

## Scenarios: sequence + world journal

To test something that happens over several actions (walk somewhere, hit a mob, open a shop, come back), prefer ONE `sequence` call over many single tools, and walk (`walk_to`) instead of teleporting when the way matters (zones, triggers, collisions).
- `sequence {closeScreens:true, track:["minecraft:zombie"], steps:[{walk_to:"minecraft:zombie", within:2.3}, {attack:{target:"minecraft:zombie", count:3}}, {screenshot:"after"}, {walk_to:[x,y,z]}, {tps:5}]}`.
- Check the result as data, not only images: each step lists its world events (`hurt` with damage, cause and attacker, `die`, `spawn`, `pickup`, `drop`, `effect`, `hit` ...), `tracked` positions, and the TPS; the summary has the server errors. A `hit` with no `hurt` means the game cancelled the damage.
- `walk_to` is a straight line (no path finding): if it reports `arrived:false`, split the way into points. A form that opens stops it unless `closeScreens`.
- Use `world_events {action:"start", track:[...]}` / `read {since, filter:"hurt|die"}` for things you do with other tools, and `profiler {action:"start"}` ... `{action:"stop"}` to find the scripts' hot spots.

## Debugging the scripts

When a bug's cause is not clear from logs and the journal, use the script debugger instead of adding console.log and rebuilding:
- `debug {action:"attach"}`, then `debug {action:"break", file:"<path to the .ts>", lines:[N]}` (TypeScript works when the build writes a source map), then make the code run (`sequence`, `bot`, `server_command`) and `debug {action:"wait"}`: you get the stack in .ts files and the local/closure variables.
- `debug {action:"eval", expression:"...", frameId:0}` evaluates in the stopped frame; `vars {ref}` expands objects; `next` / `step_in` / `step_out` / `continue`.
- A stop freezes the whole server: continue quickly (bedmcp continues by itself after `holdSec`, default 60). Clear breakpoints on hot code (`break {file, clear:true}`) before continuing, or it stops again on the next tick. `detach` when done.
- `debug {action:"stats"}` gives live engine numbers (memory, handle counts, subscribers per pack).

## Video (only when the user asks)

Record a video ONLY when the user asks for one (a video, a recording, a clip, "show me it moving"); screenshots are enough otherwise.
- `record {action:"clip", seconds:10}`: records and returns an MP4.
- `record {action:"start", seconds:60}`, then act (`move`, `ui_click`, `bot`, `dev_cycle` ...), then `record {action:"stop"}`: records what you do.
- `format:"gif"` for a small looping clip. About 28 fps, no sound; works with the window hidden and the monitor off.
- Give the file to the user (send it as a file when the chat can, else say its path).

## Second player: bots

Only one real client per session can join a server (all clients share one Microsoft account). For multiplayer logic, `bot` adds GameTest simulated players next to your client: to the scripts they are real `Player`s (they can be hit, die, carry items, chat, run commands).
- `bot {op:"spawn", name:"Rival"}` (next to your player), `move {target:"@client", wait:true}` (`mode:"straight"` when there is no path), `attack {target}`, `interact {target}`, `give {item}`, `use`, `chat`, `command {command:"tp @s ..."}`, `list`, `remove {name:"all"}`.
- They have no screen (no forms, HUD or client UI) and no player properties; entity taps may not raise `playerInteractWithEntity`. Code that relies on a join flow (e.g. a platform API's player state) may skip them and log errors for them.
- With `gamerule pvp false` a bot's hit on a player is refused (the reply says so).
- The world needs the Beta APIs experiment (`@minecraft/server-gametest` is beta only).

## Several sessions

Each Claude session has its own client and server (up to `maxClients`, default 3). The packs are shared: `build_packs` in one session changes the code every session runs on the same project folder. `server_sessions {name, activity}` shows your slot, your project and the other sessions; `setup_check` warns when another live session uses the same folder.

## Other folders and git worktrees

bedmcp reads its project folder once, when it starts (the folder the chat was opened in). If this session now works somewhere else (it changed folder, or works in a git worktree), pass `project:"<folder>"` to `setup_check`, `dev_cycle`, `build_packs` or `server_start`: it switches this session to that folder for the rest of the session (and stops this session's server, which served the old one). Every `dev_cycle` and `build_packs` result starts with the project it used: check it.
- To test a branch without touching another session's packs, use a git worktree: it has its own folder, so its own build output (`dist/` ...), and bedmcp treats it as its own project.
- A worktree usually has no `worlds/` (gitignored): bedmcp then copies the main worktree's world, read only, and `setup_check` says so. Copy a world into the worktree if the branch needs a different one.
- A project with other variants than the one bedmcp started in: restart the chat in that folder (the variant list is fixed at start).

## When done

`session_stop` closes this session's client and stops its server cleanly; closing the chat does the same. bedmcp never kills a server (a forced kill can corrupt the world); if `server_stop` times out, report it.

## Leave to the user

Say plainly which checks need the user, instead of claiming them:
- What a second real player sees on their screen (bots cover the server logic only).
- Feel and timing: movement, combat responsiveness, sounds, animation smoothness.
- Platform features: purchases, entitlements, online services, cross-server transfers.
- Load with many players.

## Rules

- Say which cycle you ran and what you saw (log lines, screenshot). When you did not test in game, say so plainly instead of claiming it works.
- Never edit the test servers' or clients' folders by hand: bedmcp manages them.
