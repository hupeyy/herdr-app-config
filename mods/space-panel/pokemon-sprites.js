// The card's animated Pokémon, made the way mathieucroset/herdr-pokemon-agents (MIT) makes its
// sprites (its sprites.js, ported): PMDCollab's SpriteCollab sheet (CC BY-NC 4.0), the Idle
// animation (or Walk, which it copies when there is no Idle), the row facing down-right, scaled 2x
// with nearest neighbour (1x for big Pokémon), cut into a looping GIF with ImageMagick. Added
// here: the GIF is cropped to the box its pixels fill, so it fits the card; an Idle without a
// Walk counts, and 4 Pokémon use a form's sprite (FORMS). SpriteCollab has none for 38: those take
// Pokémon Showdown's gen5ani GIF, or, for the 18 gen5ani lacks too, a Black/White-style GIF made
// from the 2D still (tools/gen5-style, in data/.../gen5gen).
import { exec, appHome, readTextFile, writeTextFile } from "herdr";
import { nameOf } from "./pokemon-names.js";

const ICONS_REL = "data/pokemon-icons";
export const SPRITES_REL = `${ICONS_REL}/agents`;
const GENERATED_REL = `${ICONS_REL}/gen5gen`;
const PMD = "https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master/sprite";
const GEN5ANI = "https://play.pokemonshowdown.com/sprites/gen5ani";
// Bump when the recipe changes, so cached sprites are rebuilt.
const VERSION = 2;
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

async function curl(pairs, agent) {
  const args = ["-sfL", "--retry", "2", "--connect-timeout", "10", "--create-dirs"];
  if (agent) args.push("-A", "herdr-app");
  for (const [file, url] of pairs) args.push("-o", file, url);
  return (await exec("curl", args).catch(() => null))?.code === 0;
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

// Builds (once) and returns { path, w, h, source } for a Pokémon, or null (the still icon stays).
// meta.json is written last and marks it done.
export async function loadSprite(id) {
  const rel = `${SPRITES_REL}/${pad(id)}`;
  const dir = `${appHome()}/${rel}`;
  const metaFile = `${dir}/meta.json`;
  try {
    const meta = JSON.parse(await readTextFile(metaFile));
    if (meta.version === VERSION) return meta;
  } catch {}
  let meta = null;
  const base = `${PMD}/${FORMS[id] ?? pad(id)}`;
  if (await curl([[`${dir}/AnimData.xml`, `${base}/AnimData.xml`]])) {
    const anims = parseAnims(await readTextFile(`${dir}/AnimData.xml`).catch(() => ""));
    const walk = resolve(anims, "Walk");
    // Unlike herdr-pokemon-agents, an Idle alone is enough (the card never walks).
    const idle = resolve(anims, "Idle") ?? walk;
    if (idle) {
      if (await curl([[`${dir}/${idle.name}.png`, `${base}/${idle.name}-Anim.png`]])) {
        // Big Pokémon (Onix, Gyarados...) have big frames: draw those at 1x.
        const scale = (walk ?? idle).fh > 64 ? 1 : 2;
        const size = await cut(`${dir}/${idle.name}.png`, idle, IDLE_ROW, scale, `${dir}/idle.gif`);
        meta = { path: `${rel}/idle.gif`, ...size, source: "SpriteCollab" };
      }
    }
  }
  if (!meta && await curl([[`${dir}/idle.gif`, `${GEN5ANI}/${showdownId(nameOf(id))}.gif`]], true)) {
    meta = { path: `${rel}/idle.gif`, ...(await gifSize(`${dir}/idle.gif`)), source: "gen5ani" };
  }
  if (!meta) {
    const file = `${appHome()}/${GENERATED_REL}/${id}.gif`;
    const size = await gifSize(file).catch(() => null);
    if (size) meta = { path: `${GENERATED_REL}/${id}.gif`, ...size, source: "generated" };
  }
  if (!meta) return null;
  meta = { version: VERSION, id, ...meta };
  await writeTextFile(metaFile, JSON.stringify(meta), null);
  return meta;
}
