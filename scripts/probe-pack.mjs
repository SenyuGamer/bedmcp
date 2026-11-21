// Writes a tiny resource pack used to prove in-place reloads: a lang string of the pause menu and a
// solid-colour oak plank texture. node scripts/probe-pack.mjs <pack dir> <tag> <r,g,b>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';

const [dir, tag = 'PROBE1', rgb = '255,0,0'] = process.argv.slice(2);
const [r, g, b] = rgb.split(',').map(Number);
mkdirSync(join(dir, 'texts'), { recursive: true });
mkdirSync(join(dir, 'textures', 'blocks'), { recursive: true });
writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
  format_version: 2,
  header: { name: 'bedmcp probe', description: 'reload test', uuid: '5b1f3a52-0c6e-4c1e-9a77-2d6f0b9e1a01', version: [1, 0, 0], min_engine_version: [1, 21, 0] },
  modules: [{ type: 'resources', uuid: '5b1f3a52-0c6e-4c1e-9a77-2d6f0b9e1a02', version: [1, 0, 0] }],
}));
writeFileSync(join(dir, 'texts', 'languages.json'), JSON.stringify(['es_ES', 'es_MX', 'en_US']));
for (const l of ['es_ES', 'es_MX', 'en_US']) writeFileSync(join(dir, 'texts', `${l}.lang`), `menu.returnToGame=${tag}\nmenu.play=${tag}\n`);

// A HUD label in the middle of the screen, to see JSON UI reloads.
mkdirSync(join(dir, 'ui'), { recursive: true });
writeFileSync(join(dir, 'ui', 'hud_screen.json'), JSON.stringify({
  namespace: 'hud',
  root_panel: { modifications: [{ array_name: 'controls', operation: 'insert_front', value: [{ bedmcp_probe_label: { type: 'label', text: `UI_${tag}`, anchor_from: 'center', anchor_to: 'center', offset: [0, -40], color: [1, 0.2, 0.2], font_scale_factor: 3, layer: 200 } }] }] },
}, null, 1));

// 16x16 RGB PNG
const W = 16, H = 16;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; for (let x = 0; x < W; x++) { const o = y * (W * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; } }
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
writeFileSync(join(dir, 'textures', 'blocks', 'planks_oak.png'), png);
console.log(`probe ${tag} rgb(${rgb}) -> ${dir}`);
