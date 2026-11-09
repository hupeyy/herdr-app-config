// The card's animated Pokémon, made the way mathieucroset/herdr-pokemon-agents (MIT) makes its
// sprites (its sprites.js, ported): PMDCollab's SpriteCollab sheet (CC BY-NC 4.0), the Idle
// animation (or Walk, which it copies when there is no Idle), the row facing down-right, scaled 2x
// with nearest neighbour (1x for big Pokémon), cut into a looping GIF with ImageMagick. Added
// here: the GIF is cropped to the box its pixels fill, so it fits the card; an Idle without a
// Walk counts, and 4 Pokémon use a form's sprite (FORMS). SpriteCollab has none for 38 (its
// tracker.json): only when it answers 404 does a Pokémon fall back. Those take
// Pokémon Showdown's gen5ani GIF, or, for the 18 gen5ani lacks too, a Black/White-style GIF made
// from the 2D still (tools/gen5-style, in data/.../gen5gen). A Pokémon with no Idle, or a one-frame
// Idle (Arcanine, Rillaboom, Iron Thorns), takes its SpriteCollab Walk.
import { exec, appHome, readTextFile, writeTextFile } from "herdr";
import { nameOf } from "./pokemon-names.js";

const ICONS_REL = "data/pokemon-icons";
export const SPRITES_REL = `${ICONS_REL}/agents`;
const GENERATED_REL = `${ICONS_REL}/gen5gen`;
const PMD = "https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master/sprite";
const GEN5ANI = "https://play.pokemonshowdown.com/sprites/gen5ani";
// Bump when the recipe changes, so cached sprites are rebuilt. The GIF's name carries it: herdr
// keeps a decoded image by path, so a GIF rewritten in place stays frozen on the old copy.
export const VERSION = 5; // 4: network failures had been saved as fallbacks; 5: Walk for a one-frame Idle
// PMD sheet rows by facing: 0 down, 1 down-right, ... The card stands it toward its title.
const IDLE_ROW = 1;
// Pokémon whose only SpriteCollab sprite is a form's: its folder (shiny groups skipped).
const FORMS = { 668: "0668/0000/0000/0002", 870: "0870/0002", 999: "0999/0001", 1008: "1008/0001" };

const pad = (id) => String(id).padStart(4, "0");
const showdownId = (name) => name.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/♀/g, "f").replace(/♂/g, "m").toLowerCase().replace(/[^a-z0-9]/g, "");

// ImageMagick 7's magick. herdr keeps the PATH it started with, so a fresh install is found in
// Program Files too. Null when there is none.
let magick;
async function findMagick() {
  if (magick !== undefined) return magick;
  if ((await exec("magick", ["-version"]).catch(() => null))?.code === 0) return (magick = "magick");
  const r = await exec("powershell", ["-NoProfile", "-Command",
    "Get-ChildItem 'C:\\Program Files\\ImageMagick*\\magick.exe' | Select-Object -First 1 -ExpandProperty FullName"]).catch(() => null);
  return (magick = r?.code === 0 && r.stdout.trim() ? r.stdout.trim() : null);
}

async function im(args) {
  const m = await findMagick();
  if (!m) throw new Error("ImageMagick not found");
  const r = await exec(m, args);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "magick failed");
  return r.stdout.trim();
}

// Downloads one file; returns true when it came, false on a 404 (the source has none). Any other
// failure (offline, a timeout, 5xx, 429) throws, so nothing is saved and the next load tries again.
// Saving it as a miss once left Meowth, Kingdra and Chatot on Showdown sprites.
async function fetchFile(file, url, agent) {
  const args = ["-sL", "--retry", "4", "--retry-all-errors", "--retry-delay", "1", "--connect-timeout", "10", "--max-time", "60", "--create-dirs", "-o", file, "-w", "%{http_code}"];
  if (agent) args.push("-A", "herdr-app");
  const r = await exec("curl", [...args, url]).catch(() => null);
  const status = Number(r?.stdout?.trim() ?? 0);
  if (status === 200) return true;
  if (status === 404) return false;
  throw new Error(`${url}: ${status || "no answer"}`);
}

function parseAnims(xml) {
  const anims = {};
  for (const m of xml.matchAll(/<Anim>([\s\S]*?)<\/Anim>/g)) {
    const body = m[1];
    const get = (tag) => body.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];
    const name = get("Name");
    if (!name) continue;
    anims[name] = {
      name, copyOf: get("CopyOf") ?? null, fw: Number(get("FrameWidth")), fh: Number(get("FrameHeight")),
      durations: [...body.matchAll(/<Duration>(\d+)<\/Duration>/g)].map((d) => Number(d[1])),
    };
  }
  return anims;
}

// Follows CopyOf ("Idle is the same as Walk") to the animation that owns a sheet.
function resolve(anims, name) {
  let a = anims[name];
  for (let hops = 0; a?.copyOf && hops < 4; hops++) a = anims[a.copyOf];
  return a && a.fw > 0 && a.fh > 0 ? a : null;
}

