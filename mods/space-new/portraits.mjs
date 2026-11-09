// Fetches SpriteCollab's Normal portrait (40x40, PMD profile art, CC BY-NC 4.0) for every Pokémon,
// for the Edit dialog's Pokémon picker. Only missing files are fetched; a `ready` file marks all done.
//   node portraits.mjs [count]   -> { "have": n, "total": count, "failed": [dex...] }
// Every species has a base-form Normal portrait (tracker.json), so no form folders are needed.

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".config", "herdr-app", "data", "pokemon-portraits");
const URL = (dex) => `https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master/portrait/${String(dex).padStart(4, "0")}/Normal.png`;
const PARALLEL = 6;
const TRIES = 4;

const total = Number(process.argv[2]) || 1025;
mkdirSync(DIR, { recursive: true });
const file = (dex) => join(DIR, `${dex}.png`);
const have = (dex) => existsSync(file(dex)) && statSync(file(dex)).size > 0;

async function fetchOne(dex) {
  for (let i = 0; i < TRIES; i++) {
    try {
      const res = await fetch(URL(dex), { signal: AbortSignal.timeout(20000) });
      if (res.status === 404) return false;
      if (res.ok) { writeFileSync(file(dex), Buffer.from(await res.arrayBuffer())); return true; }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000 * (i + 1))); // raw.githubusercontent drops requests now and then
  }
  return false;
}

const queue = Array.from({ length: total }, (_, i) => i + 1).filter((d) => !have(d));
const failed = [];
await Promise.all(Array.from({ length: PARALLEL }, async () => {
  for (let dex; (dex = queue.shift()) !== undefined;) if (!(await fetchOne(dex))) failed.push(dex);
}));
const count = Array.from({ length: total }, (_, i) => i + 1).filter(have).length;
if (count === total) writeFileSync(join(DIR, "ready"), String(Date.now()));
process.stdout.write(JSON.stringify({ have: count, total, failed: failed.sort((a, b) => a - b) }));
