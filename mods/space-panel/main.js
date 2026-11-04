// The selected root workspace's dev workspaces as Orca-style cards. A dev workspace is a herdr
// space: its tabs (agents, terminals, files) are its children. Expanded, a card shows every tab
// with sub-agents nested; collapsed, it shows the title, folder and the latest agent.
// The root grouping comes from space-tabs (shared "roots" / "space.root").

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, agents, terminals, panes, run, theme, shared, setShared, setAgentOrder, knownAgents, props, openOverlay, closeOverlay, exec, home, appHome, readTextFile, writeTextFile } from "herdr";
import { fileIcon, isLight } from "./file-icons/icons.js";
import { NAMES, nameOf, ICON_LAST, iconBox } from "./pokemon-names.js";

// ---- A Pokémon per dev workspace, after mathieucroset/herdr-pokemon-agents (MIT) ----
// Its menu icons (PokeAPI, gen VII, 40x30) are downloaded on first use into the herdr-app home;
// none ship with this mod. A new dev workspace gets a random Pokémon nobody else has, saved so it
// stays; the Edit dialog (space-new) picks another. Saved in shared "space.pokemon" { spaceId: dex }.
const POKEMON = "space.pokemon";
const POKEMON_DIR = "data/pokemon-icons";
const SPRITES = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites";
// Menu icons up to #809, then the 96x96 front sprites (no icons exist past Gen 7).
const iconUrl = (id) => (id <= ICON_LAST ? `${SPRITES}/pokemon/versions/generation-vii/icons/${id}.png` : `${SPRITES}/pokemon/${id}.png`);
const POKEMON_COUNT = NAMES.length;
const POKEMON_READY = "ready-3"; // 2 added the Poké Ball, 3 every Pokémon: older downloads are completed once
const POKEMON_BATCH = 150; // files per curl call, under herdr's 30 s exec limit

// Saved picks first; a new dev workspace gets a random Pokémon that no other one has.
function pokemonFor(ids) {
  const saved = shared(POKEMON) ?? {};
  const fresh = {};
  const used = new Set(Object.values(saved));
  for (const id of ids) {
    if (saved[id]) continue;
    const free = NAMES.map((_, i) => i + 1).filter((n) => !used.has(n));
    const n = free.length ? free[Math.floor(Math.random() * free.length)] : Math.floor(Math.random() * POKEMON_COUNT) + 1;
    fresh[id] = n;
    used.add(n);
  }
  if (Object.keys(fresh).length) setShared(POKEMON, { ...saved, ...fresh });
  return { ...saved, ...fresh };
}

async function ensurePokemonIcons() {
  const dir = `${appHome()}/${POKEMON_DIR}`;
  if (await readTextFile(`${dir}/${POKEMON_READY}`).catch(() => null)) return makeBallFrames(dir);
  const files = [];
  for (let id = 1; id <= POKEMON_COUNT; id++) files.push([`${dir}/${id}.png`, iconUrl(id)]);
  for (let i = 0; i < files.length; i += POKEMON_BATCH) {
    const args = ["-sfL", "--retry", "2", "--connect-timeout", "10", "--parallel", "--parallel-max", "16", "--create-dirs"];
    for (const [file, url] of files.slice(i, i + POKEMON_BATCH)) args.push("-o", file, url);
    const r = await exec("curl", args).catch(() => null);
    if (r?.code !== 0) return false;
  }
  await writeTextFile(`${dir}/${POKEMON_READY}`, String(Date.now()), null).catch(() => null);
  return makeBallFrames(dir);
}

// The card's Poké Ball: PokeAPI's poke-ball item sprite (a three-quarter view), downloaded on
// first use. Still when idle; open when an agent needs input; while a dev workspace works it rocks
// one way on its base, rocks the other way, then bounces once (squash, stretch, a shadow), and
// repeats. herdr can only spin an svg, so pokeball-anim.ps1 draws the 24x32 frames once and the
// card swaps them on a timer (see init). Without the sprite, the script draws a flat pixel ball.
const BALL_TICK_MS = 70;
const BALL_FRAMES = 22;
const BALL_SPRITE = `${POKEMON_DIR}/pokeball.png`;
const BALL_SPRITE_URL = `${SPRITES}/items/poke-ball.png`;
// herdr caches images by path, so the version is in every frame's name: bump it whenever the
// motion or the ball changes, or the cards keep showing the old frames.
const BALL_VERSION = "8"; // 5 open ball, 6 shell spin, 7 vertical axis, 8 stays round (the button turns)
const BALL_STILL = `${POKEMON_DIR}/pokeball-v${BALL_VERSION}-still.png`;
const BALL_OPEN = `${POKEMON_DIR}/pokeball-v${BALL_VERSION}-open.png`;
const ballFrame = (tick) => `${POKEMON_DIR}/pokeball-v${BALL_VERSION}-c${tick % BALL_FRAMES}.png`;
// An agent with a shell still running: a full turn in 12 frames, then 6 frames of pause.
const SPIN_FRAMES = 18;
const spinFrame = (tick) => `${POKEMON_DIR}/pokeball-v${BALL_VERSION}-s${tick % SPIN_FRAMES}.png`;

