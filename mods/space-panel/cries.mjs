// Fetches (once) each Pokémon's cry for the notification sound, and prints where each one is.
//   node cries.mjs <dex>...   -> { "<dex>": "data/pokemon-cries/<dex>.mp3" | null }
// PokeAPI gives the species name (pokemon-species/<dex>). Its own cries are OGG, which herdr's
// playSound does not take, and its README credits Pokémon Showdown for them, so the same cry is
// fetched as MP3 from Showdown, whose file name is the species name without dashes (nidoran-f ->
// nidoranf). A miss is recorded in meta.json too, so it is not asked again.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const REL = "data/pokemon-cries";
const DIR = join(homedir(), ".config", "herdr-app", REL);
const META = join(DIR, "meta.json");
const POKEAPI = "https://pokeapi.co/api/v2/pokemon-species";
const SHOWDOWN = "https://play.pokemonshowdown.com/audio/cries";

mkdirSync(DIR, { recursive: true });
let meta = {};
try { meta = JSON.parse(readFileSync(META, "utf8")); } catch {}

async function fetchCry(dex) {
  const species = await fetch(`${POKEAPI}/${dex}`, { signal: AbortSignal.timeout(10000) });
  if (!species.ok) return { missing: `PokeAPI ${species.status}` };
  const name = (await species.json()).name;
  const res = await fetch(`${SHOWDOWN}/${name.replace(/[^a-z0-9]/g, "")}.mp3`, { headers: { "User-Agent": "herdr-app" }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) return { name, missing: `Showdown ${res.status}` };
  writeFileSync(join(DIR, `${dex}.mp3`), Buffer.from(await res.arrayBuffer()));
  return { name };
}

const out = {};
for (const dex of new Set(process.argv.slice(2).map(Number).filter((n) => n > 0))) {
  if (!meta[dex] || (!meta[dex].missing && !existsSync(join(DIR, `${dex}.mp3`)))) {
    try { meta[dex] = await fetchCry(dex); } catch { continue; } // offline: try again next time
  }
  out[dex] = meta[dex].missing ? null : `${REL}/${dex}.mp3`;
}
writeFileSync(META, JSON.stringify(meta, null, 1));
process.stdout.write(JSON.stringify(out));
