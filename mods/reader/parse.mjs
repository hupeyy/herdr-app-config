#!/usr/bin/env node
// The Reader's transcript parser. Claude Code appends one JSON entry per line to
// ~/.claude/projects/<project>/<session>.jsonl; this reads only what was added since its last run
// (byte offset kept in data/reader/<session>.json), turns entries into display items, and keeps
// this chat's aggregates (decisions, running tasks, touched PRs/tickets/files) with them.
//   node parse.mjs <sessionId> [--full]
//   -> { session, title, reset, items: [...], agg, waiting }
// --full returns the kept tail of items too (a Reader that just opened). The mod runs it through
// exec: readTextFile caps at 1 MiB and transcripts grow past that.

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECTS = join(homedir(), ".claude", "projects");
const STATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "reader");
const VERSION = 7; // bump when items change shape: older state is parsed again from the start
const KEEP = 400; // items kept for a Reader that opens late
const CHUNK = 8 * 2 ** 20; // read at most this much per run, so a huge first read stays under exec's limits
const HEAD = 6; // tool result lines shown before folding
const LINE = 200;
const DECISIONS = 30;

const TICKET = /(?<![A-Za-z0-9-])([A-Z][A-Z0-9]+-\d+)(?![A-Za-z0-9])/g;
const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

const [sessionId, ...flags] = process.argv.slice(2);
if (!sessionId || !/^[\w-]+$/.test(sessionId)) { console.log(JSON.stringify({ error: "usage: parse.mjs <sessionId> [--full]" })); process.exit(0); }
const full = flags.includes("--full");