async function makeBallFrames(dir) {
  if (await readTextFile(`${dir}/pokeball-v${BALL_VERSION}-ready`).catch(() => null)) return true;
  const sprite = `${appHome()}/${BALL_SPRITE}`;
  if (!(await readTextFile(sprite).catch(() => null))) {
    await exec("curl", ["-sfL", "--retry", "2", "--create-dirs", "-o", sprite, BALL_SPRITE_URL]).catch(() => null);
  }
  await exec("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    `${appHome()}/mods/space-panel/pokeball-anim.ps1`, "-Dir", dir, "-Version", BALL_VERSION, "-Sprite", sprite]).catch(() => null);
  return true;
}

// The Jira and GitHub marks (Simple Icons, CC0), as in the Tasks board (mods/tasks/brand.js).
const JIRA = "mods/file-icons/brand/jira.svg";
const GITHUB = "mods/file-icons/brand/github.svg";
const JIRA_BLUE = "#2684FF";
// Locked dev workspaces, set from the card menu (menu-spaces): no close, no moving tabs out.
const LOCKED = "space.locked";
const isLocked = (id) => Boolean((shared(LOCKED) ?? {})[id]);
// A confirmed tab move, posted by the confirm popup (its own instance) to the sidebar.
const MOVE_REQUEST = "space-panel.move";
const DRAG_START_PX = 6;
const AGENT_POLL_MS = 5000;
// { paneId: agentId } written by each agent-view tab, so a click focuses an open one.
const AGENT_TABS = "agent.tabs";
// { paneId: { path, id, type, description } }: which agent each agent-view tab shows.
const AGENT_VIEW = "agent.view";
// Tickets and PRs the dev workspace's Claude sessions work on (see pollWork).
const WORK = "space.work";
const WORK_POLL_MS = 20000;
const uniqueBy = (list, keyOf) => list.filter((x, i) => x && list.findIndex((y) => y && keyOf(y) === keyOf(x)) === i);

// Every target opens as its own tab in the Tasks board; with none, the board opens on a list.
function openAll(_cx, targets, fallback) {
  openTask(targets.length ? { targets } : fallback);
}
function setLocked(id, on) {
  const all = { ...(shared(LOCKED) ?? {}) };
  if (on) all[id] = true; else delete all[id];
  setShared(LOCKED, all);
}
// A name from workspace-chrome, "jira" / "github" (a dev workspace's icon choice), or a full path.
const ICON = (name) => (name === "jira" ? JIRA : name === "github" ? GITHUB : name.includes("/") ? name : `mods/workspace-chrome/${name}.svg`);
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const TICKET_KEY = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]+-\d+)/i;
// The Tasks board's single-board lease and request (see mods/tasks/main.js).
const BOARD_LEASE_MS = 40000;

