// Summarises Claude sessions for the Workspace summary panel with one Haiku call.
//   node summarize.mjs '{"live": [terminal], "stale": [{ id, session, turn, title, space, tab, newSession? }]}'
//   -> ~/.cache/herdr-app/space-summary.json { at, cost, error, running, items: { "<id>": { verdict, summary, next, session, turn, at } } }
// Each session sends only its latest prompts and replies (the transcript tail), so a refresh
// costs about 1k Haiku tokens per changed session plus ~800 of fixed overhead.

import { readdirSync, existsSync, statSync, openSync, readSync, closeSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const CACHE_DIR = join(homedir(), ".cache", "herdr-app");
const CACHE = join(CACHE_DIR, "space-summary.json");
const PROJECTS = join(homedir(), ".claude", "projects");
const TAIL_BYTES = 1.5 * 2 ** 20;
const PROMPT_CHARS = 600;
const REPLY_CHARS = 2800;

const SYSTEM = `You triage coding-agent sessions for a developer, Alex. Each session lists the agent's title, its dev workspace, Alex's latest prompts and the agent's latest replies.
Reply with a JSON array only, one object per session: {"id", "verdict", "summary", "next"}.
- verdict: "done" when the agent finished and nothing is left for it, so its workspace can close. "you" when it waits on Alex: a question, a decision, an approval, or a step only Alex can do. "others" when it waits on someone or something else: a reviewer, CI, a colleague's merge.
- summary: what the work is and where it stands. One sentence, at most 25 words. Name tickets and PRs.
- next: the next action and who owns it, at most 15 words. "" when done.
Plain words. No em dashes. No markdown.`;

function findTranscript(id) {
  for (const dir of readdirSync(PROJECTS)) {
    const path = join(PROJECTS, dir, `${id}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}

function tailLines(path) {
  const size = statSync(path).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const buffer = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try { readSync(fd, buffer, 0, buffer.length, start); } finally { closeSync(fd); }
  const lines = buffer.toString("utf8").split("\n");
  if (start > 0) lines.shift(); // a partial first line
  return lines;
}

const textOf = (content) => (typeof content === "string" ? content
  : Array.isArray(content) ? content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : "");

// What Alex typed: not injected, not a tool result, not a task notice, no reminders.
function promptText(e) {
  if (e.isMeta || e.isCompactSummary) return "";
  const content = e.message?.content;
  if (Array.isArray(content) && content.some((c) => c.type === "tool_result")) return "";
  const text = textOf(content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (!text || /^<(task-notification|agent-message|local-command|command-)/.test(text)) return "";
  return text;
}

const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

// The last two prompts, and the agent's text since the last one (its final words matter most).
function digest(session) {
  const path = session && findTranscript(session);
  if (!path) return null;
  const prompts = [];
  let replies = [];
  for (const line of tailLines(path)) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "user") {
      const p = promptText(e);
      if (p) { prompts.push(p); replies = []; }
    } else if (e.type === "assistant") {
      const r = textOf(e.message?.content).trim();
      if (r) replies.push(r);
    }
  }
  if (!prompts.length && !replies.length) return { empty: true }; // a fresh session, e.g. after /clear
  const reply = replies.join("\n\n");
  return {
    prompts: prompts.slice(-2).map((p) => cut(p, PROMPT_CHARS)),
    reply: reply.length > REPLY_CHARS ? `…${reply.slice(-REPLY_CHARS)}` : reply,
  };
}

function parseArray(text) {
  const start = text.indexOf("["), end = text.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("no JSON array in the reply");
  return JSON.parse(text.slice(start, end + 1));
}

// The panel may close mid-run, so this script owns the cache file and the panel only reads it.
const readCache = () => { try { return JSON.parse(readFileSync(CACHE, "utf8")); } catch { return { items: {} }; } };
const writeCache = (c) => { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(CACHE, JSON.stringify(c)); };

const { live = [], stale: input = [] } = JSON.parse(process.argv[2] ?? "{}");
writeCache({ ...readCache(), running: Date.now() });
const blocks = [];
const items = {};
for (const s of input) {
  // newSession: status-usage saw a new session label (/clear, or /resume). An empty chat needs no Haiku
  // call; a fresh session may have no transcript file yet.
  const d = digest(s.session);
  if (d?.empty || (!d && s.newSession)) { items[s.id] = { verdict: "cleared", summary: "Nothing, chat is cleared.", next: "" }; continue; }
  if (!d) { items[s.id] = { verdict: null, summary: "No transcript found.", next: "" }; continue; }
  blocks.push([
    `### Session ${s.id}`,
    `Title: ${s.title || "(none)"}`,
    `Dev workspace: ${s.space}${s.tab && s.tab !== s.space ? ` / tab ${s.tab}` : ""}`,
    ...d.prompts.map((p, i) => `Alex's prompt ${i + 1}:\n${p}`),
    `Agent's latest reply:\n${d.reply || "(none)"}`,
  ].join("\n"));
}

let cost = 0, error = null;
if (blocks.length) {
  // An empty folder: no CLAUDE.md, no project settings, no session file left behind.
  const cwd = join(tmpdir(), "herdr-space-summary");
  mkdirSync(cwd, { recursive: true });
  const r = spawnSync("claude", ["-p", "--model", "haiku", "--tools", "", "--setting-sources", "",
    "--no-session-persistence", "--permission-mode", "default", "--output-format", "json", "--system-prompt", SYSTEM],
  { input: blocks.join("\n\n"), cwd, encoding: "utf8", timeout: 120000, windowsHide: true, maxBuffer: 16 * 2 ** 20 });
  try {
    if (r.error) throw r.error;
    const out = JSON.parse(r.stdout);
    if (out.is_error) throw new Error(String(out.result).slice(0, 200));
    cost = out.total_cost_usd ?? 0;
    for (const x of parseArray(out.result)) {
      if (x?.id == null) continue;
      items[x.id] = { verdict: ["done", "you", "others"].includes(x.verdict) ? x.verdict : null, summary: String(x.summary ?? ""), next: String(x.next ?? "") };
    }
  } catch (e) {
    error = `Haiku call failed: ${String(e.message ?? e).slice(0, 200)}${r.stderr ? ` (${r.stderr.trim().slice(0, 200)})` : ""}`;
  }
}
// Keep only live terminals; a summary is valid for the session and turn it was made from.
const now = Date.now();
const before = readCache().items ?? {};
const merged = Object.fromEntries(live.filter((id) => before[id]).map((id) => [id, before[id]]));
for (const s of input) {
  if (items[s.id]) merged[s.id] = { ...items[s.id], session: s.session, turn: s.turn, at: now };
}
writeCache({ at: now, cost, error, running: null, items: merged });
process.stdout.write(JSON.stringify({ cost, error, count: input.length }));
