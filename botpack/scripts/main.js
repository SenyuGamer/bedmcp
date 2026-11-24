// bedmcp bots: simulated players (GameTest) that bedmcp drives through
// `/scriptevent bedmcp:bot {"id":"..","op":"..",...}`. Every request gets one reply line in the
// command output of `/bedmcp:botreply <id>` (bedmcp polls it; "pending" until the op ends), and also a
// server log line `BEDMCPBOT#<id> <json>`. The log is a fallback only: LeviLamina buffers latest.log,
// so a line can show up seconds late on a quiet server.
// This pack is bedmcp's, installed only into its test servers' world copies (never the project).
import { world, system, ItemStack, GameMode, Direction, CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus } from '@minecraft/server';
import { spawnSimulatedPlayer, SimulatedPlayer, LookDuration } from '@minecraft/server-gametest';

const VERSION = 2;
const bots = new Map(); // name -> SimulatedPlayer

const replies = new Map(); // id -> { tick, text }, taken by /bedmcp:botreply
function reply(id, body) {
    const text = JSON.stringify(body);
    replies.set(id, { tick: system.currentTick, text });
    for (const [k, v] of replies) if (system.currentTick - v.tick > 20 * 120) replies.delete(k);
    // The log copy is a fallback for small replies only (journal reads would flood the log).
    if (text.length < 1500) console.log(`BEDMCPBOT#${id} ${text}`);
}
system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
    customCommandRegistry.registerCommand(
        { name: 'bedmcp:botreply', description: 'bedmcp: the reply to a bot request', permissionLevel: CommandPermissionLevel.Admin, mandatoryParameters: [{ name: 'id', type: CustomCommandParamType.String }] },
        (_origin, id) => {
            const r = replies.get(id);
            if (!r) return { status: CustomCommandStatus.Failure, message: 'pending' };
            replies.delete(id);
            return { status: CustomCommandStatus.Success, message: r.text };
        },
    );
});
const ticks = (n) => new Promise((r) => system.runTimeout(r, Math.max(1, n)));
const r2 = (n) => Math.round(n * 100) / 100;
const v3 = (v) => ({ x: r2(v.x), y: r2(v.y), z: r2(v.z) });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// Simulated players that outlived a script reload are still in the world: take them back.
function adopt() {
    for (const p of world.getAllPlayers()) if (p instanceof SimulatedPlayer && !bots.has(p.name)) bots.set(p.name, p);
    for (const [name, b] of bots) if (!b.isValid) bots.delete(name);
}
const isBot = (e) => e instanceof SimulatedPlayer || [...bots.values()].some((b) => b.isValid && b.id === e.id);
const realPlayers = () => world.getAllPlayers().filter((p) => !isBot(p));

function bot(name) {
    adopt();
    if (!name) {
        if (bots.size === 1) return [...bots.values()][0];
        throw new Error(bots.size ? `say which bot (name): ${[...bots.keys()].join(', ')}` : 'no bots: spawn one first');
    }
    const b = bots.get(name);
    if (!b?.isValid) throw new Error(`no bot "${name}"${bots.size ? ` (bots: ${[...bots.keys()].join(', ')})` : ''}`);
    return b;
}

function nearestTo(from, list) {
    let best, bd = Infinity;
    for (const e of list) {
        try { if (e.dimension.id !== from.dimension.id) continue; const d = dist(e.location, from.location); if (d < bd) { bd = d; best = e; } } catch {}
    }
    return best;
}

// A target: "@client" / omitted (the nearest real player), a player or bot name, an entity id, or
// an entity type ("minecraft:zombie", nearest one within 64 blocks).
function entity(t, from) {
    if (!t || t === '@client') {
        const p = from ? nearestTo(from, realPlayers()) : realPlayers()[0];
        if (!p) throw new Error('no real player online');
        return p;
    }
    if (/^-?\d+$/.test(t)) { const e = world.getEntity(t); if (!e?.isValid) throw new Error(`no entity with id ${t}`); return e; }
    if (t.includes(':')) {
        if (!from) throw new Error('a type target needs a bot to measure from');
        const e = nearestTo(from, from.dimension.getEntities({ type: t, location: from.location, maxDistance: 64 }).filter((x) => x.id !== from.id));
        if (!e) throw new Error(`no ${t} within 64 blocks of ${from.name}`);
        return e;
    }
    const p = world.getAllPlayers().find((x) => x.name === t) ?? bots.get(t);
    if (!p?.isValid) throw new Error(`no player "${t}" online`);
    return p;
}