function ago(ms) {
  if (!ms) return "";
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const basename = (path) => (path ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
const fillOf = (t, color) => (color?.startsWith("#") ? color : (MARK[color] ?? t[color] ?? MARK.ansi6));

// Opens the Tasks board on a ticket, a PR, or one of its tabs, reusing an open board.
function openTask(target) {
  const open = Date.now() - (shared("tasks.board")?.at ?? 0) < BOARD_LEASE_MS;
  setShared("tasks.request", { target, at: Date.now() });
  if (!open) run("mod.open", { name: "tasks" });
}

// What a child row's right-click menu offers. m: { tab, name, split } for a tab,
// { pane } for one pane of a split tab, { terminal, pane? } for a sub-agent.
function rowActions(m) {
  if (m.tab) return [
    { id: "rename", label: "Rename…", icon: "square-pen" },
    { id: "close", label: m.split ? "Close tab and its panes" : "Close", icon: "x", run: () => run("tab.close", { id: m.tab }) },
  ];
  if (m.terminal) return [
    ...(m.pane ? [{ id: "hide", label: "Hide pane (keeps running)", icon: "minus", run: () => run("terminal.park", { terminal: m.terminal }) }] : []),
    { id: "kill", label: "End sub-agent", icon: "x", run: () => run("terminal.kill", { terminal: m.terminal }) },
  ];
  return [{ id: "close", label: "Close pane", icon: "x", run: () => run("pane.close", { pane: m.pane }) }];
}

// A file tab's icon: its file's VS Code icon, or the files icon for a folder browser.
function fileProgram(pane, label, light) {
  const file = (shared("file.tabs") ?? {})[pane.pane]?.file ?? (/\.[^.]+$/.test(label ?? "") ? label : null);
  return file ? { icon: fileIcon(file, light), tint: false } : { icon: ICON("files"), tint: true };
}

// Claude started from a shell reports itself (OSC 7501) only while it works, so its pane shows
// the shell. The herdr-resume hook labels the terminal claude.session from start to exit.
const CLAUDE = { key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: false, tile: null, color: null, shell: false, agent: true };
function withClaude(list, all) {
  const marked = new Set(all.filter((x) => x.labels?.["claude.session"]).map((x) => x.address));
  return list.map((p) => (p.program?.shell && marked.has(p.terminal) ? { ...p, program: CLAUDE } : p));
}

function programIcon(p, color) {
  if (!p?.icon) return svg(ICON("terminal")).size(14).flex_none().text_color(color);
  return p.tint ? svg(p.icon).size(14).flex_none().text_color(color) : image(p.icon).w(14).h(14).flex_none();
}

// Shells an agent started that are still running after its turn ended (a background command, a
// dev server): herdr then reports done or idle, but work is still going on. Found by process tree
// under each agent's terminal. Left out: the agent's own children from its first minute (MCP
// servers), the status-line script, and anything younger than 3 s (hooks, quick commands).
const SHELLS = new Set(["bash.exe", "sh.exe", "cmd.exe", "powershell.exe", "pwsh.exe"]);
// Each scan starts a PowerShell, which takes seconds on a busy laptop, so it runs rarely.
const SHELL_POLL_MS = 15000;
// Lists only shells and the terminals' direct children (the agents); every process with its
// command line takes seconds.
const psTree = (pids) => "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $now = Get-Date; "
  + `$f = "Name='bash.exe' OR Name='sh.exe' OR Name='cmd.exe' OR Name='powershell.exe' OR Name='pwsh.exe' OR ${pids.map((p) => `ParentProcessId=${Number(p)}`).join(" OR ")}"; `
  + "@(Get-CimInstance Win32_Process -Filter $f -Property ProcessId,ParentProcessId,Name,CreationDate,CommandLine | ForEach-Object { "
  + "@{ id = $_.ProcessId; parent = $_.ParentProcessId; name = $_.Name; age = [int](($now - $_.CreationDate).TotalSeconds); cmd = [string]$_.CommandLine } }) | ConvertTo-Json -Compress";

async function agentShells(roots) {
  const r = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", psTree(roots.map((x) => x.pid))]).catch(() => null);
  if (r?.code !== 0) return null;
  const procs = JSON.parse(r.stdout || "[]");
  const kids = new Map();
  for (const p of procs) kids.set(p.parent, [...(kids.get(p.parent) ?? []), p]);
  const found = new Map();
  for (const { address, pid } of roots) {
    // depth 1 is the agent program under the terminal's shell; its shells sit below it.
    for (const agent of kids.get(pid) ?? []) {
      const stack = [...(kids.get(agent.id) ?? [])];
      const shells = [];
      while (stack.length) {
        const p = stack.pop();
        const name = p.name.toLowerCase();
        if (SHELLS.has(name) && p.age >= 3 && agent.age - p.age >= 60 && !/statusline/i.test(p.cmd)) { shells.push(p); continue; }
        stack.push(...(kids.get(p.id) ?? []));
      }
      if (shells.length) {
        const newest = shells.sort((a, b) => a.age - b.age)[0];
        found.set(address, { count: shells.length, cmd: newest.cmd.replace(/\s+/g, " ").slice(0, 160) });
      }
    }
  }
  return found;
}

function statusIcon(t, status, shell) {
  if (!status) return div().w(12).flex_none();
  if (shell && status !== "working" && status !== "blocked" && status !== "error") return svg(ICON("terminal")).size(12).flex_none().text_color(t.working);
  if (status === "working") return svg(ICON("spinner")).size(12).flex_none().text_color(t.working).spin(900);
  if (status === "blocked" || status === "error") return div().w(12).flex_none().text_size(11).text_color(t.blocked).child("●");
  if (status === "done") return svg(ICON("circle-check")).size(12).flex_none().text_color(t.done);
  return svg(ICON("circle-check")).size(12).flex_none().text_color(t.dim);
}

export default class DevWorkspaces extends View {
  init(_props, cx) {
    this.expanded = new Map(); // spaceId -> true/false, set by the card's chevron
    this.agentChoices = [];
    this.drag = null; // { tab, space, name, label } while a tab row is held down
    this.dropTarget = null; // the card under the pointer during a drag
    // A press arms a drag; it starts only once the pointer moves. Selecting a dev workspace
    // reflows the cards, so a plain click could otherwise release on another card and move.
    this.press = null; // { x, y } of the press
    this.moved = false;
    this.lastMove = Number(shared(MOVE_REQUEST)?.at ?? 0);
    this.pending = []; // after a move: [{ terminal, name, at }] to rename, [{ tab, at }] to close
    if (props()?.moveConfirm) {
      this.handle = cx.focus_handle();
      this.handle.focus();
      return;
    }
    const menu = props()?.rowMenu;
    if (menu) {
      this.renaming = false;
      this.handle = cx.focus_handle();
      this.newName = InputState.new({ value: menu.name ?? "", placeholder: "Empty: called by its number" });
      this.newName.on("submit", () => this.rename());
      return;
    }
    cx.spawn(async (cx) => {
      try { this.agentChoices = (await knownAgents()).filter((a) => a.installed); } catch {}
      cx.notify();
    });
    // Repaints the "3h" times; live data re-renders by itself.
    cx.timer.every(30000, (cx) => cx.notify());
    // Steps a tab move along (see settle) without waiting for the next live update.
    cx.timer.every(200, (cx) => { if (this.pending.length) cx.notify(); });
    this.shells = new Map(); // terminal address -> { count, cmd }
    cx.timer.every(SHELL_POLL_MS, (cx) => this.pollShells(cx));
    this.pokemonReady = false;
    cx.spawn(async (cx) => { this.pokemonReady = await ensurePokemonIcons(); cx.notify(); });
    // Steps the Poké Ball animations; redraws only while some dev workspace is working or has a
    // shell running. One tick serves both cycles (22 and 18 frames).
    this.ballTick = 0;
    this.anyWorking = false;
    cx.timer.every(BALL_TICK_MS, (cx) => {
      if (!(this.anyWorking || this.shells.size) || !this.pokemonReady) return;
      this.ballTick = (this.ballTick + 1) % (BALL_FRAMES * SPIN_FRAMES);
      cx.notify();
    });
    cx.timer.every(WORK_POLL_MS, (cx) => this.pollWork(cx));
    this.pollWork(cx);
    this.subagents = new Map(); // claude session id -> its subagents (scan-agents.mjs)
    cx.timer.every(AGENT_POLL_MS, (cx) => this.pollAgents(cx));
    this.pollAgents(cx);
  }

  // Only agents that are not working can be hiding a running shell, so skip the scan when none is.
  pollShells(cx) {
    if (this.polling) return;
    const roots = terminals().filter((x) => x.state === "live" && x.pid && (x.status?.state ?? x.status) !== "working")
      .filter((x) => x.status?.app || x.reported).map((x) => ({ address: x.address, pid: x.pid }));
    if (!roots.length) { if (this.shells.size) { this.shells = new Map(); cx.notify(); } return; }
    this.polling = true;
    cx.spawn(async (cx) => {
      try {
        const found = await agentShells(roots);
        if (found && JSON.stringify([...found]) !== JSON.stringify([...this.shells])) { this.shells = found; cx.notify(); }
      } finally { this.polling = false; }
    });
  }

  // tint: the icon's own colour when enabled (the Jira mark's blue); a disabled one stays dim.
  iconButton(t, id, iconName, tip, onClick, enabled = true, tint = null, count = 0) {
    return h_flex().id(id).p(3).gap(2).items_center().rounded(5).flex_none().text_color(enabled ? tint ?? t.foreground : t.dim).cursor_pointer().tooltip(tip)
      .hover((s) => s.bg(t.hover).text_color(tint ?? t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(svg(ICON(iconName)).size(13))
      .when(count > 1, (el) => el.child(div().text_size(10).font_semibold().text_color(t.muted).child(String(count))));
  }

  // Subagents run inside their Claude process, so herdr has no terminal for them; Claude Code's
  // transcripts beside each session say which run and what they do (scan-agents.mjs).
  pollAgents(cx) {
    if (this.agentScan) return;
    const sessions = [...new Set(terminals().map((x) => x.labels?.["claude.session"]).filter(Boolean))];
    if (!sessions.length) { if (this.subagents.size) { this.subagents = new Map(); cx.notify(); } return; }
    this.agentScan = true;
    cx.spawn(async (cx) => {
      try {
        const res = await exec("node", [`${home()}/.config/herdr-app/mods/space-panel/scan-agents.mjs`, ...sessions]);
        const next = new Map(Object.entries(JSON.parse(res.stdout || "{}")).filter(([, list]) => list.length));
        if (JSON.stringify([...next]) !== JSON.stringify([...this.subagents])) { this.subagents = next; cx.notify(); }
      } catch {} finally { this.agentScan = false; }
    });
  }

  // A subagent shows in its dev workspace's one agent tab (mod agent-view): the tab is reused and
  // pointed at this agent (shared "agent.view"), and made only when the workspace has none.
  openAgent(space, a, viewer) {
    const target = { path: a.path, id: a.id, type: a.type, description: a.description };
    const name = (a.description || a.type).slice(0, 40);
    run("space.select", { id: space.id });
    if (!viewer) { run("tab.new", { space: space.id, mod: "agent-view", name, props: target }); return; }
    setShared(AGENT_VIEW, { ...(shared(AGENT_VIEW) ?? {}), [viewer.pane]: target });
    run("tab.rename", { id: viewer.tab, name });
    run("tab.select", { id: viewer.tab });
    run("pane.focus", { pane: viewer.pane });
  }

  // Each live Claude session's tickets and PRs (scan-work.mjs reads its transcript), filed under
  // the dev workspace its pane is in. A session that ended (or was cleared) keeps its finds there,
  // in shared "space.work", until that dev workspace closes.
  pollWork(cx) {
    if (this.scanning) return;
    const tabSpace = new Map(spaces().flatMap((s) => s.tabs.map((tab) => [tab.id, s.id])));
    const paneOf = new Map(panes().filter((p) => p.terminal).map((p) => [p.terminal, p]));
    const live = new Map();
    for (const x of terminals()) {
      const sid = x.labels?.["claude.session"];
      const space = tabSpace.get(paneOf.get(x.address)?.tab);
      if (sid && space) live.set(sid, space);
    }
    if (!live.size) return;
    this.scanning = true;
    cx.spawn(async (cx) => {
      try {
        const res = await exec("node", [`${home()}/.config/herdr-app/mods/space-panel/scan-work.mjs`, ...live.keys()]);
        const found = JSON.parse(res.stdout || "{}");
        const known = new Set(spaces().map((s) => s.id));
        const sessions = Object.fromEntries(Object.entries(shared(WORK)?.sessions ?? {}).filter(([, w]) => known.has(w.space)));
        for (const [sid, space] of live) {
          sessions[sid] = { space, tickets: found[sid]?.tickets ?? [], prs: found[sid]?.prs ?? [], worktrees: found[sid]?.worktrees ?? [] };
        }
        const next = { sessions };
        if (JSON.stringify(next) !== JSON.stringify(shared(WORK) ?? {})) { setShared(WORK, next); cx.notify(); }
      } catch {} finally { this.scanning = false; }
    });
  }

  // One child row: status, program icon, bold name, " - latest message" dim, age on the right.
  row(t, r) {
    return h_flex().id(r.id).pl(6 + r.depth * 16).pr(6).h(26).flex_none().gap(6).items_center().rounded(6)
      .cursor_pointer().when(r.focused, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); r.onClick(cx); })
      .when(Boolean(r.drag), (el) => el
        .when(this.moved && this.drag?.tab === r.drag.tab && this.dropTarget && this.dropTarget !== r.drag.space, (el) => el.opacity(0.5))
        .on_mouse_down("left", (e) => { this.drag = r.drag; this.dropTarget = null; this.arm(e); }))
      .when(Boolean(r.menu), (el) => el.on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "space-panel", kind: "popup", width: 230, height: 44 + 30 * rowActions(r.menu).length, props: { rowMenu: r.menu } });
      }))
      .when(r.depth > 0, (el) => el.child(div().w(8).h(12).mt(-6).flex_none().border_l(1.5).border_b(1.5).rounded_bl(5).border_color(t.input)))
      .when(Boolean(r.shell), (el) => el.tooltip(`Running ${r.shell.count > 1 ? `${r.shell.count} shells` : "a shell"}: ${r.shell.cmd}`))
      .child(statusIcon(t, r.status, r.shell))
      .child(programIcon(r.program, t.foreground))
      .child(h_flex().flex_1().min_w(0).gap(4).items_center().text_size(12.5)
        .child(div().flex_none().max_w(140).truncate().font_semibold().text_color(t.foreground).child(r.name))
        .when(Boolean(r.msg), (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`- ${r.msg}`))))
      .when(Boolean(r.mark), (el) => el.child(div().flex_none().text_size(11).font_semibold()
        .text_color(r.mark === "M" ? t.ansi3 : r.mark === "A" ? t.ansi2 : t.ansi1).tooltip("Git status").child(r.mark)))
      .when(Boolean(r.at), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(r.at))));
  }

  // A space's tabs as child rows, in tab order. A one-pane tab is one row; a tab with splits lists
  // its panes; agents' live sub-agents (terminals they started with `hc run`) nest under them.
  childRows(space, ctx) {
    const { allPanes, all, byAddress } = ctx;
    // The agent viewer tab is not a child of its own: the subagent's row stands for it.
    const mine = allPanes.filter((p) => p.mod !== "agent-view" && space.tabs.some((x) => x.id === p.tab));
    const viewer = allPanes.find((p) => p.mod === "agent-view" && space.tabs.some((x) => x.id === p.tab));
    const showing = viewer ? (shared(AGENT_TABS) ?? {})[viewer.pane] : null;
    const viewerOn = Boolean(viewer && space.active && space.tabs.find((x) => x.id === viewer.tab)?.active);
    const statusOf = (raw, fallback) => (typeof raw?.status === "string" ? raw.status : raw?.status?.state) ?? fallback ?? "idle";
    const msgOf = (raw) => raw?.report?.msg ?? raw?.status?.msg ?? "";
    const go = (pane) => () => { run("space.select", { id: space.id }); run("tab.select", { id: pane.tab }); run("pane.focus", { pane: pane.pane }); };
    const paneName = (pane) => {
      if (!pane.terminal) return pane.title || pane.mod || "Panel";
      const raw = byAddress.get(pane.terminal);
      return (pane.program?.agent ? raw?.title : null) || pane.program?.name || pane.title || pane.terminal;
    };
    const rows = [];
    const addKids = (address, depth) => {
      // The session's own subagents (Claude's Agent tool, inside its process; see pollAgents).
      const session = byAddress.get(address)?.labels?.["claude.session"];
      for (const a of (session && this.subagents.get(session)) || []) {
        rows.push({
          id: `agent-${a.id}`, depth, status: a.running ? "working" : "done", program: CLAUDE,
          name: a.description || a.type, msg: a.running ? a.activity : `${a.type}, finished`, at: a.at,
          focused: viewerOn && showing === a.id, onClick: () => this.openAgent(space, a, viewer),
        });
      }
      for (const k of all.filter((x) => x.parent === address && x.state === "live")) {
        const pane = mine.find((p) => p.terminal === k.address);
        rows.push({
          id: `sub-${k.address}`, depth, status: statusOf(k), program: k.program,
          name: k.title || k.name || k.program?.name || k.address, msg: msgOf(k), at: k.status_ms, focused: Boolean(pane?.focused),
          menu: { terminal: k.address, pane: pane?.pane ?? null }, shell: this.shells.get(k.address),
          // A sub-agent has no pane: give it one beside the main pane, or focus the one it has.
          onClick: pane ? go(pane) : () => { run("space.select", { id: space.id }); run("terminal.keep", { terminal: k.address, place: "right" }); },
        });
        addKids(k.address, depth + 1);
      }
    };
    const paneRow = (pane, depth, label, tabActive, menu) => {
      const raw = pane.terminal ? byAddress.get(pane.terminal) : null;
      const agent = Boolean(pane.program?.agent);
      return {
        id: `pane-${pane.pane}`, depth, status: agent ? statusOf(raw, pane.status) : null,
        program: pane.mod === "file-view" ? fileProgram(pane, label, ctx.light) : pane.mod === "agent-view" ? CLAUDE : pane.program,
        name: label, msg: agent ? msgOf(raw) : basename(pane.cwd ?? ""), at: agent ? raw?.status_ms : null,
        shell: pane.terminal ? this.shells.get(pane.terminal) : null,
        mark: pane.mod === "file-view" ? (shared("file.tabs") ?? {})[pane.pane]?.mark ?? null : null,
        focused: space.active && tabActive && pane.focused, onClick: go(pane), menu,
      };
    };
    for (const tab of space.tabs) {
      const inTab = mine.filter((p) => p.tab === tab.id);
      const lead = inTab.find((p) => p.program?.agent) ?? inTab.find((p) => p.focused) ?? inTab[0];
      if (!lead) continue;
      // An unnamed tab is called by its number; the lead pane's name says more.
      const label = tab.named ? tab.name : paneName(lead);
      const tabMenu = { tab: tab.id, name: tab.named ? tab.name : "", label, split: inTab.length > 1 };
      // A locked dev workspace keeps its tabs: its rows cannot be dragged out.
      const drag = isLocked(space.id) ? undefined : { tab: tab.id, space: space.id, name: tab.named ? tab.name : null, label };
      if (inTab.length === 1) {
        rows.push({ ...paneRow(lead, 0, label, tab.active, tabMenu), drag });
        if (lead.terminal) addKids(lead.terminal, 1);
        continue;
      }
      rows.push({ id: `tab-${tab.id}`, depth: 0, status: tab.status, program: { icon: ICON("panel-right"), tint: true },
        name: label, msg: `${inTab.length} panes`, focused: false, menu: tabMenu, drag,
        onClick: () => { run("space.select", { id: space.id }); run("tab.select", { id: tab.id }); } });
      for (const pane of inTab) {
        rows.push(paneRow(pane, 1, paneName(pane), tab.active, { pane: pane.pane }));
        if (pane.terminal) addKids(pane.terminal, 2);
      }
    }
    return { rows, mine };
  }

  card(t, space, ctx) {
    const { rows, mine } = this.childRows(space, ctx);
    const tabCount = new Set(mine.map((p) => p.tab)).size; // the agent viewer tab is not counted
    const open = this.expanded.get(space.id) ?? space.active;
    const spaceAgents = ctx.allAgents.filter((a) => a.space === space.id);

    // Its ticket: the space's name, a tab's name, an agent's title, or the branch.
    const texts = [space.name, ...space.tabs.map((x) => x.name), ...spaceAgents.map((a) => a.title), space.branch];
    const key = texts.map((x) => x?.match(TICKET_KEY)?.[1]?.toUpperCase()).find(Boolean) ?? null;
    const ticket = key ? ctx.snap?.tickets?.find((x) => x.key === key) : null;
    // Every ticket and PR it works on: the name's key and branch, plus what its sessions created,
    // were handed or reviewed (pollWork). The buttons open all of them.
    const work = Object.values(shared(WORK)?.sessions ?? {}).filter((w) => w.space === space.id);
    const keys = uniqueBy([key, ...work.flatMap((w) => w.tickets)], (k) => k);
    const jiraBase = ctx.snap?.tickets?.find((x) => x.url)?.url?.replace(/\/browse\/.*$/, "") ?? null;
    const tickets = keys.map((k) => ({ kind: "ticket", key: k,
      url: ctx.snap?.tickets?.find((x) => x.key === k)?.url ?? (jiraBase ? `${jiraBase}/browse/${k}` : "") }));
    const prs = uniqueBy([
      ctx.prs.find((p) => space.branch && p.branch === space.branch),
      ...ctx.prs.filter((p) => keys.includes(p.ticket)),
      ...work.flatMap((w) => w.prs).map((p) => ctx.prs.find((x) => x.url === p.url) ?? p),
    ], (p) => p.url);
    const prName = (p) => `${(p.repo ?? "").split("/").pop()} #${p.number}`;
    const title = ticket ? `${ticket.key} ${ticket.summary}` : space.name;
    const folder = mine.find((p) => p.cwd)?.cwd ?? space.folder;
    const fill = fillOf(t, (shared("space.colors") ?? {})[space.id] ?? "ansi6");
    const icon = (shared("space.icons") ?? {})[space.id];
    // The space's own mark, like Orca's dot: the Poké Ball open when an agent needs input (a red
    // dot until the art is ready); rocking and hopping while one works (a spinner until then);
    // spinning with a pause while an agent's shell runs (a terminal icon until then); else
    // standing still (the color tile until then). Frames are 24x32: ball, room, a shadow.
    const ball = (img) => div().w(16).h(21).flex_none().flex().items_end().justify_center().child(img);
    const working = space.status === "working" && this.pokemonReady;
    const mark = space.status === "blocked" && this.pokemonReady ? ball(image(BALL_OPEN).w(16).h(21))
      : space.status === "blocked" ? div().w(12).flex_none().text_size(12).text_color(t.blocked).child("●")
      : working ? ball(image(ballFrame(this.ballTick)).w(16).h(21))
      : space.status === "working" ? svg(ICON("spinner")).size(11).flex_none().text_color(t.working).spin(900)
      : rows.some((r) => r.shell) && this.pokemonReady ? ball(image(spinFrame(this.ballTick)).w(16).h(21))
      : rows.some((r) => r.shell) ? svg(ICON("terminal")).size(11).flex_none().text_color(t.working)
      : this.pokemonReady ? ball(image(BALL_STILL).w(16).h(21))
      : h_flex().size(icon ? 14 : 10).flex_none().rounded(icon ? 4 : 5).bg(fill).items_center().justify_center()
        .when(Boolean(icon), (el) => el.child(svg(ICON(icon)).size(9).text_color("#ffffff")));
    const latest = rows.filter((r) => r.status).sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];
    const menuHeight = 44 + 30 * (this.agentChoices.length + (space.active ? 3 : 2));
    const dropping = this.moved && Boolean(this.drag) && this.dropTarget === space.id && this.drag.space !== space.id;

    return v_flex().id(`card-${space.id}`).mx(8).mt(8).p(8).gap(3).flex_none().rounded(10)
      .bg(dropping ? t.selected : space.active ? t.surface : t.chrome)
      .border_1().border_color(dropping ? t.accent : space.active ? t.input : t.border)
      .cursor_pointer().hover((s) => s.border_color(t.input))
      .on_click(() => run("space.select", { id: space.id }))
      .when(this.moved && this.cardDrag === space.id && this.dropTarget && this.dropTarget !== space.id, (el) => el.opacity(0.5))
      // A press on a tab row starts a tab drag (that row's handler runs first); anywhere else on
      // the card starts a card drag, which reorders the dev workspaces.
      .on_mouse_down("left", (e) => { if (!this.drag) { this.cardDrag = space.id; this.dropTarget = null; this.arm(e); } })
      .on_hover((on, cx) => {
        if (!this.moved || (!this.drag && !this.cardDrag)) return;
        if (on) this.dropTarget = space.id; else if (this.dropTarget === space.id) this.dropTarget = null;
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        const moved = this.moved, d = this.drag, c = this.cardDrag;
        this.drag = null; this.cardDrag = null; this.dropTarget = null; this.press = null; this.moved = false;
        if (!moved) { cx.notify(); return; }
        if (d && d.space !== space.id) this.askMoveTab(d, space, folder);
        // space.move takes a 1-based place among all spaces; the target's place is where it lands.
        if (c && c !== space.id) run("space.move", { id: c, index: spaces().findIndex((s) => s.id === space.id) + 1 });
        cx.notify();
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "menu-spaces", kind: "popup", width: 200, height: 290, props: { tab: "space", target: { id: space.id } } });
      })
      .child(h_flex().px(4).gap(7).items_center()
        .child(mark)
        .when(this.pokemonReady && Boolean(this.pokemon?.[space.id]), (el) => el.child(this.pokemonButton(space, title)))
        .child(div().flex_1().min_w(0).truncate().text_size(13.5).font_semibold().text_color(t.foreground).tooltip(title).child(title))
        .when(isLocked(space.id), (el) => el.child(this.iconButton(t, `lock-${space.id}`, "mods/file-icons/ui/lock.svg",
          "Locked: it cannot be closed, and its tabs stay here. Click to unlock.", () => setLocked(space.id, false), true, t.muted)))
        .child(div().id(`fold-${space.id}`).p(2).rounded(4).text_color(t.dim).cursor_pointer().tooltip(open ? "Collapse" : "Expand")
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.expanded.set(space.id, !open); cx.notify(); })
          .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(11))))
      .child(h_flex().px(4).gap(4).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim)
          .child(space.branch ? `${basename(folder)} · ${space.branch}` : basename(folder)))
        .child(this.iconButton(t, `jira-${space.id}`, JIRA,
          tickets.length ? `Open ${tickets.map((x) => x.key).join(", ")}` : "No ticket here: opens the Jira board",
          (cx) => openAll(cx, tickets, { tab: "jira" }), tickets.length > 0, JIRA_BLUE, tickets.length))
        .child(this.iconButton(t, `gh-${space.id}`, GITHUB,
          prs.length ? `Open ${prs.map(prName).join(", ")}` : "No PR here: opens My PRs",
          (cx) => openAll(cx, prs.map((p) => ({ kind: "pr", url: p.url })), { tab: "mine" }), prs.length > 0, null, prs.length)))
      .when(!open, (el) => el.when(Boolean(latest), (el) => el.child(this.row(t, { ...latest, depth: 0 }))))
      .when(open, (el) => el
        .child(h_flex().px(4).pt(3).gap(4).items_center()
          .child(div().flex_1().text_size(12).text_color(t.dim).child(`${tabCount} tab${tabCount === 1 ? "" : "s"}`))
          .child(this.iconButton(t, `add-${space.id}`, "plus", "Add to this dev workspace", () => openOverlay({
            mod: "space-panel", kind: "popup", width: 240, height: menuHeight, props: { addMenu: { space: space.id, active: space.active, folder } },
          }))))
        .children(rows.length ? rows.map((r) => this.row(t, r))
          : [div().px(6).py(4).text_size(12).text_color(t.dim).child("No tabs yet. Add one with +.")]));
  }

  // The dev workspace's Pokémon beside its title; a click opens the Edit dialog to pick another.
  pokemonButton(space) {
    const n = this.pokemon[space.id];
    const box = iconBox(n, 20);
    return div().id(`poke-${space.id}`).w(27).h(20).flex_none().flex().items_center().justify_center().cursor_pointer()
      .tooltip(`${nameOf(n)}: click to change`)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "space-new", kind: "dialog", width: 560, height: 680, props: { edit: space.id } });
      })
      .child(image(`${POKEMON_DIR}/${n}.png`).w(box.w).h(box.h));
  }

  arm(e) {
    this.press = { x: e.position.x, y: e.position.y };
    this.moved = false;
  }

  // Moving a dev workspace's only tab closes that dev workspace (herdr closes a space with no
  // tabs), so that move asks first.
  askMoveTab(drag, target, folder) {
    const from = spaces().find((s) => s.id === drag.space);
    if (!from || from.tabs.length > 1) { this.moveTab(drag, target, folder); return; }
    openOverlay({ mod: "space-panel", kind: "dialog", width: 400, height: 180, props: {
      moveConfirm: { drag, target: target.id, folder, from: from.name, to: target.name },
    } });
  }

  moveConfirm(t) {
    const m = props().moveConfirm;
    const close = () => closeOverlay(props().overlay);
    const yes = () => { close(); setShared(MOVE_REQUEST, { drag: m.drag, target: m.target, folder: m.folder, at: Date.now() }); };
    const button = (id, label, bg, fg, onClick) => h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1()
      .border_color(id === "no" ? t.input : bg).bg(bg).text_color(fg).cursor_pointer().hover((s) => s.opacity(0.88))
      .on_click(onClick).child(label);
    return v_flex().id("move-confirm").track_focus(this.handle).size_full().p(18).gap(12).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "enter") yes(); else if (e.key === "escape") close(); else return;
        cx.stop_propagation();
      })
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child(`Close "${m.from}"?`))
      .child(div().text_color(t.muted).child(`"${m.drag.label}" is its only tab. Moving it to "${m.to}" closes "${m.from}".`))
      .child(div().flex_1())
      .child(h_flex().gap(8).justify_end()
        .child(button("no", "Cancel", t.popover, t.foreground, close))
        .child(button("yes", "Move and close", t.blocked, "#ffffff", yes)));
  }

  // herdr has no "move tab to space" command. Parking takes a terminal's pane away and keeps
  // it running; keeping it again opens it as a tab in the selected space. A source tab left with
  // only mod panes is closed, and a mod-only tab (Files) is reopened in the target's folder.
  moveTab(drag, target, targetFolder) {
    if (isLocked(drag.space)) return;
    const inTab = panes().filter((p) => p.tab === drag.tab);
    const terms = inTab.filter((p) => p.terminal);
    const mods = inTab.filter((p) => !p.terminal);
    if (!terms.length) {
      // A file tab reopens on the same file (file-view records it in shared "file.tabs").
      const files = shared("file.tabs") ?? {};
      run("tab.close", { id: drag.tab });
      for (const p of mods) {
        const was = files[p.pane];
        run("tab.new", { space: target.id, mod: p.mod, name: drag.name ?? "Files", props: was ? { root: was.root, ...(was.file ? { file: was.file } : {}) } : { root: targetFolder } });
      }
      return;
    }
    for (const p of terms) run("terminal.park", { terminal: p.terminal });
    this.pending.push({
      stage: "parking", terminals: terms.map((p) => p.terminal), kept: 0, target: target.id,
      from: drag.tab, name: drag.name, closeFrom: mods.length > 0, at: Date.now(),
    });
  }

  // park and keep are applied later by the core, and a keep sent before its park lands is lost
  // (the terminal ends up running with no pane). So each step waits for the last one to show.
  settle(allPanes) {
    if (!this.pending.length) return;
    const paneOf = (address) => allPanes.find((p) => p.terminal === address);
    this.pending = this.pending.filter((job) => {
      if (Date.now() - job.at > 20000) {
        // Never leave a terminal without a pane: put any stragglers in the selected space.
        for (const address of job.terminals) if (!paneOf(address)) run("terminal.keep", { terminal: address, place: "tab" });
        return false;
      }
      if (job.stage === "parking") {
        if (job.terminals.some(paneOf)) return true;
        run("space.select", { id: job.target });
        job.stage = "keeping";
      }
      if (job.stage === "keeping") {
        const last = job.kept > 0 ? paneOf(job.terminals[job.kept - 1]) : null;
        if (job.kept > 0 && !last) return true;
        if (job.kept < job.terminals.length) {
          run("terminal.keep", { terminal: job.terminals[job.kept], place: job.kept === 0 ? "tab" : "right" });
          job.kept += 1;
          return true;
        }
        const first = paneOf(job.terminals[0]);
        if (!first) return true;
        // A kept tab is named after its terminal ("t15"); "" gives an unnamed one its number back.
        run("tab.rename", { id: first.tab, name: job.name ?? "" });
        if (job.closeFrom && allPanes.some((p) => p.tab === job.from)) run("tab.close", { id: job.from });
        return false;
      }
      return false;
    });
  }

  // Popups: what + brings into a dev workspace, and how a new dev workspace starts.
  popup(t, items, heading) {
    const pick = (action) => () => { closeOverlay(props().overlay); action(); };
    return v_flex().size_full().p(5).bg(t.popover).text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child(heading))
      .children(items.map((it) => h_flex().id(`pick-${it.id}`).h(30).px(8).gap(9).flex_none().items_center().rounded(7)
        .text_color(t.foreground).cursor_pointer().hover((el) => el.bg(t.hover))
        .on_click(pick(it.action))
        .child(it.program ? programIcon(it.program, t.muted) : svg(ICON(it.icon)).size(14).flex_none().text_color(it.tint ?? t.muted))
        .child(div().flex_1().truncate().child(it.label))));
  }

  addMenu(t) {
    const { space, active, folder } = props().addMenu;
    return this.popup(t, [
      ...this.agentChoices.map((a) => ({ id: `agent-${a.key}`, label: a.name, program: a, action: () => run("tab.new", { space, argv: a.run, folder }) })),
      { id: "term-tab", label: "Terminal", icon: "terminal", action: () => run("tab.new", { space, folder }) },
      ...(active ? [{ id: "term-split", label: "Terminal beside this pane", icon: "panel-right", action: () => run("terminal.open", { place: "right", folder }) }] : []),
      { id: "files", label: "Files", icon: "files", action: () => run("tab.new", { space, name: "Files", mod: "file-view", props: { root: folder } }) },
    ], "Add to this dev workspace");
  }

  rename() {
    const m = props().rowMenu;
    // An empty name gives the tab its number again; the card then shows the lead pane's name.
    run("tab.rename", { id: m.tab, name: this.newName.value().trim() });
    closeOverlay(props().overlay);
  }

  rowMenu(t) {
    const m = props().rowMenu;
    if (!this.renaming) {
      const items = rowActions(m).map((a) => ({ ...a, action: a.run ?? (() => {}) }));
      const pick = (a) => (_e, cx) => {
        if (a.id === "rename") { this.renaming = true; this.newName.focus(); cx.notify(); return; }
        closeOverlay(props().overlay);
        a.action();
      };
      return v_flex().size_full().p(5).bg(t.popover).text_size(12.8)
        .child(div().px(8).pt(4).pb(6).truncate().text_size(11).text_color(t.dim).child(m.label ?? "Pane"))
        .children(items.map((it) => h_flex().id(`row-${it.id}`).h(30).px(8).gap(9).flex_none().items_center().rounded(7)
          .text_color(it.id === "close" || it.id === "kill" ? t.blocked : t.foreground).cursor_pointer().hover((el) => el.bg(t.hover))
          .on_click(pick(it))
          .child(svg(ICON(it.icon)).size(14).flex_none())
          .child(div().flex_1().truncate().child(it.label))));
    }
    return v_flex().id("rename-tab").track_focus(this.handle).size_full().p(10).gap(8).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .child(div().text_size(11).text_color(t.dim).child("Rename tab (Enter saves)"))
      .child(h_flex().h(30).px(8).items_center().rounded(7).border_1().border_color(t.input).bg(t.background)
        .child(Input.new(this.newName).flex_1().h_full().text_color(t.foreground)));
  }

  newMenu(t) {
    const { root } = props().newMenu;
    return this.popup(t, [
      { id: "from-jira", label: "From a Jira ticket", icon: JIRA, tint: JIRA_BLUE, action: () => openTask({ tab: "jira" }) },
      { id: "from-gh", label: "From a GitHub PR", icon: GITHUB, tint: t.foreground, action: () => openTask({ tab: "mine" }) },
      { id: "custom", label: "Custom…", icon: "square-pen", action: () => openOverlay({ mod: "space-new", kind: "dialog", width: 560, height: 620, props: { newDev: root } }) },
    ], "New dev workspace");
  }

  render(_cx) {
    const t = theme();
    if (props()?.addMenu) return this.addMenu(t);
    if (props()?.newMenu) return this.newMenu(t);
    if (props()?.rowMenu) return this.rowMenu(t);
    if (props()?.moveConfirm) return this.moveConfirm(t);
    this.pokemon = pokemonFor(spaces().map((s) => s.id));
    this.anyWorking = spaces().some((s) => s.status === "working");

    const request = shared(MOVE_REQUEST);
    if (request && Number(request.at) > this.lastMove) {
      this.lastMove = Number(request.at);
      this.moveTab(request.drag, { id: request.target }, request.folder);
    }

    const activeSpace = spaces().find((s) => s.active);
    const rootOf = shared("space.root") ?? {};
    const root = (shared("roots") ?? []).find((r) => r.id === (activeSpace ? rootOf[activeSpace.id] : null));
    const mine = spaces().filter((s) => root && rootOf[s.id] === root.id);
    const snap = shared("tasks.snapshot");
    const all = terminals();
    const ctx = {
      allPanes: withClaude(panes(), all), all, byAddress: new Map(all.map((x) => [x.address, x])), allAgents: agents(), snap, light: isLight(t.background),
      prs: [...(snap?.mine ?? []), ...(snap?.review ?? [])],
    };
    this.settle(ctx.allPanes);
    setAgentOrder(ctx.allAgents.filter((a) => mine.some((s) => s.id === a.space)).map((a) => a.address));

    const header = h_flex().px(16).pt(14).pb(6).gap(8).flex_none().items_center()
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(14).font_semibold().text_color(t.foreground).child(root?.name ?? "Workspace"))
        .child(div().truncate().text_size(11.5).text_color(t.dim).child(root?.folder ?? "")))
      .when(Boolean(root), (el) => el.child(this.iconButton(t, "new-dev", "plus", "New dev workspace", () => openOverlay({
        mod: "space-panel", kind: "popup", width: 230, height: 140, props: { newMenu: { root: root.id } },
      }))));

    return v_flex().id("dev-workspaces").size_full().min_h(0).bg(t.chrome).text_size(13)
      .on_mouse_move((e, cx) => {
        if (!this.press || this.moved) return;
        if (Math.hypot(e.position.x - this.press.x, e.position.y - this.press.y) < DRAG_START_PX) return;
        this.moved = true;
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        if (this.drag || this.cardDrag) { this.drag = null; this.cardDrag = null; this.dropTarget = null; this.press = null; this.moved = false; cx.notify(); }
      })
      .child(header)
      .child(v_flex().id("dev-workspace-list").flex_1().min_h(0).pb(10).overflow_y_scrollbar()
        .children(mine.flatMap((s) => {
          // During a card drag, a line shows where the card will land: above the target when it
          // moves up, below when it moves down.
          const cue = this.cardDrag && this.dropTarget === s.id && this.cardDrag !== s.id
            ? (spaces().findIndex((x) => x.id === this.cardDrag) > spaces().findIndex((x) => x.id === s.id) ? "above" : "below") : null;
          const line = div().mx(12).mt(6).mb(-4).h(3).rounded(2).bg(t.accent);
          return [...(cue === "above" ? [line] : []), this.card(t, s, ctx), ...(cue === "below" ? [line] : [])];
        }))
        .when(!mine.length, (el) => el.child(div().px(16).pt(6).text_size(12).text_color(t.dim).child("No dev workspaces yet. Add one with +."))));
  }
}