function findTranscript(id) {
  if (!existsSync(PROJECTS)) return null;
  for (const dir of readdirSync(PROJECTS)) {
    const p = join(PROJECTS, dir, `${id}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

const statePath = join(STATE_DIR, `${sessionId}.json`);
const fresh = () => ({
  version: VERSION, offset: 0, title: null, items: [],
  agg: { decisions: [], running: {}, prs: {}, tickets: [], files: [] },
  lastQuestion: null, pendingAsk: null, toolNames: {}, bgTools: {},
});
let state = fresh();
try { const s = JSON.parse(readFileSync(statePath, "utf8")); if (s.version === VERSION) state = s; } catch {}

const path = findTranscript(sessionId);
if (!path) { console.log(JSON.stringify({ session: sessionId, missing: true })); process.exit(0); }
const size = statSync(path).size;
let reset = false;
if (size < state.offset) { state = fresh(); reset = true; } // rewritten or truncated: start over

// ---- entries to items ----

function push(item) { items.push(item); }
const short = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x?.type === "text").map((x) => x.text).join("\n") : "");
const addUnique = (list, v, max = 60) => { if (v && !list.includes(v)) { list.push(v); if (list.length > max) list.shift(); } };

function touch(text) {
  for (const m of String(text).matchAll(TICKET)) if (!/^(UTF|ISO|SHA|RFC|TLS|HTTP|CVE)-/.test(m[1])) addUnique(state.agg.tickets, m[1]);
  for (const m of String(text).matchAll(PR_URL)) state.agg.prs[m[0]] = { repo: m[2], number: Number(m[3]), url: m[0] };
}

// The open question a reply ends on, if any:
//   { text, numbered: [{ n, q, options: [{ n, label }] }] }
// Numbered questions are "1. ...?" lines, or "1. topic:" lines followed by their own options
// ("- 1: do both", "- 2: ship #408 only"), as agents write them; a reply counts as asking when
// its last line ends with "?" or it holds at least one such numbered question.
function lastQuestionOf(text) {
  const lines = text.trim().split("\n");
  const clean = (s) => s.replace(/\*\*/g, "").trim();
  const numbered = [];
  for (const raw of lines) {
    const item = raw.match(/^\s{0,1}\**(\d+)[.)]\**\s+(.+)$/);
    const option = raw.match(/^\s+[-*]\s*\**(\d+)[:.)]\**\s+(.+)$/);
    if (option && numbered.length) { numbered[numbered.length - 1].options.push({ n: Number(option[1]), label: short(clean(option[2]), 140) }); continue; }
    if (item) numbered.push({ n: Number(item[1]), q: short(clean(item[2]), 200), options: [] });
  }
  const asking = numbered.filter((x) => x.options.length >= 2 || x.q.includes("?"));
  const last = clean(lines.filter((l) => l.trim()).pop() ?? "");
  const endsAsking = /\?\s*$/.test(last);
  // "One answer is still open:" then "1. option" "2. option" at the end: one question, numbered options.
  if (!endsAsking && !asking.length) {
    const kept = lines.map((l) => l.trimEnd()).filter((l) => l.trim());
    let i = kept.length;
    while (i > 0 && /^\s{0,1}\**\d+[.)]\**\s+/.test(kept[i - 1])) i--;
    const opts = kept.slice(i).map((l) => l.match(/^\s{0,1}\**(\d+)[.)]\**\s+(.+)$/)).filter(Boolean);
    const intro = clean(kept[i - 1] ?? "");
    if (opts.length >= 2 && /:\s*$/.test(intro)) {
      const q = short(intro.replace(/:\s*$/, ""), 200);
      return { text: q, single: true, numbered: [{ n: 1, q, options: opts.map((m) => ({ n: Number(m[1]), label: short(clean(m[2]), 140) })) }] };
    }
    return null;
  }
  const sentence = last.replace(/^([-*]|\d+[.)])\s+/, "").split(/(?<=[.!])\s+/).filter((s) => s.includes("?")).pop() ?? last;
  const numberedOut = asking.length >= 2 || asking.some((x) => x.options.length) ? asking : [];
  // "Which one do you want, or both?" is no yes/no question: offer the reply's last numbered list
  // (each item's bold lead, else its start), plus "Both" when the question names it.
  if (endsAsking && !numberedOut.length && /^(which|what|how|where|who|when|why)\b|\bor\b/i.test(sentence)) {
    const items = lines.map((l) => l.match(/^\**(\d+)[.)]\**\s+(.+)$/)).filter(Boolean);
    const from = items.map((m) => m[1]).lastIndexOf("1");
    const list = from >= 0 ? items.slice(from) : [];
    const choices = list.length >= 2 ? list.map((m) => {
      const lead = m[2].match(/^\*\*(.+?)\*\*/)?.[1];
      return { n: Number(m[1]), send: m[1], label: short(clean(lead ?? m[2]).replace(/[.:]$/, ""), 140) };
    }) : [];
    if (choices.length && /\bboth\b/i.test(sentence)) choices.push({ n: choices.length + 1, send: "both", label: "Both" });
    return { text: short(sentence, 240), open: true, choices, numbered: [] };
  }
  return { text: short(endsAsking ? sentence : asking[0].q, 240), numbered: numberedOut };
}

function toolSummary(name, input = {}) {
  if (name === "Bash" || name === "PowerShell") return { label: input.description || short(input.command, 120), detail: String(input.command ?? "").slice(0, 20000) }; // whole command: the Reader copies it and shows all of it
  if (["Edit", "Write", "Read", "NotebookEdit"].includes(name)) return { label: input.file_path ?? "", file: input.file_path };
  if (name === "Grep" || name === "Glob") return { label: short(input.pattern, 120) };
  if (name === "Agent") return { label: `${input.subagent_type ?? "agent"}: ${short(input.description ?? input.prompt, 100)}` };
  if (name === "Skill") return { label: input.skill ?? "" };
  if (name === "AskUserQuestion") return { label: short(input.questions?.[0]?.question, 120) };
  return { label: short(JSON.stringify(input), 120) };
}

function take(line) {
  let e;
  try { e = JSON.parse(line); } catch { return; }
  const t = e.timestamp ?? null;
  if (e.type === "custom-title" && e.customTitle) state.title = e.customTitle;
  else if (e.type === "ai-title" && e.aiTitle && !state.title) state.title = e.aiTitle;
  if (e.type === "pr-link" && e.prUrl) { state.agg.prs[e.prUrl] = { repo: (e.prRepository ?? "").split("/").pop(), number: e.prNumber, url: e.prUrl }; return; }
  if (e.type === "system") {
    if (e.subtype === "compact_boundary") push({ k: "sys", kind: "compact", t, text: `Conversation compacted · ${Math.round((e.compactMetadata?.preTokens ?? 0) / 1000)}k tokens · ${e.compactMetadata?.trigger ?? ""}` });
    else if (e.subtype === "away_summary" && e.content) push({ k: "recap", t, text: String(e.content).replace(/\s*\(disable recaps in \/config\)\s*$/, "") });
    return;
  }
  // A background task's end reaches the transcript as a queued notification (a queue-operation or
  // a queued_command attachment), not as a chat message: read it there, once per task.
  const queued = typeof e.content === "string" ? e.content : typeof e.attachment?.prompt === "string" ? e.attachment.prompt : null;
  if (queued && queued.includes("<task-notification>")) { taskDone(queued, t); return; }
  if (e.isSidechain) return; // a subagent's own steps live in its own file
  const content = e.message?.content;
  if (e.type === "assistant") {
    // The context size, as the status line shows it: everything the last turn sent the model.
    const u = e.message?.usage;
    if (u && e.message.model !== "<synthetic>") {
      state.model = e.message.model;
      state.ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    }
    for (const c of Array.isArray(content) ? content : []) {
      if (c.type === "text" && c.text?.trim()) {
        push({ k: "asst", t, text: c.text });
        touch(c.text);
        state.lastQuestion = lastQuestionOf(c.text);
      } else if (c.type === "tool_use") {
        state.toolNames[c.id] = c.name;
        const s = toolSummary(c.name, c.input);
        if (s.file && (c.name === "Edit" || c.name === "Write" || c.name === "NotebookEdit")) addUnique(state.agg.files, s.file);
        if (c.name === "AskUserQuestion") {
          state.pendingAsk = { id: c.id, t, questions: (c.input?.questions ?? []).map((q) => ({ header: q.header, question: q.question, multi: Boolean(q.multiSelect), options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })) })) };
          push({ k: "ask", t, id: c.id, questions: state.pendingAsk.questions });
        } else push({ k: "tool", t, id: c.id, name: c.name, ...s });
        if ((c.name === "Bash" || c.name === "PowerShell") && c.input?.run_in_background) state.bgTools[c.id] = s.label;
      }
    }
    return;
  }
  if (e.type !== "user" || e.isMeta) return;
  if (e.isCompactSummary) { push({ k: "sys", kind: "summary", t, text: short(textOf(content), 4000) }); return; }
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  for (const c of blocks) {
    if (c.type === "tool_result") {
      const raw = typeof c.content === "string" ? c.content : textOf(c.content);
      const text = raw.replace(REMINDER, "").trim();
      const name = state.toolNames[c.tool_use_id];
      const lines = text.split("\n");
      const image = Array.isArray(c.content) && c.content.some((x) => x?.type === "image");
      if (name === "AskUserQuestion" && state.pendingAsk?.id === c.tool_use_id) {
        const answers = [...text.matchAll(/"([^"]+)"="([^"]*)"/g)].map((m) => ({ q: m[1], a: m[2] }));
        push({ k: "answer", t, id: c.tool_use_id, text: answers.length ? answers.map((x) => x.a).join("; ") : short(text, 300) });
        for (const x of answers.length ? answers : [{ q: state.pendingAsk.questions[0]?.question, a: short(text, 120) }]) decide(t, x.q, x.a);
        state.pendingAsk = null;
        continue;
      }
      const bg = text.match(/running in background with ID: (\w+)/);
      if (bg && !state.done?.[bg[1]]) state.agg.running[bg[1]] = { label: state.bgTools[c.tool_use_id] ?? "background task", at: t };
      touch(text);
      push({ k: "result", t, id: c.tool_use_id, err: Boolean(c.is_error), image, head: lines.slice(0, HEAD).map((l) => l.slice(0, LINE)), more: Math.max(0, lines.length - HEAD) });
      continue;
    }
    if (c.type === "image") { push({ k: "user", t, text: "[image]" }); continue; }
    if (c.type !== "text" || !c.text) continue;
    let text = c.text.replace(REMINDER, "").trim();
    if (!text) continue;
    // Text Alex pasted (often another agent's message): unwrap it; his own words after it stay his.
    const paste = text.match(/^<pasted_content[^>]*>\s*([\s\S]*?)\s*<\/pasted_content[^>]*>\s*([\s\S]*)$/);
    if (paste) {
      const inner = paste[1].match(/^<hc from="([^"]*)"(?:\s+reach=(?:'([^']*)'|"([^"]*)"))?>([\s\S]*?)<\/hc>$/);
      if (inner) {
        push({ k: "peer", t, from: inner[1], reach: inner[2] ?? inner[3] ?? null, text: inner[4].trim(), pasted: true });
        touch(inner[4]);
        if (!paste[2].trim()) continue;
        text = paste[2].trim();
      } else text = [paste[1], paste[2]].filter((x) => x.trim()).join("\n\n");
    }
    if (text.includes("<task-notification>")) { taskDone(text, t); continue; }
    const cmd = text.match(/<command-name>\/?([^<]+)<\/command-name>/);
    if (cmd) { push({ k: "sys", kind: "cmd", t, text: `/${cmd[1].replace(/^\//, "")}` }); continue; }
    if (/^<local-command|^<bash-(stdout|stderr|input)>/.test(text)) continue;
    if (/^\[Request interrupted/.test(text)) { push({ k: "sys", kind: "interrupt", t, text: "You stopped this turn" }); continue; }
    const peer = text.match(/^<hc from="([^"]*)"(?:\s+reach=(?:'([^']*)'|"([^"]*)"))?>([\s\S]*?)<\/hc>$/);
    if (peer) { push({ k: "peer", t, from: peer[1], reach: peer[2] ?? peer[3] ?? null, text: peer[4].trim() }); touch(peer[4]); continue; }
    if (/^This session is being continued from a previous conversation/.test(text)) { push({ k: "sys", kind: "summary", t, text: short(text, 4000) }); continue; }
    push({ k: "user", t, text });
    touch(text);
    if (state.lastQuestion) decide(t, state.lastQuestion.text, short(text, 160));
    state.lastQuestion = null;
  }
}

// One background task ended: drop it from Running and say so once (its notification can show up
// as a queue entry, an attachment and a message for the same task).
function taskDone(text, t) {
  const note = text.match(/<task-notification>[\s\S]*?<task-id>([^<]+)<\/task-id>/);
  if (!note) return;
  const id = note[1];
  state.done ??= {};
  if (state.done[id]) return;
  state.done[id] = true;
  const status = text.match(/<status>([^<]*)<\/status>/)?.[1] ?? "";
  const summary = text.match(/<summary>([^<]*)<\/summary>/)?.[1];
  delete state.agg.running[id];
  push({ k: "sys", kind: "task", t, ok: !/fail|error|killed/i.test(status), text: short(summary ?? `Background task ${status || "finished"}`, 200) });
}

function decide(t, q, a) {
  state.agg.decisions.push({ t, q: short(q, 160), a: short(a, 160) });
  if (state.agg.decisions.length > DECISIONS) state.agg.decisions.shift();
}

// ---- read the new complete lines ----
const items = [];
const fd = openSync(path, "r");
try {
  while (state.offset < size) {
    const len = Math.min(CHUNK, size - state.offset);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, state.offset);
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) break; // a line still being written
    for (const line of buf.subarray(0, end).toString("utf8").split("\n")) if (line.trim()) take(line);
    state.offset += end + 1;
  }
} finally { closeSync(fd); }

// ---- keep and answer ----
state.items = state.items.concat(items).slice(-KEEP);
mkdirSync(STATE_DIR, { recursive: true });
writeFileSync(statePath, JSON.stringify(state));
console.log(JSON.stringify({
  session: sessionId, title: state.title, reset, path, model: state.model ?? null, ctx: state.ctx ?? null,
  items: full || reset ? state.items : items,
  replaced: full || reset,
  agg: state.agg,
  waiting: { question: state.lastQuestion, ask: state.pendingAsk },
}));