// A position: [x, y, z], {x, y, z}, or a target (its location).
function pos(at, from) {
    if (Array.isArray(at)) return { x: +at[0], y: +at[1], z: +at[2] };
    if (at && typeof at === 'object') return { x: +at.x, y: +at.y, z: +at.z };
    if (typeof at === 'string') return entity(at, from).location;
    throw new Error('missing position (at: [x, y, z] or a target)');
}
const block = (at, from) => { const p = pos(at, from); return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }; };

const FACES = { down: Direction.Down, up: Direction.Up, north: Direction.North, south: Direction.South, west: Direction.West, east: Direction.East };
const face = (f) => (f ? FACES[String(f).toLowerCase()] ?? (() => { throw new Error(`face: ${Object.keys(FACES).join('|')}`); })() : undefined);
const MODES = { survival: GameMode.Survival, creative: GameMode.Creative, adventure: GameMode.Adventure, spectator: GameMode.Spectator };

function itemOf(e) {
    try { const inv = e.getComponent('minecraft:inventory')?.container; const it = inv?.getItem(e.selectedSlotIndex); return it ? `${it.typeId}x${it.amount}` : null; } catch { return null; }
}
function hp(e) { try { const h = e.getComponent('minecraft:health'); return h ? `${r2(h.currentValue)}/${r2(h.effectiveMax)}` : null; } catch { return null; } }

function state(b) {
    const s = { name: b.name, id: b.id, dimension: b.dimension.id.replace('minecraft:', ''), at: v3(b.location), rot: { pitch: r2(b.getRotation().x), yaw: r2(b.getRotation().y) }, health: hp(b) };
    try { s.gameMode = b.getGameMode(); } catch {}
    try { s.slot = b.selectedSlotIndex; s.item = itemOf(b); } catch {}
    try { s.sneaking = b.isSneaking; s.sprinting = b.isSprinting; } catch {}
    try { const tags = b.getTags(); if (tags.length) s.tags = tags; } catch {}
    return s;
}
const other = (e) => ({ name: e.name ?? e.nameTag ?? undefined, type: e.typeId, id: e.id, at: v3(e.location), health: hp(e) });

function missNote(b, e) {
    if (!e?.isValid) return 'no hit: the target is gone';
    if (dist(e.location, b.location) > 3.5) return 'no hit: melee reach is about 3 blocks (move closer first)';
    let pvp = true;
    try { pvp = world.gameRules.pvp; } catch {}
    if (e.typeId === 'minecraft:player' && !pvp) return 'no hit: gamerule pvp is false in this world';
    return 'no hit: the game refused it (game mode, protection, or the project scripts cancelled it)';
}

