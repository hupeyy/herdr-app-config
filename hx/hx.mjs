#!/usr/bin/env node
// hx: lets agents (and people) drive herdr-app by name: workspaces, dev workspaces, tabs and the
// agents in them. A thin layer over `herdr-app do` (app commands), `hc` (terminals) and the
// space-tabs bridge (workspaces live in mod shared state, which only a mod can write).
// Run `hx help` for usage. Words: a workspace is a root (the top-level folder group, e.g. "dev");
// a dev workspace is a herdr space inside one; a tab holds terminals; an agent is a terminal.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = join(homedir(), ".config", "herdr-app");
const BRIDGE = join(HOME, "data", "hx");
const BRIDGE_TIMEOUT_MS = 8000;
const PROJECTS = join(homedir(), ".claude", "projects");
const TICKET = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]+-\d+)/i;
const SHELLS = /^(powershell|pwsh|cmd|bash|sh|zsh|fish|nu)(\.exe)?$/i;

const USAGE = `hx: drive herdr-app by name. Targets take a name, a ticket key, an id, or "space/tab".

Look
  hx ls [--json]                       workspaces > dev workspaces > tabs > terminals, with status
  hx whoami [--json]                   the caller's terminal, tab, dev workspace and workspace

Workspaces (top-level folder groups)
  hx ws ls [--json]
  hx ws new <name> --folder <dir> [--color ansi1..ansi6]
  hx ws rename <ws> <name>
  hx ws rm <ws> [--force]              --force when it still has dev workspaces (they regroup by folder)

Dev workspaces
  hx space new <name> [--ws <ws>] [--folder <dir>] [--tab <name>] [--agent "<cmd>"] [--task "<text>"] [--show]
  hx space rename <space> <name>
  hx space move <space> --ws <ws>
  hx space rm <space> [--force]        refuses a locked space, your own, or one with a working agent

Tabs
  hx tab new <space> [--name <n>] [--folder <dir>] [--agent "<cmd>"] [--task "<text>"] [--show]
  hx tab rename <space/tab> <name>
  hx tab rm <space/tab> [--force]      refuses your own tab, a locked space's tab, or a working agent

Talk to agents
  hx send <target> <text> [--force]    type it into the agent and press Enter
  hx ask <target> <text> [--timeout <s>] [--force]
                                       send, wait for the turn to end, print the reply
  hx read <target> [--lines <n>]       its screen (plus n lines of history)
  hx wait <target> [--timeout <s>]     until it stops working

New spaces and tabs open in the background (your view stays) unless --show.
--agent defaults to "claude" when --task is given. Exit codes: 0 ok, 1 error, 2 refused.`;

class Refused extends Error {}

// ---- argv ----

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (["json", "force", "show", "help"].includes(key)) opt[key] = true;
      else if (next === undefined) throw new Error(`--${key} needs a value`);
      else { opt[key] = next; i++; }
    } else pos.push(a);
  }
  return { pos, opt };
}

// ---- herdr state ----

const run = (cmd, args, input) => execFileSync(cmd, args, { encoding: "utf8", input, maxBuffer: 64 * 2 ** 20, windowsHide: true });
const appDo = (command, args = {}) => {
  const out = run("herdr-app", ["do", command, JSON.stringify(args)]);
  try { return JSON.parse(out); } catch { return { raw: out }; }
};
const shared = () => { try { return JSON.parse(readFileSync(join(HOME, "shared.json"), "utf8")); } catch { return {}; } };

