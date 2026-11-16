// Hibernates idle Claude panes: exits Claude but keeps the pane and its claude.session labels,
// so the pane resumes in place later. A hibernated pane is a plain shell (~50 MB, not ~1.2 GB).
//
//   node hibernate.mjs tick [--keep t1,t2] [--dry-run]  hibernate idle panes (the hibernate mod runs it every 5 min)
//   node hibernate.mjs sleep <terminal>                 hibernate one pane now (still refuses a busy one)
//   node hibernate.mjs wake <terminal>                  resume it in place and wait for the prompt
//   node hibernate.mjs ls                               hibernated panes
//
// Labels: claude.hibernated=<ISO time> marks a hibernated pane. herdr-resume.ps1 keeps the session
// labels on /exit while it is set, skips the reboot resume, and clears it at the next SessionStart.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { freemem } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";

const IDLE_MIN = 30;          // hibernate after this long idle
const PRESSURE_GB = 3;        // under this much free RAM, hibernate sooner...
const TARGET_GB = 4;          // ...oldest first, until back above this
const PRESSURE_IDLE_MIN = 5;  // even under pressure, never a pane that finished a turn this recently
const GB = 2 ** 30;

// Run from an agent's pane, hc sends text as a message from that terminal (<hc from="t2">), and
// Claude reads "/exit" as chat, not a command. Without HC_TERMINAL_ID it types like a person.
const HC_ENV = { ...process.env };
delete HC_ENV.HC_TERMINAL_ID;
const hc = (...args) => execFileSync("hc", args, { encoding: "utf8", windowsHide: true, timeout: 15000, env: HC_ENV });
const getTerminal = (t) => JSON.parse(hc("get", t, "--json"));
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Live interactive Claude sessions by session id, from ~/.claude/sessions/<pid>.json.
function sessions() {
  const dir = join(homedir(), ".claude", "sessions");
  const out = new Map();
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    if (!f.endsWith(".json")) continue;
    try {
      const s = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (s.kind === "interactive" && s.sessionId && alive(s.pid)) out.set(s.sessionId, s);
    } catch {}
  }
  return out;
}

// The screen must show an empty prompt and no background work in the footer. A draft, a
// suggestion, a permission dialog or a running shell all mean keep.
function screenBlocker(t) {
  const lines = hc("read", t, "--lines", "20").split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  const at = lines.findLastIndex((l) => l.startsWith("❯"));
  if (at < 0) return "no prompt on screen";
  // A fresh session shows a `Try "..."` placeholder, which is not a draft.
  if (!/^❯\s*(Try ".*")?$/.test(lines[at].trim())) return "prompt is not empty";
  const footer = lines.slice(at + 1).join(" ");
  if (/\b\d+\s+(shells?|bash|background|tasks?|monitors?|jobs?|crons?)\b|running/i.test(footer)) return "background work in the footer";
  return null;
}

// Every Claude pane that is awake: { t, labels, session } (session = its live session file).
function claudePanes() {
  const live = sessions();
  return JSON.parse(hc("ls", "--json")).terminals
    .filter((x) => x.state === "live")
    .map((x) => ({ x, info: getTerminal(x.address) }))
    .filter(({ info }) => info.labels?.["claude.session"] && !info.labels["claude.hibernated"])
    .map(({ x, info }) => ({ t: x.address, labels: info.labels, session: live.get(info.labels["claude.session"]) ?? null }));
}

// A session with no turns has no transcript, and `claude --resume` then finds nothing.
function hasTranscript(id) {
  const root = join(homedir(), ".claude", "projects");
  return readdirSync(root).some((dir) => existsSync(join(root, dir, `${id}.jsonl`)));
}

function eligible(p, keep, minIdleMin) {
  if (keep.has(p.t)) return "on screen";
  if (!p.session) return "no live interactive session";
  if (!hasTranscript(p.labels["claude.session"])) return "no transcript to resume";
  if (p.session.status !== "idle") return `status ${p.session.status}`;
  const idleMin = (Date.now() - (p.session.statusUpdatedAt ?? p.session.updatedAt ?? Date.now())) / 60000;
  if (idleMin < minIdleMin) return `idle ${Math.round(idleMin)} min`;
  return screenBlocker(p.t);
}

