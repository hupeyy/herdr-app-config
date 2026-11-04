// Lists the Jira tickets and GitHub PRs each Claude session works on, from its transcript.
//   node scan-work.mjs <sessionId>...   ->   { "<sessionId>": { tickets: [key], prs: [{ url, repo, number }] } }
// Tickets: keys a jira_create made ("created KEY  ->"), keys in the person's own prompts, the
// key a jira_* command acts on. PRs: Claude Code's own pr-link records (created, viewed or reviewed).
// Transcripts grow to MBs, so each file is read from where the last run stopped (cache below).

import { readFileSync, writeFileSync, readdirSync, statSync, openSync, readSync, closeSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PROJECTS = join(homedir(), ".claude", "projects");
const CACHE_DIR = join(homedir(), ".cache", "herdr-app");
const CACHE = join(CACHE_DIR, "space-work.json");
const KEY = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]+-\d+)(?![A-Za-z0-9])/g;
const PROJECT_KEYS = new Set(["RIPPLE"]); // filters look-alikes such as UTF-8 or SHA-256

let cache = {};
try { cache = JSON.parse(readFileSync(CACHE, "utf8")); } catch {}

function findTranscript(id) {
  for (const dir of readdirSync(PROJECTS)) {
    const path = join(PROJECTS, dir, `${id}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}

const keysIn = (text) => [...String(text ?? "").matchAll(KEY)].map((m) => m[1].toUpperCase()).filter((k) => PROJECT_KEYS.has(k.split("-")[0]));
const textOf = (content) => (typeof content === "string" ? content
  : Array.isArray(content) ? content.map((c) => (c.type === "text" ? c.text : typeof c.content === "string" ? c.content
    : Array.isArray(c.content) ? c.content.map((x) => x.text ?? "").join("\n") : "")).join("\n") : "");

// What the person typed: not injected (isMeta), not a background task's notice, no reminders.
function promptText(entry) {
  if (entry.isMeta || entry.isCompactSummary) return "";
  const content = entry.message?.content;
  if (Array.isArray(content) && content.some((c) => c.type === "tool_result")) return "";
  const text = textOf(content);
  if (/^\s*<(task-notification|agent-message)/.test(text) || /^Another Claude session sent a message/.test(text)) return "";
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
}

function scanLines(lines, found) {
  const add = (list, item) => { if (!list.includes(item)) list.push(item); };
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "pr-link" && e.prUrl) {
      if (!found.prs.some((p) => p.url === e.prUrl)) found.prs.push({ url: e.prUrl, repo: e.prRepository ?? "", number: e.prNumber ?? null });
    } else if (e.type === "user") {
      for (const k of keysIn(promptText(e))) add(found.tickets, k);
      const content = e.message?.content;
      if (Array.isArray(content)) for (const c of content) {
        if (c.type !== "tool_result") continue;
        for (const m of textOf([c]).matchAll(/created ([A-Z][A-Z0-9]+-\d+)\s+->/g)) add(found.tickets, m[1]);
      }
    } else if (e.type === "assistant" && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        const cmd = c.type === "tool_use" ? c.input?.command : null;
        // Only the ticket a jira_* call acts on; a create payload also names its epic parent.
        if (typeof cmd === "string") for (const m of cmd.matchAll(/\bjira_\w+\s+["']?([A-Z][A-Z0-9]+-\d+)/g)) {
          if (keysIn(m[1]).length) add(found.tickets, m[1]);
        }
      }
    }
  }
}

const out = {};
for (const id of process.argv.slice(2)) {
  const path = findTranscript(id);
  if (!path) { out[id] = { tickets: [], prs: [] }; continue; }
  const size = statSync(path).size;
  let c = cache[path];
  if (!c || c.offset > size) c = { offset: 0, tickets: [], prs: [] };
  if (size > c.offset) {
    const buffer = Buffer.alloc(size - c.offset);
    const fd = openSync(path, "r");
    try { readSync(fd, buffer, 0, buffer.length, c.offset); } finally { closeSync(fd); }
    // Stop at the last full line; a line still being written is read next time.
    const end = buffer.lastIndexOf(0x0a);
    if (end >= 0) {
      scanLines(buffer.subarray(0, end).toString("utf8").split("\n"), c);
      c.offset += end + 1;
    }
  }
  cache[path] = c;
  out[id] = { tickets: c.tickets, prs: c.prs };
}

try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(CACHE, JSON.stringify(cache)); } catch {}
process.stdout.write(JSON.stringify(out));