function state() {
  const app = JSON.parse(run("herdr-app", ["ls"]));
  const hc = JSON.parse(run("hc", ["ls", "--json"])).terminals ?? [];
  const byAddress = new Map(hc.map((t) => [t.address, t]));
  const s = shared();
  const roots = Array.isArray(s.roots) && s.roots.length ? s.roots : [{ id: "r-dev", name: "dev", folder: join(homedir(), "Desktop", "dev") }];
  const rootOf = s["space.root"] ?? {};
  const locked = s["space.locked"] ?? {};
  const spaces = app.spaces.map((sp, i) => ({
    id: sp.id, name: sp.name, folder: sp.folder, active: sp.active, index: i + 1,
    root: roots.find((r) => r.id === rootOf[sp.id]) ?? roots[0], locked: Boolean(locked[sp.id]),
    tabs: sp.tabs.map((tab, j) => ({
      id: tab.id, name: tab.name, active: tab.active, index: j + 1,
      terminals: tab.terminals.map((x) => {
        const h = byAddress.get(x.terminal) ?? {};
        return { address: x.terminal, pane: x.pane, agent: h.agent ?? null, status: h.status ?? x.status ?? null, turn: h.turn ?? null, cwd: h.cwd ?? null };
      }),
    })),
  }));
  // Sub-agents without a pane hang under their parent's tab.
  for (const h of hc) {
    if (!h.parent || spaces.some((sp) => sp.tabs.some((t) => t.terminals.some((x) => x.address === h.address)))) continue;
    for (const sp of spaces) for (const t of sp.tabs) if (t.terminals.some((x) => x.address === h.parent)) {
      t.terminals.push({ address: h.address, pane: null, agent: h.agent ?? null, status: h.status ?? null, turn: h.turn ?? null, cwd: h.cwd ?? null, parent: h.parent });
    }
  }
  return { roots, spaces, hc: byAddress };
}

const isAgent = (x) => Boolean(x.agent && !SHELLS.test(x.agent)) || Boolean(x.status);

// ---- names ----

function pick(kind, query, items, keys) {
  const q = String(query).trim().toLowerCase();
  const exact = items.filter((it) => keys(it).some((k) => k && String(k).toLowerCase() === q));
  if (exact.length === 1) return exact[0];
  const key = TICKET.exec(query)?.[1]?.toLowerCase();
  const byKey = key ? items.filter((it) => keys(it).some((k) => String(k ?? "").toLowerCase().includes(key))) : [];
  if (byKey.length === 1) return byKey[0];
  const partial = items.filter((it) => keys(it).some((k) => k && String(k).toLowerCase().includes(q)));
  if (partial.length === 1) return partial[0];
  const found = exact.length ? exact : byKey.length ? byKey : partial;
  if (!found.length) throw new Error(`no ${kind} matches "${query}"`);
  throw new Error(`"${query}" matches ${found.length} ${kind}s: ${found.map((it) => keys(it)[0]).join(", ")}; use an id`);
}

const findRoot = (st, q) => pick("workspace", q, st.roots, (r) => [r.name, r.id, r.folder]);
const findSpace = (st, q) => pick("dev workspace", q, st.spaces, (s) => [s.name, s.id, String(s.index)]);

// "space/tab", a tab id, or a space (its active tab).
function findTab(st, q) {
  for (const sp of st.spaces) for (const t of sp.tabs) if (t.id === q) return { space: sp, tab: t };
  const [sq, tq] = splitTarget(q);
  const space = findSpace(st, sq);
  const tab = tq ? pick("tab", tq, space.tabs, (t) => [t.name, t.id, String(t.index)]) : space.tabs.find((t) => t.active) ?? space.tabs[0];
  if (!tab) throw new Error(`${space.name} has no tabs`);
  return { space, tab };
}

const splitTarget = (q) => { const i = q.lastIndexOf("/"); return i > 0 ? [q.slice(0, i), q.slice(i + 1)] : [q, null]; };

// A terminal address, or the agent of a space or space/tab (its first agent terminal, else its
// first terminal: a shell-only tab is still a target).
function findAgent(st, q) {
  if (st.hc.has(q)) return { address: q, ...where(st, q), agent: isAgent({ agent: st.hc.get(q).agent, status: st.hc.get(q).status }) };
  const [sq, tq] = splitTarget(q);
  const space = findSpace(st, sq);
  const tabs = tq ? [pick("tab", tq, space.tabs, (t) => [t.name, t.id, String(t.index)])] : space.tabs;
  for (const tab of tabs) {
    const agent = tab.terminals.find((x) => !x.parent && isAgent(x)) ?? tab.terminals.find(isAgent);
    if (agent) return { address: agent.address, space, tab, agent: true };
  }
  const first = tabs.flatMap((tab) => tab.terminals.map((x) => ({ x, tab })))[0];
  if (first) return { address: first.x.address, space, tab: first.tab };
  throw new Error(`no terminal in ${space.name}${tq ? `/${tq}` : ""}`);
}

