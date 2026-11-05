// Writes <dir>/sizes.json, { dex: [width, height] }, from each <dex>.gif's header (the logical
// screen size, bytes 6-9), so the card can fit each animated sprite to its slot.
import { readdirSync, openSync, readSync, closeSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const sizes = {};
const head = Buffer.alloc(10);
for (const name of readdirSync(dir)) {
  const m = /^(\d+)\.gif$/.exec(name);
  if (!m) continue;
  const fd = openSync(join(dir, name), "r");
  try {
    if (readSync(fd, head, 0, 10, 0) === 10 && head.toString("ascii", 0, 3) === "GIF") sizes[m[1]] = [head.readUInt16LE(6), head.readUInt16LE(8)];
  } finally { closeSync(fd); }
}
writeFileSync(join(dir, "sizes.json"), JSON.stringify(sizes));
console.log(Object.keys(sizes).length);