async function hibernate(p) {
  hc("label", p.t, `claude.hibernated=${new Date().toISOString()}`);
  // Look again right before typing: a turn may have started since the pane was picked.
  if (sessions().get(p.labels["claude.session"])?.status !== "idle" || screenBlocker(p.t)) { hc("label", p.t, "claude.hibernated="); return false; }
  hc("send", p.t, "/exit");
  for (let i = 0; i < 60 && alive(p.session.pid); i++) await sleepMs(500);
  if (!alive(p.session.pid)) return true;
  hc("label", p.t, "claude.hibernated="); // it did not exit: leave it awake and say so
  return false;
}

async function tick(opt) {
  const keep = new Set((opt.keep ?? "").split(",").filter(Boolean));
  const panes = claudePanes().sort((a, b) => (a.session?.statusUpdatedAt ?? 0) - (b.session?.statusUpdatedAt ?? 0));
  const result = { freeGb: +(freemem() / GB).toFixed(2), hibernated: [], skipped: {}, failed: [] };
  let pressure = freemem() < PRESSURE_GB * GB;
  result.pressure = pressure;
  for (const p of panes) {
    const why = eligible(p, keep, pressure ? PRESSURE_IDLE_MIN : IDLE_MIN);
    if (why) { result.skipped[p.t] = why; continue; }
    if (opt["dry-run"]) { result.hibernated.push(p.t); continue; }
    if (await hibernate(p)) result.hibernated.push(p.t); else result.failed.push(p.t);
    if (pressure) { await sleepMs(3000); pressure = freemem() < TARGET_GB * GB; }
  }
  result.freeGbAfter = +(freemem() / GB).toFixed(2);
  return result;
}

async function wake(t) {
  const info = getTerminal(t);
  const id = info.labels?.["claude.session"];
  if (!info.labels?.["claude.hibernated"]) return { terminal: t, awake: true, note: "not hibernated" };
  if (sessions().has(id)) { hc("label", t, "claude.hibernated="); return { terminal: t, awake: true, note: "already running" }; }
  // Clear first, so a second waker (a select and an hx send together) sees it awake and stops.
  hc("label", t, "claude.hibernated=");
  const mode = info.labels["claude.mode"] || "auto";
  const cwd = info.labels["claude.cwd"];
  const cd = cwd ? `Set-Location -LiteralPath '${cwd.replaceAll("'", "''")}'; ` : "";
  hc("send", t, `${cd}claude --resume ${id} --permission-mode ${mode}`);
  for (let i = 0; i < 180; i++) {
    await sleepMs(500);
    const s = sessions().get(id);
    if (s && s.status === "idle" && i > 4) return { terminal: t, awake: true, session: id };
  }
  return { terminal: t, awake: false, session: id, note: "no idle prompt after 90 s" };
}

const [cmd, ...args] = process.argv.slice(2);
const arg = args[0]?.startsWith("--") ? undefined : args[0];
const opt = {};
for (let i = 0; i < args.length; i++) {
  if (!args[i].startsWith("--")) continue;
  const next = args[i + 1];
  opt[args[i].slice(2)] = next !== undefined && !next.startsWith("--") ? args[++i] : true;
}
try {
  let out;
  if (cmd === "tick") out = await tick(opt);
  else if (cmd === "wake") out = await wake(arg);
  else if (cmd === "sleep") {
    const p = claudePanes().find((x) => x.t === arg);
    const why = p ? eligible(p, new Set(), 0) : "not an awake Claude pane";
    out = why ? { terminal: arg, hibernated: false, why } : { terminal: arg, hibernated: await hibernate(p) };
  } else if (cmd === "ls") {
    out = JSON.parse(hc("ls", "--json")).terminals.filter((x) => x.state === "live")
      .map((x) => ({ t: x.address, labels: getTerminal(x.address).labels ?? {} }))
      .filter((x) => x.labels["claude.hibernated"]).map((x) => ({ terminal: x.t, since: x.labels["claude.hibernated"], session: x.labels["claude.session"] }));
  } else { console.error("usage: hibernate.mjs tick [--keep t1,t2] [--dry-run] | sleep <t> | wake <t> | ls"); process.exit(2); }
  process.stdout.write(JSON.stringify(out) + "\n");
} catch (e) {
  console.error(String(e.message ?? e));
  process.exit(1);
}