const ops = {
    ping: () => { adopt(); return { version: VERSION, bots: [...bots.keys()], players: world.getAllPlayers().map((p) => p.name) }; },
    list: () => { adopt(); return { bots: [...bots.values()].map(state), players: realPlayers().map(other) }; },

    async spawn(q) {
        adopt();
        const name = q.name || `Bot${bots.size + 1}`;
        if (bots.get(name)?.isValid) throw new Error(`a bot named "${name}" exists`);
        if (world.getAllPlayers().some((p) => p.name === name)) throw new Error(`a player named "${name}" is online`);
        let dimension, location;
        if (q.at !== undefined) {
            dimension = world.getDimension(q.dimension ?? 'overworld');
            location = pos(q.at);
        } else {
            const p = realPlayers()[0];
            if (p) { dimension = p.dimension; location = { x: p.location.x + 2, y: p.location.y, z: p.location.z }; }
            else { dimension = world.getDimension('overworld'); const s = world.getDefaultSpawnLocation(); location = { x: s.x + 0.5, y: s.y > 320 ? 100 : s.y, z: s.z + 0.5 }; }
        }
        const mode = MODES[String(q.gameMode ?? 'survival').toLowerCase()];
        if (mode === undefined) throw new Error(`gameMode: ${Object.keys(MODES).join('|')}`);
        const b = spawnSimulatedPlayer({ dimension, ...location }, name, mode);
        b.addTag('bedmcp_bot');
        bots.set(name, b);
        await ticks(q.waitTicks ?? 20);
        return { spawned: state(b) };
    },

    async remove(q) {
        adopt();
        const names = !q.name || q.name === 'all' ? [...bots.keys()] : [q.name];
        const gone = [];
        for (const n of names) {
            const b = bots.get(n);
            if (b?.isValid) { b.disconnect(); gone.push(n); }
            else if (world.getAllPlayers().some((p) => p.name === n)) { world.getDimension('overworld').runCommand(`kick "${n}"`); gone.push(n); }
            bots.delete(n);
        }
        return { removed: gone };
    },

    async move(q) {
        const b = bot(q.name), speed = q.speed ?? 1;
        const mode = q.mode ?? 'navigate';
        let to, nav;
        if (mode === 'relative') {
            const [lr, fb] = q.dir ?? [0, 1];
            b.moveRelative(lr, fb, speed);
        } else {
            to = pos(q.at ?? q.target, b);
            if (mode === 'navigate') { const r = b.navigateToLocation(to, speed); nav = { isFullPath: r?.isFullPath, pathLength: r?.path?.length }; }
            else if (mode === 'straight') b.moveToLocation(to, { speed, faceTarget: true });
            else throw new Error('mode: navigate|straight|relative');
        }
        if (nav && !nav.isFullPath) nav.note = 'no full path there: it walks the partial path; mode "straight" walks in a line';
        if (!q.wait || !to) return { moving: true, nav, bot: state(b) };
        const end = system.currentTick + Math.round((q.timeoutSec ?? 20) * 20);
        while (system.currentTick < end && b.isValid && dist(b.location, to) > (q.within ?? 1.5)) await ticks(5);
        const arrived = b.isValid && dist(b.location, to) <= (q.within ?? 1.5);
        if (q.stopOnArrive !== false) try { b.stopMoving(); } catch {}
        return { arrived, distance: r2(dist(b.location, to)), nav, bot: state(b) };
    },

    stop(q) {
        const b = bot(q.name);
        for (const f of ['stopMoving', 'stopUsingItem', 'stopBreakingBlock', 'stopInteracting', 'stopBuild']) try { b[f](); } catch {}
        return { bot: state(b) };
    },

    look(q) {
        const b = bot(q.name);
        const d = LookDuration[q.duration ?? 'Instant'] ?? LookDuration.Instant;
        if (q.target && !Array.isArray(q.target)) b.lookAtEntity(entity(q.target, b), d);
        else b.lookAtLocation(pos(q.at ?? q.target, b), d);
        return { bot: state(b) };
    },

    async attack(q) {
        const b = bot(q.name);
        const times = Math.max(1, q.count ?? 1);
        let hits = 0, e = null;
        for (let i = 0; i < times; i++) {
            if (q.target) {
                e = entity(q.target, b);
                if (!e.isValid) break;
                b.lookAtEntity(e, LookDuration.Instant);
                if (b.attackEntity(e)) hits++;
            } else if (b.attack()) hits++;
            if (i < times - 1) await ticks(q.gapTicks ?? 10);
        }
        await ticks(2);
        return { hits, of: times, distance: e?.isValid ? r2(dist(e.location, b.location)) : undefined, note: q.target && !hits ? missNote(b, e) : undefined, target: e?.isValid ? other(e) : e ? 'gone (died or left)' : null, bot: state(b) };
    },

    async interact(q) {
        const b = bot(q.name);
        let ok;
        if (q.at !== undefined) ok = b.interactWithBlock(block(q.at, b), face(q.face));
        else if (q.target) { const e = entity(q.target, b); b.lookAtEntity(e, LookDuration.Instant); ok = b.interactWithEntity(e); }
        else ok = b.interact();
        await ticks(2);
        return { ok, bot: state(b) };
    },

    async use(q) {
        const b = bot(q.name);
        const slot = q.slot ?? b.selectedSlotIndex;
        const ok = q.at !== undefined ? b.useItemInSlotOnBlock(slot, block(q.at, b), face(q.face)) : b.useItemInSlot(slot);
        if (q.holdTicks) { await ticks(q.holdTicks); try { b.stopUsingItem(); } catch {} }
        await ticks(2);
        return { ok, bot: state(b) };
    },

    give(q) {
        const b = bot(q.name);
        if (!q.item) throw new Error('item (e.g. minecraft:diamond_sword)');
        const stack = new ItemStack(q.item, q.count ?? 1);
        const ok = q.slot !== undefined ? b.setItem(stack, q.slot, true) : b.giveItem(stack, true);
        return { ok, bot: state(b) };
    },

    hotbar(q) { const b = bot(q.name); b.selectedSlotIndex = q.slot ?? 0; return { bot: state(b) }; },
    chat(q) { const b = bot(q.name); b.chat(String(q.message ?? '')); return { bot: state(b) }; },
    async jump(q) { const b = bot(q.name); const ok = b.jump(); await ticks(2); return { ok, bot: state(b) }; },
    sneak(q) { const b = bot(q.name); b.isSneaking = q.on !== false; return { bot: state(b) }; },
    sprint(q) { const b = bot(q.name); b.isSprinting = q.on !== false; return { bot: state(b) }; },
    async break(q) { const b = bot(q.name); const ok = b.breakBlock(block(q.at, b), face(q.face)); await ticks(q.holdTicks ?? 2); return { ok, bot: state(b) }; },
    async respawn(q) { const b = bot(q.name); const ok = b.respawn(); await ticks(10); return { ok, bot: state(b) }; },
    // Runs a command as the bot (execute as), e.g. "tp @s 0 100 0" or "give @s apple".
    command(q) {
        const b = bot(q.name);
        const r = b.runCommand(String(q.command ?? '').replace(/^\//, ''));
        return { successCount: r.successCount, bot: state(b) };
    },

    // Where an entity is: feet and eyes (for walking to it and aiming at it).
    locate(q) {
        const e = entity(q.target, q.from ? entity(q.from) : realPlayers()[0]);
        let eye = e.location;
        try { eye = e.getHeadLocation(); } catch {}
        return { ...other(e), dimension: e.dimension.id.replace('minecraft:', ''), eye: v3(eye) };
    },

    // --- world journal: what happens in the world, as events, read back by bedmcp
    events_start(q) {
        journal.on = true;
        journal.track = (q.track ?? []).map(String);
        journal.every = Math.max(1, q.every ?? 10);
        journal.perfEvery = Math.max(0, q.perfEvery ?? 20);
        if (q.clear !== false) { journal.buf = []; journal.dropped = 0; }
        return { on: true, cursor: journal.seq, track: journal.track, every: journal.every, perfEvery: journal.perfEvery };
    },
    events_stop() { journal.on = false; return { on: false, cursor: journal.seq, buffered: journal.buf.length }; },
    events_read(q) {
        const since = q.since ?? 0, max = Math.min(q.max ?? 120, 400);
        const re = q.filter ? new RegExp(q.filter, 'i') : null;
        const out = [];
        let last = since;
        for (const e of journal.buf) {
            if (e.n <= since) continue;
            last = e.n;
            if (re && !re.test(e.ev)) continue;
            out.push(e);
            if (out.length >= max) break;
        }
        const more = journal.buf.some((e) => e.n > last);
        return { on: journal.on, cursor: last, more, dropped: journal.dropped, events: out };
    },
    // Ticks per second and tick times over the last `seconds` (default 5).
    tps(q) { return perfOf(Math.min(Math.max(q.seconds ?? 5, 1), 60)); },
};

// ---------------------------------------------------------------- world journal
const journal = { on: false, seq: 0, buf: [], dropped: 0, max: 6000, track: [], every: 10, perfEvery: 20 };
const at3 = (v) => [Math.round(v.x * 10) / 10, Math.round(v.y * 10) / 10, Math.round(v.z * 10) / 10];
function who(e) {
    if (!e) return undefined;
    try {
        if (!e.isValid) return { id: e.id };
        const d = { type: e.typeId.replace('minecraft:', ''), id: e.id, at: at3(e.location) };
        const name = e.name ?? e.nameTag;
        if (name) d.name = name;
        if (isBot(e)) d.bot = true;
        return d;
    } catch { return undefined; }
}
function note(ev, data) {
    if (!journal.on) return;
    journal.buf.push({ n: ++journal.seq, t: system.currentTick, ev, ...data });
    if (journal.buf.length > journal.max) { journal.buf.shift(); journal.dropped++; }
}
const on = (name, fn) => { try { world.afterEvents[name]?.subscribe((e) => { if (journal.on) try { fn(e); } catch {} }); } catch {} };
const blockAt = (b) => { try { return { block: b.typeId.replace('minecraft:', ''), at: [b.location.x, b.location.y, b.location.z] }; } catch { return {}; } };
on('entitySpawn', (e) => note('spawn', { e: who(e.entity), cause: e.cause }));
on('entityRemove', (e) => note('remove', { e: { id: e.removedEntityId, type: e.typeId?.replace('minecraft:', '') } }));
on('entityDie', (e) => note('die', { e: who(e.deadEntity), by: who(e.damageSource?.damagingEntity), cause: e.damageSource?.cause }));
on('entityHurt', (e) => note('hurt', { e: who(e.hurtEntity), by: who(e.damageSource?.damagingEntity), cause: e.damageSource?.cause, dmg: Math.round(e.damage * 100) / 100, hp: hp(e.hurtEntity) }));
on('entityHitEntity', (e) => note('hit', { by: who(e.damagingEntity), e: who(e.hitEntity) }));
on('entityHitBlock', (e) => note('hit_block', { by: who(e.damagingEntity), ...blockAt(e.hitBlock) }));
on('entityItemPickup', (e) => note('pickup', { e: who(e.entity), items: e.items?.map?.((i) => `${i.typeId}x${i.amount}`) }));
on('entityItemDrop', (e) => note('drop', { e: who(e.entity), items: e.items?.map?.((i) => `${i.typeId}x${i.amount}`) }));
on('projectileHitEntity', (e) => note('projectile_hit', { by: who(e.source), projectile: e.projectile?.typeId }));
on('effectAdd', (e) => note('effect', { e: who(e.entity), effect: e.effect?.typeId, amp: e.effect?.amplifier, ticks: e.effect?.duration }));
on('dataDrivenEntityTrigger', (e) => note('trigger', { e: who(e.entity), event: e.eventId }));
on('explosion', (e) => note('explosion', { by: who(e.source), blocks: e.getImpactedBlocks?.().length }));
on('playerJoin', (e) => note('join', { name: e.playerName, id: e.playerId }));
on('playerLeave', (e) => note('leave', { name: e.playerName, id: e.playerId }));
on('playerSpawn', (e) => note('player_spawn', { e: who(e.player), initial: e.initialSpawn }));
on('playerDimensionChange', (e) => note('dimension', { e: who(e.player), from: e.fromDimension?.id, to: e.toDimension?.id }));
on('playerBreakBlock', (e) => note('break', { e: who(e.player), block: e.brokenBlockPermutation?.type?.id?.replace('minecraft:', ''), at: [e.block.location.x, e.block.location.y, e.block.location.z] }));
on('playerPlaceBlock', (e) => note('place', { e: who(e.player), ...blockAt(e.block) }));
on('playerInteractWithBlock', (e) => note('interact_block', { e: who(e.player), ...blockAt(e.block), item: e.itemStack?.typeId }));
on('playerInteractWithEntity', (e) => note('interact', { e: who(e.player), target: who(e.target), item: e.itemStack?.typeId }));
on('itemUse', (e) => note('use', { e: who(e.source), item: e.itemStack?.typeId }));
on('playerHotbarSelectedSlotChange', (e) => note('slot', { e: who(e.player), slot: e.newSlotSelected, item: e.itemStack?.typeId }));
on('playerGameModeChange', (e) => note('gamemode', { e: who(e.player), to: e.toGameMode }));
on('chatSend', (e) => note('chat', { e: who(e.sender), message: e.message }));
on('weatherChange', (e) => note('weather', { to: e.newWeather }));
system.afterEvents.scriptEventReceive.subscribe((e) => { if (journal.on && e.id !== 'bedmcp:bot') note('scriptevent', { id: e.id, message: e.message?.slice(0, 200), by: who(e.sourceEntity) }); });

// Tick timing: wall time of every tick, for TPS and tick length (MSPT) over the last minute.
const tickTimes = [];
system.runInterval(() => {
    tickTimes.push(Date.now());
    if (tickTimes.length > 1300) tickTimes.splice(0, tickTimes.length - 1200);
}, 1);
function perfOf(seconds) {
    const now = Date.now(), from = now - seconds * 1000;
    const ts = tickTimes.filter((t) => t >= from);
    if (ts.length < 2) return { tps: null, note: 'not enough ticks yet' };
    const gaps = ts.slice(1).map((t, i) => t - ts[i]);
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sorted = [...gaps].sort((a, b) => a - b);
    return { seconds, tps: Math.round(((ts.length - 1) / ((ts[ts.length - 1] - ts[0]) / 1000)) * 10) / 10, avgTickMs: Math.round(avg * 10) / 10, p95TickMs: sorted[Math.floor(sorted.length * 0.95)], maxTickMs: sorted[sorted.length - 1], ticks: ts.length };
}
// Tracked entities' positions and the TPS, every few ticks, while the journal is on.
system.runInterval(() => {
    if (!journal.on) return;
    const t = system.currentTick;
    if (journal.perfEvery && t % journal.perfEvery === 0) note('perf', perfOf(1));
    if (!journal.track.length || t % journal.every !== 0) return;
    for (const spec of journal.track) {
        let list = [];
        try {
            if (/^-?\d+$/.test(spec)) { const e = world.getEntity(spec); if (e) list = [e]; }
            else if (spec.includes(':') || !world.getAllPlayers().some((p) => p.name === spec)) {
                for (const d of ['overworld', 'nether', 'the_end']) list.push(...world.getDimension(d).getEntities({ type: spec.includes(':') ? spec : `minecraft:${spec}` }));
            } else list = world.getAllPlayers().filter((p) => p.name === spec);
        } catch {}
        for (const e of list.slice(0, 20)) note('pos', { e: who(e), rot: (() => { try { return Math.round(e.getRotation().y); } catch { return undefined; } })() });
    }
}, 1);

system.afterEvents.scriptEventReceive.subscribe((ev) => {
    if (ev.id !== 'bedmcp:bot') return;
    let q;
    try { q = JSON.parse(ev.message); } catch { console.log(`BEDMCPBOT#? ${JSON.stringify({ error: 'bad JSON' })}`); return; }
    const id = q.id ?? '?';
    const fn = ops[q.op];
    if (!fn) { reply(id, { error: `unknown op "${q.op}"; ops: ${Object.keys(ops).join(', ')}` }); return; }
    Promise.resolve()
        .then(() => fn(q))
        .then((body) => reply(id, { ok: true, ...body }), (e) => reply(id, { error: String(e?.message ?? e) }));
});

world.afterEvents.worldLoad?.subscribe?.(() => console.log(`BEDMCPBOT#load ${JSON.stringify({ version: VERSION })}`));