function where(st, address) {
  for (const space of st.spaces) for (const tab of space.tabs) if (tab.terminals.some((x) => x.address === address)) return { space, tab };
  return { space: null, tab: null };
}

const me = (st) => (process.env.HC_TERMINAL_ID ? { address: process.env.HC_TERMINAL_ID, ...where(st, process.env.HC_TERMINAL_ID) } : null);

// ---- bridge (workspace changes go through the space-tabs mod) ----

async function bridge(op) {
  mkdirSync(BRIDGE, { recursive: true });
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const req = join(BRIDGE, `req-${id}.json`), res = join(BRIDGE, `res-${id}.json`);
  writeFileSync(req, JSON.stringify(op));
  const end = Date.now() + BRIDGE_TIMEOUT_MS;
  try {
    while (Date.now() < end) {
      if (existsSync(res)) {
        const answer = JSON.parse(readFileSync(res, "utf8"));
        if (answer.ok === true) return answer.result;
        if (answer.ok === false) throw new Error(answer.error);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("herdr-app did not answer: is it running with the space-tabs mod in its layout?");
  } finally {
    rmSync(req, { force: true });
    rmSync(res, { force: true });
  }
}

// Workspace changes reach shared.json a moment after the bridge answers.
async function settle(test) {
  for (let i = 0; i < 30; i++) { if (test(state())) return; await new Promise((r) => setTimeout(r, 100)); }
}

// ---- background opens: keep the person's view where it was ----

function keepView(st, show, fn) {
  const space = st.spaces.find((s) => s.active);
  const tab = space?.tabs.find((t) => t.active);
  const out = fn();
  if (!show && space) {
    appDo("space.select", { id: space.id });
    if (tab) appDo("tab.select", { id: tab.id });
  }
  return out;
}

const agentArgv = (opt) => {
  const cmd = opt.agent ?? (opt.task ? "claude" : null);
  return cmd ? cmd.match(/"[^"]*"|\S+/g).map((w) => w.replace(/^"|"$/g, "")) : undefined;
};

// ---- Claude replies (for ask) ----

function transcriptOf(session) {
  if (!session || !existsSync(PROJECTS)) return null;
  for (const dir of readdirSync(PROJECTS)) {
    const p = join(PROJECTS, dir, `${session}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

const textOf = (content) => (typeof content === "string" ? content
  : Array.isArray(content) ? content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : "");

// The agent's text after the last prompt that contains `sent`.
function replyAfter(path, sent) {
  const lines = readFileSync(path, "utf8").split("\n");
  const probe = sent.trim().slice(0, 60);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"type":"user"')) continue;
    try { const e = JSON.parse(lines[i]); if (textOf(e.message?.content).includes(probe)) { start = i; break; } } catch {}
  }
  if (start < 0) return null;
  const out = [];
  for (const line of lines.slice(start + 1)) {
    try { const e = JSON.parse(line); if (e.type === "assistant") { const t = textOf(e.message?.content).trim(); if (t) out.push(t); } } catch {}
  }
  return out.join("\n\n");
}

// ---- output ----

const print = (opt, data, text) => process.stdout.write(`${opt.json ? JSON.stringify(data, null, 2) : text}\n`);

function lsText(st) {
  const lines = [];
  for (const root of st.roots) {
    lines.push(`${root.name}  (workspace ${root.id}, ${root.folder})`);
    for (const sp of st.spaces.filter((s) => s.root.id === root.id)) {
      lines.push(`  ${sp.active ? "*" : " "} ${sp.name}${sp.locked ? " [locked]" : ""}  (${sp.id})`);
      for (const tab of sp.tabs) {
        lines.push(`      ${tab.active ? ">" : " "} ${tab.name}  (${tab.id})`);
        for (const x of tab.terminals) lines.push(`          ${x.address}  ${x.agent ?? "?"}  ${x.status ?? "-"}${x.parent ? `  sub-agent of ${x.parent}` : ""}`);
      }
    }
  }
  return lines.join("\n");
}

// ---- commands ----

const need = (v, what) => { if (v === undefined || v === "") throw new Error(`missing ${what} (hx help)`); return v; };

async function main(argv) {
  const { pos, opt } = parseArgs(argv);
  const [cmd, sub, ...rest] = pos;
  if (!cmd || cmd === "help" || opt.help) return print({}, null, USAGE);
  const st = state();

  if (cmd === "ls") return print(opt, st.roots.map((r) => ({ ...r, spaces: st.spaces.filter((s) => s.root.id === r.id).map(({ root, ...s }) => s) })), lsText(st));

  if (cmd === "whoami") {
    const m = me(st);
    if (!m?.space) throw new Error("not inside a herdr terminal (HC_TERMINAL_ID is not set, or its pane is gone)");
    const data = { terminal: m.address, tab: { id: m.tab.id, name: m.tab.name }, space: { id: m.space.id, name: m.space.name }, workspace: { id: m.space.root.id, name: m.space.root.name } };
    return print(opt, data, `${m.address} in ${m.space.root.name} / ${m.space.name} / ${m.tab.name}`);
  }

  if (cmd === "ws") {
    if (sub === "ls" || !sub) return print(opt, st.roots, st.roots.map((r) => `${r.name}  ${r.id}  ${r.folder}  (${st.spaces.filter((s) => s.root.id === r.id).length} dev workspaces)`).join("\n"));
    if (sub === "new") {
      const name = need(rest[0], "a name");
      const folder = need(opt.folder, "--folder");
      if (!existsSync(folder)) throw new Error(`no folder ${folder}`);
      const r = await bridge({ op: "root.add", name, folder, color: opt.color });
      await settle((s) => s.roots.some((x) => x.id === r.id));
      return print(opt, r, `workspace ${name} (${r.id})`);
    }
    if (sub === "rename") {
      const root = findRoot(st, need(rest[0], "a workspace"));
      await bridge({ op: "root.update", id: root.id, name: need(rest[1], "a new name") });
      return print(opt, { id: root.id }, `renamed ${root.name} to ${rest[1]}`);
    }
    if (sub === "rm") {
      const root = findRoot(st, need(rest[0], "a workspace"));
      const inside = st.spaces.filter((s) => s.root.id === root.id);
      if (inside.length && !opt.force) throw new Refused(`${root.name} still has ${inside.length} dev workspaces (${inside.map((s) => s.name).join(", ")}); --force removes it and they regroup by folder`);
      await bridge({ op: "root.remove", id: root.id });
      return print(opt, { id: root.id }, `removed workspace ${root.name}`);
    }
    throw new Error(`unknown: hx ws ${sub}`);
  }

  if (cmd === "space") {
    if (sub === "new") {
      const name = need(rest[0], "a name");
      const root = opt.ws ? findRoot(st, opt.ws) : (me(st)?.space?.root ?? st.roots[0]);
      const folder = opt.folder ?? root.folder;
      const out = keepView(st, opt.show, () => appDo("space.new", { name, folder, tab: opt.tab, argv: agentArgv(opt), task: opt.task }));
      if (!out.space) throw new Error(`space.new failed: ${JSON.stringify(out)}`);
      await bridge({ op: "space.root", space: out.space, root: root.id });
      return print(opt, { ...out, workspace: root.id }, `dev workspace ${name} (${out.space}) in ${root.name}; terminal ${out.terminal}`);
    }
    const space = findSpace(st, need(rest[0], "a dev workspace"));
    if (sub === "rename") {
      appDo("space.rename", { id: space.id, name: need(rest[1], "a new name") });
      return print(opt, { id: space.id }, `renamed ${space.name} to ${rest[1]}`);
    }
    if (sub === "move") {
      const root = findRoot(st, need(opt.ws, "--ws"));
      await bridge({ op: "space.root", space: space.id, root: root.id });
      return print(opt, { id: space.id, workspace: root.id }, `moved ${space.name} to ${root.name}`);
    }
    if (sub === "rm") {
      if (!opt.force) {
        if (space.locked) throw new Refused(`${space.name} is locked; unlock it in the sidebar or use --force`);
        if (me(st)?.space?.id === space.id) throw new Refused(`${space.name} is your own dev workspace; use --force to close it anyway`);
        const busy = space.tabs.flatMap((t) => t.terminals).filter((x) => x.status === "working");
        if (busy.length) throw new Refused(`${space.name} has working agents (${busy.map((x) => x.address).join(", ")}); use --force`);
      }
      appDo("space.close", { id: space.id, confirmed: true });
      return print(opt, { id: space.id }, `closed ${space.name}`);
    }
    throw new Error(`unknown: hx space ${sub}`);
  }

  if (cmd === "tab") {
    if (sub === "new") {
      const space = findSpace(st, need(rest[0], "a dev workspace"));
      const out = keepView(st, opt.show, () => appDo("tab.new", { space: space.id, name: opt.name, folder: opt.folder ?? space.folder, argv: agentArgv(opt), task: opt.task }));
      return print(opt, out, `tab ${out.tab ?? "?"} in ${space.name}; terminal ${out.terminal ?? "?"}`);
    }
    const { space, tab } = findTab(st, need(rest[0], "a space/tab"));
    if (sub === "rename") {
      appDo("tab.rename", { id: tab.id, name: need(rest[1], "a new name") });
      return print(opt, { id: tab.id }, `renamed ${space.name}/${tab.name} to ${rest[1]}`);
    }
    if (sub === "rm") {
      if (!opt.force) {
        if (space.locked) throw new Refused(`${space.name} is locked; use --force`);
        if (me(st)?.tab?.id === tab.id) throw new Refused("that is your own tab; use --force");
        const busy = tab.terminals.filter((x) => x.status === "working");
        if (busy.length) throw new Refused(`${space.name}/${tab.name} has working agents (${busy.map((x) => x.address).join(", ")}); use --force`);
      }
      appDo("tab.close", { id: tab.id, confirmed: true });
      return print(opt, { id: tab.id }, `closed ${space.name}/${tab.name}`);
    }
    throw new Error(`unknown: hx tab ${sub}`);
  }

  if (["send", "ask", "read", "wait"].includes(cmd)) {
    const target = findAgent(st, need(sub, "a target"));
    if (cmd !== "read" && target.address === process.env.HC_TERMINAL_ID) throw new Refused("that is you");
    const label = target.space ? `${target.space.name}/${target.tab.name} (${target.address})` : target.address;
    if (cmd === "read") return process.stdout.write(run("hc", ["read", target.address, "--lines", String(opt.lines ?? 0)]));
    if (cmd === "wait") {
      const out = run("hc", ["wait", target.address, "--json", ...(opt.timeout ? ["--timeout", String(opt.timeout)] : [])]);
      return print(opt, JSON.parse(out || "{}"), out.trim());
    }
    if (cmd === "ask" && !target.agent) throw new Refused(`${label} is not an agent (a shell never ends a turn): use hx send, then hx read`);
    const text = need(rest.join(" "), "the text to send");
    run("hc", ["send", ...(opt.force ? ["--force"] : []), target.address, text]);
    if (cmd === "send") return print(opt, { sent: target.address }, `sent to ${label}`);
    // ask: wait for the turn, then the reply from the Claude transcript, else the screen.
    const waited = JSON.parse(run("hc", ["wait", target.address, "--json", ...(opt.timeout ? ["--timeout", String(opt.timeout)] : [])]) || "{}");
    const session = JSON.parse(run("hc", ["get", target.address, "--json"])).labels?.["claude.session"];
    const path = transcriptOf(session);
    // The turn can end a moment before its reply is written to the transcript.
    let reply = null;
    for (let i = 0; path && !reply && i < 50; i++) { reply = replyAfter(path, text); if (!reply) await new Promise((r) => setTimeout(r, 100)); }
    reply ||= JSON.parse(run("hc", ["read", target.address, "--json", "--lines", "60"])).text;
    return print(opt, { target: target.address, wait: waited, reply }, reply);
  }

  throw new Error(`unknown command: ${cmd} (hx help)`);
}

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`hx: ${e.message}\n`);
  process.exit(e instanceof Refused ? 2 : 1);
});
