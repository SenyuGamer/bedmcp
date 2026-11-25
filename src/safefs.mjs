// The only way bedmcp deletes anything. Test servers and clients hold junctions to the project's
// packs, so a delete must never reach the project's files, whatever path it is given:
// - a link (junction or symlink) is unlinked, never entered;
// - inside a folder, every link is unlinked before the folder is removed;
// - a path whose real location (after following links) is inside a protected folder (the project,
//   its packs), or that holds one, is refused with an error.
import { realpathSync, lstatSync, readdirSync, unlinkSync, rmSync, rmdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const norm = (p) => resolve(p).toLowerCase().replace(/[\\/]+$/, '');
const real = (p) => { try { return norm(realpathSync.native(p)); } catch { return null; } };
const inside = (p, root) => p === root || p.startsWith(root + sep);

let strict = [];  // never touched: not the folder, nothing in it, nothing that holds it
let project = []; // same, except bedmcp's own state and temp folders when they sit inside it
let ownDirs = [tmpdir()].map(norm);

/** Adds folders to protect (never replaces: a session that switched project keeps the old one safe). strict: the project's pack folders. project: the project folder. own: bedmcp's state folders. */
export function protectPaths({ strict: s = [], project: p = [], own = [] } = {}) {
  const both = (x) => [norm(x), real(x)].filter(Boolean);
  strict = [...new Set([...strict, ...s.flatMap(both)])];
  project = [...new Set([...project, ...p.flatMap(both)])];
  ownDirs = [...new Set([...ownDirs, ...own.flatMap(both)])];
}

export function refusal(p) {
  const at = [norm(p), real(p)].filter(Boolean);
  for (const a of at) {
    for (const r of [...strict, ...project]) if (inside(r, a)) return `${p} holds the protected folder ${r}`;
    for (const r of strict) if (inside(a, r)) return `${p} is inside the project pack ${r}`;
    for (const r of project) if (inside(a, r) && !ownDirs.some((o) => inside(a, o))) return `${p} is inside the project ${r}`;
  }
  return null;
}

function unlinkLink(p) {
  try { unlinkSync(p); } catch { rmdirSync(p); } // a directory junction may need rmdir; neither recurses
}

// Unlinks every link under dir (without entering it), so the removal below only meets real files.
function unlinkLinksUnder(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) unlinkLink(p);
    else if (e.isDirectory()) unlinkLinksUnder(p);
  }
}

/** Deletes a file, a link (the link only) or a folder (recursively), never into the project. */
export function safeRm(p) {
  let st;
  try { st = lstatSync(p); } catch { return; } // already gone
  if (st.isSymbolicLink()) { unlinkLink(p); return; }
  const why = refusal(p);
  if (why) throw new Error(`bedmcp refused to delete ${p}: ${why}. It never deletes project files.`);
  if (st.isDirectory()) unlinkLinksUnder(p);
  rmSync(p, { recursive: true, force: true });
}
