// Claude Code's status line command: saves the status JSON Claude Code pipes in (model, context
// window size and use) per session for the Reader, then runs ccstatusline on it as before.
// The transcript has the model and token counts but not the window size; only this input has it.
//   settings.json: "statusLine": { "type": "command", "command": "node <this file>" }

import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "reader", "status");
const CCSTATUSLINE = join(process.env.APPDATA ?? "", "npm", "node_modules", "ccstatusline", "dist", "ccstatusline.js");

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = Buffer.concat(chunks).toString("utf8");

try {
  const s = JSON.parse(input);
  if (/^[\w-]+$/.test(s.session_id ?? "")) {
    mkdirSync(OUT, { recursive: true });
    const file = join(OUT, `${s.session_id}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify({ t: Date.now(), model: s.model, context_window: s.context_window }));
    renameSync(`${file}.tmp`, file);
  }
} catch {
  // never break the status line over the Reader's copy
}

const r = spawnSync(process.execPath, [CCSTATUSLINE], { input, encoding: "utf8", windowsHide: true });
process.stdout.write(r.stdout ?? "");