// One facing of one animation as a looping GIF, scaled with nearest neighbour, then cropped to the
// box all its frames fill. Returns its size.
async function cut(sheet, anim, row, scale, out) {
  const [w, h] = (await im(["identify", "-format", "%w %h", sheet])).split(" ").map(Number);
  const rows = Math.max(1, Math.floor(h / anim.fh));
  const cols = Math.max(1, Math.floor(w / anim.fw));
  const y = Math.min(row, rows - 1) * anim.fh;
  const n = Math.min(cols, anim.durations.length || cols);
  // Durations are game frames (1/60 s); GIF delays are 1/100 s.
  const cs = (anim.durations.length ? anim.durations : [10]).slice(0, n).map((d) => Math.max(2, Math.round((d * 100) / 60)));
  const delay = cs.slice(0, -1).map((c, i) => `t==${i}?${c}:`).join("") + cs[cs.length - 1];
  const full = `${out}.full.gif`;
  await im([sheet, "-crop", `${n * anim.fw}x${anim.fh}+0+${y}`, "+repage", "-crop", `${anim.fw}x${anim.fh}`, "+repage",
    "-scale", `${scale * 100}%`, "-set", "delay", `%[fx:${delay}]`, "-set", "dispose", "Background", "-loop", "0", full]);
  const box = await im([full, "-coalesce", "-background", "none", "-flatten", "-format", "%@", "info:"]);
  const m = box.match(/(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/);
  if (!m) throw new Error("empty sprite");
  await im([full, "-coalesce", "-crop", `${m[1]}x${m[2]}+${m[3]}+${m[4]}`, "+repage", "-set", "dispose", "Background", "-loop", "0", out]);
  await exec("powershell", ["-NoProfile", "-Command", `Remove-Item -LiteralPath '${full}'`]).catch(() => null);
  return { w: Number(m[1]), h: Number(m[2]) };
}

async function gifSize(file) {
  const [w, h] = (await im(["identify", "-format", "%w %h", `${file}[0]`])).split(" ").map(Number);
  return { w, h };
}

// Builds (once) and returns { path, w, h, source, built } for a Pokémon, or null (the still icon
// stays). Throws on a network failure: the caller tries again later. A sprite built before `since`
// (the Edit dialog's Update sprites) is fetched again, so new and revised SpriteCollab sprites
// arrive. Each build gets its own GIF name: herdr keeps a decoded image by path.
// meta.json is written last and marks it done.
export async function loadSprite(id, since = 0) {
  const rel = `${SPRITES_REL}/${pad(id)}`;
  const dir = `${appHome()}/${rel}`;
  const metaFile = `${dir}/meta.json`;
  const old = await readTextFile(metaFile).catch(() => null);
  try {
    const meta = JSON.parse(old);
    if (meta.version === VERSION && (meta.built ?? 0) >= since && (meta.row ?? IDLE_ROW) === IDLE_ROW) return meta;
  } catch {}
  let meta = null;
  const built = Date.now();
  const gif = `idle-${VERSION}-${built.toString(36)}.gif`;
  const base = `${PMD}/${FORMS[id] ?? pad(id)}`;
  if (await fetchFile(`${dir}/AnimData.xml`, `${base}/AnimData.xml`)) {
    const anims = parseAnims(await readTextFile(`${dir}/AnimData.xml`).catch(() => ""));
    const walk = resolve(anims, "Walk");
    // The Idle, unless it is missing or one still frame: then the Walk. An Idle alone is enough
    // (unlike herdr-pokemon-agents: the card never walks).
    const still = resolve(anims, "Idle");
    const idle = still && (still.durations.length > 1 || !walk) ? still : walk;
    if (idle) {
      if (await fetchFile(`${dir}/${idle.name}.png`, `${base}/${idle.name}-Anim.png`)) {
        // Big Pokémon (Onix, Gyarados...) have big frames: draw those at 1x.
        const scale = (walk ?? idle).fh > 64 ? 1 : 2;
        const size = await cut(`${dir}/${idle.name}.png`, idle, IDLE_ROW, scale, `${dir}/${gif}`);
        meta = { path: `${rel}/${gif}`, ...size, source: "SpriteCollab", row: IDLE_ROW };
      }
    }
  }
  if (!meta && await fetchFile(`${dir}/${gif}`, `${GEN5ANI}/${showdownId(nameOf(id))}.gif`, true)) {
    meta = { path: `${rel}/${gif}`, ...(await gifSize(`${dir}/${gif}`)), source: "gen5ani" };
  }
  if (!meta) {
    const file = `${appHome()}/${GENERATED_REL}/${id}.gif`;
    const size = await gifSize(file).catch(() => null);
    if (size) meta = { path: `${GENERATED_REL}/${id}.gif`, ...size, source: "generated" };
  }
  if (!meta) return null;
  meta = { version: VERSION, id, built, ...meta };
  // writeTextFile replaces a file only when told its current text (null creates a new one).
  await writeTextFile(metaFile, JSON.stringify(meta), old);
  // Older builds of this Pokémon (earlier recipes and refreshes): every idle GIF but the new one.
  const keep = meta.path.startsWith(`${rel}/`) ? meta.path.slice(rel.length + 1) : "";
  await exec("powershell", ["-NoProfile", "-Command",
    `Get-ChildItem -LiteralPath '${dir}' -Filter 'idle-*.gif' | Where-Object Name -ne '${keep}' | Remove-Item -ErrorAction SilentlyContinue`]).catch(() => null);
  return meta;
}
