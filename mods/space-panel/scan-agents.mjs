// Lists each Claude session's own subagents (the Agent tool, run inside the Claude process, so
// herdr cannot see them) from the transcripts Claude Code keeps beside the session's:
//   <projects>/<project>/<sessionId>/subagents/agent-<id>.jsonl and .meta.json
//   node scan-agents.mjs <sessionId>...
//   -> { "<sessionId>": [{ id, type, description, running, at, activity, path }] }
// Running ones, plus ones that finished in the last 10 minutes. "activity" is what the agent is
// doing now: its latest tool call's description, as Claude's own agents footer shows it.

import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PROJECTS = join(homedir(), ".claude", "projects");
const RECENT_MS = 10 * 60 * 1000;
const TAIL_BYTES = 96 * 1024;

function sessionDir(id) {
  for (const dir of readdirSync(PROJECTS)) {
    const path = join(PROJECTS, dir, id, "subagents");
    if (existsSync(path)) return path;
  }
  return null;
}

function tail(path) {
  const size = statSync(path).size;
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
  const lines = buffer.toString("utf8").split("\n");
  if (size > length) lines.shift(); // the first line is cut
  return lines.filter(Boolean);
}

const short = (text, max = 90) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// The newest step: a tool call's description, else the tool and its target, else its text.
export function activityOf(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (e.type !== "assistant" || !Array.isArray(e.message?.content)) continue;
    for (let j = e.message.content.length - 1; j >= 0; j--) {
      const c = e.message.content[j];
      if (c.type === "tool_use") {
        const input = c.input ?? {};
        return short(input.description ?? `${c.name} ${input.file_path ?? input.pattern ?? input.command ?? input.url ?? ""}`);
      }
      if (c.type === "text" && c.text?.trim()) return short(c.text);
    }
  }
  return "";
}

const out = {};
const now = Date.now();
for (const sid of process.argv.slice(2)) {
  const dir = sessionDir(sid);
  out[sid] = [];
  if (!dir) continue;
  for (const name of readdirSync(dir)) {
    const m = /^agent-(.+)\.meta\.json$/.exec(name);
    if (!m) continue;
    const path = join(dir, `agent-${m[1]}.jsonl`);
    if (!existsSync(path)) continue;
    let meta;
    try { meta = JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { continue; }
    const at = statSync(path).mtimeMs;
    // A session that died never marks its agents finished: silent for 10 minutes counts as stopped.
    const running = meta.finished !== true && now - at < RECENT_MS;
    if (!running && now - at > RECENT_MS) continue;
    out[sid].push({
      id: m[1], type: meta.agentType ?? "agent", description: meta.description ?? "", running, at,
      activity: running ? activityOf(tail(path)) : "", path,
    });
  }
  out[sid].sort((a, b) => b.running - a.running || b.at - a.at);
}
process.stdout.write(JSON.stringify(out));
