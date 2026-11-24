// The Reader: stands in for a Claude pane's terminal. It zooms over the terminal and shows the
// chat with colors by meaning (tickets, PRs, paths, commands, pass/fail), folds tool output,
// docks Claude's open question with one-tap answers, mirrors terminal prompts (permissions,
// multiple choice) with key buttons, and has its own message box. It reads the transcript
// (parse.mjs) and types into the terminal (hx send, hc keys): no model tokens of its own.
//
// Two roles, by props:
//   { terminal }  the Reader for that Claude terminal (a pane opened with pane.split).
//   { auto: true } an invisible layout block: opens a Reader beside each Claude pane of the shown
//                  tab once per terminal (shared "reader.opened"), then gives focus back.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, TextareaState, Textarea, TextView } from "gpui-base";
import { exec, appHome, home, readTextFile, theme, props, panes, terminals, focused, spaces, shared, setShared, run, watchFolder, checking } from "herdr";
import { NAMES } from "./pokemon-names.js"; // a copy: mods cannot import each other

const OPENED = "reader.opened"; // { terminal: ms } so a Reader you closed stays closed
const SHOWN = 40; // items drawn before "Show earlier"; each word is an element, so keep this small
const LONG = 2400; // reply characters drawn before "Show more"
// Words drawn in full color per frame. Every word is an element and herdr stops a render that
// runs too long ("interrupted"), so older messages past this budget draw as one line each.
const WORD_BUDGET = 2500;
const RENDER_MS = 30; // time for full-color messages per frame; herdr interrupts slow renders
const wordsIn = (it) => String(it.text ?? "").split(/\s+/).length;
const POLL_MS = 15000; // fallback when the folder watch misses a write
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;

const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
const base = (p) => String(p).split(/[\\/]/).pop();
// A Claude pane: the agent reports itself, or its terminal carries the session label
// (herdr-resume sets it, and keeps it while the pane sleeps).
const isClaude = (p, sessions) => p.terminal && (p.app === "claude-code" || /claude/i.test(p.program?.name ?? "") || sessions.has(p.terminal));

// ---- inline text: words in a wrapping row, each kind of token in its own color ----

// One pass over the text. Order matters: code and links first so what is inside them stays plain.
const TOKEN = new RegExp([
  "(`[^`\\n]+`)", // 1 code
  "(\\*\\*[^*\\n]+\\*\\*)", // 2 bold
  "(\\[[^\\]\\n]+\\]\\((?:https?|file):[^)\\s]+\\))", // 3 markdown link
  "(https?:\\/\\/[^\\s)>\\]]+)", // 4 url
  "((?<![A-Za-z0-9-])[A-Z][A-Z0-9]+-\\d+(?![A-Za-z0-9]))", // 5 ticket
  "((?<![\\w#])(?:[A-Za-z][\\w.-]*)?#\\d{2,5}\\b)", // 6 PR
  "((?:[A-Za-z]:)?(?:[\\w.~-]+[\\\\/])+[\\w.-]+\\.[A-Za-z]{1,6}(?::\\d+)?)", // 7 path
  "\\b(passed|passes|green|succeeded|success|merged|fixed|done|clean|ok|OK)\\b", // 8 good
  "\\b(failed|fails|failing|red|errors?|broken|refused|denied|blocked|timed out)\\b", // 9 bad
  "\\b(\\d+(?:\\.\\d+)?\\s?(?:GB|MB|KB|ms|min|s)\\b|\\d{1,2}:\\d{2}(?::\\d{2})?\\b)", // 10 number
].join("|"), "g");

// Tokenizing is the costly part of a redraw (the regex runs in herdr's QuickJS), and the same
// texts are drawn again on every change, so results are kept by text.
const TOKEN_CACHE = new Map();
const KINDS = ["", "code", "bold", "link", "url", "ticket", "pr", "path", "good", "bad", "num"];
// "claude-opus-5-5" -> "Opus 5.5"; other ids show as they are.
function modelName(id) {
  const m = String(id).match(/^claude-([a-z]+)-(\d+)-(\d+)/);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : String(id);
}

function tokens(text) {
  const hit = TOKEN_CACHE.get(text);
  if (hit) return hit;
  const out = tokenize(text);
  if (TOKEN_CACHE.size > 3000) TOKEN_CACHE.clear();
  TOKEN_CACHE.set(text, out);
  return out;
}

function tokenize(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    const i = m.findIndex((g, j) => j > 0 && g !== undefined);
    out.push({ kind: KINDS[i], text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

// A prompt Claude draws in the terminal (a permission, a multi-select): its question, the lines
// just above it, its numbered options with the one the cursor is on, and the keys its footer
// offers ("Esc to cancel · Tab to amend"). Null when the screen holds no numbered options.
const OPTION = /^\s*([\u276f\u203a>])?\s*(\d+)\.\s+(.+?)\s*$/;
// What a message's Copy puts on the clipboard: code fence lines (```bash) dropped and inline
// `code` unwrapped. Backticks inside a fenced block stay: they are the script's own (bash `cmd`).
function plainCopy(text) {
  let fenced = false;
  return String(text ?? "").split("\n").flatMap((line) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return []; }
    return [fenced ? line : line.replace(/`([^`\n]+)`/g, "$1")];
  }).join("\n");
}

function readPrompt(lines) {
  if (!lines?.length) return null;
  let end = lines.length - 1;
  while (end >= 0 && !OPTION.test(lines[end])) end--;
  if (end < 0) return null;
  // Walk up from the last option. Deeper-indented lines under an option are its wrapped tail or,
  // in an AskUserQuestion pop-up, its description: shown under it. A ruled line between options
  // (above "Chat about this") is skipped. Any other shallow line (the question) ends the list.
  const isSep = (l) => /^[\u2500-\u257f\-=.\u00b7]{4,}$/.test(l);
  const options = [];
  let wrap = [];
  let start = end;
  for (let i = end; i >= 0; i--) {
    const m = lines[i].match(OPTION);
    if (m && /^\s{0,3}\S/.test(lines[i])) {
      options.unshift({ n: Number(m[2]), label: m[3], more: wrap.join(" "), current: Boolean(m[1]) });
      wrap = [];
      start = i;
    } else if (/^\s{4,}\S/.test(lines[i])) wrap.unshift(lines[i].trim());
    else if (options.length && isSep(lines[i].trim()) && OPTION.test(lines[i - 1] ?? "")) continue;
    else break;
  }
  if (options.length < 2) return null;
  const footer = lines.slice(end + 1).join(" ");
  // AskUserQuestion's pop-up: a "\u2610 Header" chip line, then the question on "\u2502"-barred lines.
  // Claude writes the question to the transcript only once answered, so the screen is the source.
  if (/enter to select/i.test(footer)) {
    const above = lines.slice(Math.max(0, start - 30), start);
    const bar = above.filter((l) => /^\s*\u2502/.test(l)).map((l) => l.replace(/^\s*\u2502\s*/, "").trim());
    const header = above.filter((l) => /^\s*[\u2610\u2612\u2611\u2714]/.test(l)).pop()?.trim() ?? "";
    if (bar.length) {
      return { ask: true, question: bar.join(" "), context: header ? [header] : [], options,
        cursor: Math.max(0, options.findIndex((o) => o.current)), esc: /esc to cancel/i.test(footer), tab: false };
    }
  }
  // Only the lines after the last separator (a dotted or ruled line) belong to the prompt; above
  // it is the command or diff being asked about.
  const raw = lines.slice(Math.max(0, start - 12), start).map((l) => l.replace(/^[\s\u2502|]+/, "").trim());
  const sep = raw.map(isSep).lastIndexOf(true);
  let above = raw.slice(sep + 1).filter(Boolean);
  // Nothing between the separator and the question: show what is being asked about instead
  // (the command between the last two separators).
  if (above.length <= 1 && sep > 0) {
    const prev = raw.slice(0, sep).map(isSep).lastIndexOf(true);
    above = [...raw.slice(prev + 1, sep).filter(Boolean).slice(-3), ...above];
  }
  const qi = above.map((l) => l.endsWith("?")).lastIndexOf(true);
  const question = qi >= 0 ? above[qi] : above[above.length - 1] ?? "";
  const context = (qi >= 0 ? above.slice(0, qi) : above.slice(0, -1)).slice(-3);
  return {
    question, context, options,
    cursor: Math.max(0, options.findIndex((o) => o.current)),
    esc: /esc to (cancel|exit|go back)/i.test(footer), tab: /tab to (amend|edit)/i.test(footer),
  };
}

// The message list is the costly part of the Reader, so it lives in a retained child view that
// rebuilds only when the chat or its own toggles change (refresh), not on every herdr change (an
// agent's status, focus, shared state) that repaints the rest of the pane.
const STREAMS = new Map(); // key -> Reader that owns the list
class StreamView extends View {
  init(props) { this.key = props?.key; }
  render(cx) { return STREAMS.get(this.key)?.renderStream(cx) ?? div(); }
}

export default class Reader extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.auto = Boolean(p.auto);
    if (this.auto) {
      if (!checking()) cx.timer.every(3000, () => { this.autoOpen(); this.nameTabs(); });
      return;
    }
    this.terminal = p.terminal ?? null;
    this.items = [];
    this.agg = { decisions: [], running: {}, prs: {}, tickets: [], files: [] };
    this.waiting = { question: null, ask: null };
    this.title = null;
    this.model = null;
    this.ctx = null;
    this.usage = null;
    this.usageText = null;
    this.session = null;
    this.path = null;
    this.shown = SHOWN;
    this.open = new Set(); // expanded tool rows, long replies and summaries
    this.selecting = new Set(); // messages shown as selectable text (see actions)
    this.picks = {}; // numbered question -> "yes" | "no"
    this.sentAt = 0;
    this.width = 0;
    this.height = 0;
    this.plan = null;
    this.scroll = ScrollHandle.new();
    this.follow = true;
    this.full = new Set(); // messages already drawn in full (see renderStream)
    this.key = `reader-${Date.now()}-${Math.random()}`;
    STREAMS.set(this.key, this);
    this.streamView = cx.new(StreamView, { key: this.key });
    this.input = TextareaState.new({ placeholder: "Message Claude", rows: 2 });
    this.input.set_auto_grow(1, 8);
    this.input.on("submit", (_e, cx) => this.sendInput(cx));
    this.input.on("paste_other", (_e, cx) => this.pasteImage(cx));
    this.pending = []; // messages sent but not in the transcript yet
    this.screen = null; // the terminal's last lines while a prompt waits there
    this.zoomedOnce = false;
    if (checking()) return;
    cx.spawn(async (cx) => { await this.load(cx); });
    cx.timer.every(POLL_MS, (cx) => { this.load(cx); });
    cx.timer.every(1500, (cx) => this.tick(cx));
  }

  myPane() {
    const tab = panes().find((p) => p.terminal === this.terminal)?.tab;
    return panes().find((p) => p.mod === "reader" && p.tab === tab) ?? null;
  }

  // The chat's model and context window, from what the status line saved for this session
  // (claude/statusline.mjs). The transcript has no window size, so it is the fallback only.
  async readUsage(cx) {
    if (!this.session) return;
    const text = await readTextFile(`${appHome()}/data/reader/status/${this.session}.json`).catch(() => null);
    if (!text || text === this.usageText) return;
    this.usageText = text;
    try { this.usage = JSON.parse(text); } catch { return; }
    this.refresh(cx);
  }

  usageChip(t) {
    const u = this.usage?.model ? this.usage : null;
    const w = u?.context_window;
    const used = w?.current_usage ? (w.current_usage.input_tokens ?? 0) + (w.current_usage.cache_read_input_tokens ?? 0) + (w.current_usage.cache_creation_input_tokens ?? 0) : this.ctx ?? 0;
    const size = w?.context_window_size;
    const pct = w?.used_percentage ?? (size ? Math.round((used / size) * 100) : null);
    const k = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
    const name = u?.model?.display_name ?? modelName(u?.model?.id ?? this.model);
    return div().id("usage").flex_none().text_size(11).text_color(pct >= 80 ? t.blocked : t.dim)
      .tooltip(`${u?.model?.id ?? this.model} · ${used.toLocaleString()} tokens in context${size ? ` of ${size.toLocaleString()}` : ""}`)
      .child(size ? `${name} · ${k(used)} / ${k(size)} (${pct}%)` : `${name} · ${k(used)}`);
  }

  // Covers the terminal the first time it shows, and mirrors the terminal's screen while Claude
  // waits on a prompt that lives only there (a permission, a multiple-choice question).
  async tick(cx) {
    if (!this.isShown()) return;
    await this.readUsage(cx);
    const me = this.myPane();
    if (!this.zoomedOnce && me) {
      this.zoomedOnce = true;
      if (!me.zoomed) run("pane.zoom", { pane: me.pane });
      run("pane.focus", { pane: me.pane });
      this.input.focus();
    }
    const status = panes().find((p) => p.terminal === this.terminal)?.status;
    if (status === "blocked" || this.waiting.ask) {
      const r = await exec("hc", ["read", this.terminal, "--lines", "0"]).catch(() => null);
      const lines = (r?.stdout ?? "").split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());
      this.screen = lines.slice(-60);
      await this.readPlan(lines);
      this.refresh(cx);
    } else if (this.screen) { this.screen = null; this.plan = null; this.refresh(cx); }
  }

  // The plan dialog is taller than the terminal, so Claude Code redraws the whole screen and
  // clears the scrollback: the plan's top can't be scrolled to there. Its footer names the plan
  // file ("ctrl+g to edit in Notepad · ~\.claude\plans\x.md"); the dock shows that file.
  async readPlan(lines) {
    const m = lines.join("\n").match(/[\\/]\.claude[\\/]plans[\\/]([\w.-]+\.md)/);
    if (!m) { this.plan = null; return; }
    const text = await readTextFile(`${home()}/.claude/plans/${m[1]}`).catch(() => null);
    this.plan = text ? { name: m[1], text } : null;
  }

  async sendInput(cx, force) {
    const text = this.input.value().replace(/\s+$/, "");
    if (!text.trim()) return;
    // The box still starting with the message sent last ("no" then "noyes") means old text was
    // left in it: ask before sending instead of sending the run-together text.
    const last = this.lastSent;
    if (!force && last && Date.now() - last.at < 30 * 60000 && text.length > last.text.length && text.startsWith(last.text)) {
      this.leftover = { text, rest: text.slice(last.text.length).replace(/^\s+/, ""), old: last.text };
      this.refresh(cx);
      return;
    }
    this.leftover = null;
    this.input.set_value("");
    this.pending.push({ text, t: new Date().toISOString() });
    this.follow = true;
    this.toBottom = true;
    await this.send(text, cx);
  }

  keys(key) { exec("hc", ["keys", this.terminal, key]); }

  // A paste with no text (a screenshot, copied files): save the clipboard image as a PNG and put
  // its path in the message, as herdr's terminal paste does; Claude reads the file.
  async pasteImage(cx) {
    const out = `${appHome()}/data/reader/pasted/pasted-${Date.now()}.png`.replace(/\//g, "\\");
    const r = await exec("powershell", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", `${appHome()}/mods/reader/paste-image.ps1`, out]).catch(() => null);
    const said = (r?.stdout ?? "").trim();
    const paths = said.startsWith("image ") ? [said.slice(6)] : said.startsWith("files ") ? said.slice(6).split("|") : [];
    if (!paths.length) return;
    this.input.replace(`${paths.join(" ")} `);
    this.input.focus();
    this.refresh(cx);
  }

  // ---- auto: one Reader per Claude pane in the shown tab ----

  autoOpen() {
    const f = focused();
    if (!f?.tab) return;
    const all = panes();
    const here = all.filter((p) => p.tab === f.tab);
    if (here.some((p) => p.mod === "reader")) return;
    const sessions = new Set(terminals().filter((x) => x.labels?.["claude.session"]).map((x) => x.address));
    const claude = here.find((p) => isClaude(p, sessions));
    if (!claude) return;
    const opened = shared(OPENED) ?? {};
    if (opened[claude.terminal]) return;
    setShared(OPENED, { ...opened, [claude.terminal]: Date.now() });
    run("pane.split", { pane: claude.pane, direction: "right", mod: "reader", props: { terminal: claude.terminal } });
  }

  // Claude tabs are named "<Pokemon> - <name>" ("Vanillite - herdr config"): the herdr phone app
  // runs no mods but shows tab names, so this is how the agent's name reaches the phone. The
  // Pokemon is the dev workspace card's (space-panel, shared "space.pokemon"); a rename or a new
  // Pokemon is followed. hx strips the prefix again (tabBase) so names never double.
  nameTabs() {
    if (Date.now() - (this.namedAt ?? 0) < 10000) return;
    this.namedAt = Date.now();
    const pokemon = shared("space.pokemon") ?? {};
    const all = panes();
    const sessions = new Set(terminals().filter((x) => x.labels?.["claude.session"]).map((x) => x.address));
    const known = new Set(NAMES);
    // The tab's own name: without "<Pokemon> - ", and a tab named just its Pokemon stands for
    // its space's name.
    const strip = (name, space) => {
      if (known.has(name)) return space.name;
      const i = name.indexOf(" - ");
      return i > 0 && known.has(name.slice(0, i)) ? name.slice(i + 3) : name;
    };
    for (const space of spaces()) {
      const poke = NAMES[(pokemon[space.id] ?? 0) - 1];
      if (!poke) continue;
      for (const tab of space.tabs) {
        if (!all.some((p) => p.tab === tab.id && isClaude(p, sessions))) continue;
        // The phone shows "<space>  <tab>": a tab named like its space would read twice there
        // ("herdr config  Vanillite - herdr config"), so such a tab is named by its Pokemon alone.
        const base = strip(tab.name, space);
        const want = base.trim().toLowerCase() === space.name.trim().toLowerCase() ? poke : `${poke} - ${base}`;
        if (tab.name !== want) run("tab.rename", { id: tab.id, name: want });
      }
    }
  }

  // ---- data ----

  // The session Claude is in now: its own session file (~/.claude/sessions/<pid>.json) for the
  // pane's foreground process. The claude.session label can lag behind: it is set by a
  // SessionStart hook that may miss, and a new `claude` in the same pane starts a new session.
  async liveSession() {
    try {
      const r = await exec("hc", ["get", this.terminal, "--json"]);
      const pid = JSON.parse(r.stdout || "{}").foreground?.pid;
      if (pid) {
        const text = await readTextFile(`${home()}/.claude/sessions/${pid}.json`);
        const id = text ? JSON.parse(text).sessionId : null;
        if (id) return id;
      }
    } catch {
      // fall back to the label
    }
    return this.sessionOf();
  }

  sessionOf() {
    return terminals().find((x) => x.address === this.terminal)?.labels?.["claude.session"] ?? null;
  }

  // Only the Reader on screen reads; a hidden one catches up when its tab shows again.
  isShown() {
    const tab = panes().find((p) => p.terminal === this.terminal)?.tab;
    return Boolean(tab) && focused()?.tab === tab;
  }

  async load(cx) {
    if (!this.isShown()) { this.stale = true; return; }
    this.stale = false;
    if (this.loading) { this.dirty = true; return; }
    const session = await this.liveSession();
    if (!session) return;
    const first = session !== this.session;
    this.loading = true;
    try {
      const r = await exec("node", [`${appHome()}/mods/reader/parse.mjs`, session, ...(first ? ["--full"] : [])], { timeout: 60000 });
      const data = JSON.parse(r.stdout || "{}");
      if (data.missing || data.error) return;
      if (first) { this.session = session; this.usage = null; this.usageText = null;this.shown = SHOWN; this.open.clear(); this.full = new Set(); }
      this.items = data.replaced ? data.items : this.items.concat(data.items).slice(-1200);
      // A slash command arrives as a command row with no arguments ("/pr-review"), not as a message.
      const said = new Set(data.items.filter((x) => x.k === "user" || x.kind === "cmd").map((x) => x.text.trim()));
      const arrived = (m) => said.has(m.text.trim()) || (m.text.startsWith("/") && said.has(m.text.trim().split(/\s+/)[0]));
      this.pending = this.pending.filter((m) => !arrived(m) && Date.now() - Date.parse(m.t) < 120000);
      this.agg = data.agg;
      this.waiting = data.waiting ?? this.waiting;
      this.title = data.title;
      this.model = data.model;
      this.ctx = data.ctx;
      if (data.path && data.path !== this.path) { this.path = data.path; this.watch(cx); }
      if ((first || data.items.length) && this.follow) this.toBottom = true;
      this.refresh(cx);
    } catch {
      // a half-written state file or a busy machine: the next change or poll tries again
    } finally {
      this.loading = false;
      if (this.dirty) { this.dirty = false; this.load(cx); }
    }
  }

  watch(cx) {
    this.watcher?.cancel();
    const dir = this.path.replace(/[\\/][^\\/]+$/, "");
    cx.spawn(async (cx) => {
      for (;;) {
        const w = (this.watcher = watchFolder(dir));
        const changed = await w;
        if (!changed.length || this.watcher !== w) return;
        if (changed.some((p) => p.endsWith(".jsonl") && p.includes(this.session))) await this.load(cx);
      }
    });
  }

  async close() { this.watcher?.cancel(); this.scroll?.release(); STREAMS.delete(this.key); this.streamView?.release(); }

  // Types the answer into the chat (hx wakes a sleeping pane first), as if Alex typed it.
  async send(text, cx) {
    this.sentAt = Date.now();
    this.picks = {};
    this.lastSent = { text, at: Date.now() };
    // A dock answer leaves no copy of itself in the message box.
    if (this.input.value().trim() === text.trim()) this.input.set_value("");
    this.refresh(cx);
    await exec("node", [`${appHome()}/hx/hx.mjs`, "send", this.terminal, text]);
  }

  // "Reply in chat" is the Reader's own message box now.
  goToChat() { this.input.focus(); }

  // The terminal stays under the Reader; this lifts the Reader off it, or covers it again.
  showTerminal(show) {
    const me = this.myPane();
    if (!me || me.zoomed !== show) return;
    run("pane.zoom", { pane: me.pane });
    const term = panes().find((p) => p.terminal === this.terminal)?.pane;
    if (show && term) run("pane.focus", { pane: term });
    if (!show) { run("pane.focus", { pane: me.pane }); this.input.focus(); }
  }

  // ---- drawing helpers ----

  colors(t) {
    return {
      code: t.ansi3, ticket: t.ansi4, pr: t.accent, path: t.ansi6, url: t.ansi4, good: t.done, bad: t.blocked,
      num: t.ansi5, link: t.ansi4, bold: t.foreground, text: t.foreground,
    };
  }

  // A wrapping row of words. Tokens keep their spaces as their own small gaps.
  // A word that touches a token with no space between ("(#1652)", "requests.") stays glued to it:
  // pieces with no space between them share one unit, and only units get the gap.
  inline(t, text, id, base = {}) {
    const c = this.colors(t);
    const units = [];
    let open = false; // the last piece ended without a space, so the next one glues on
    let n = 0;
    const add = (el, glue) => { if (glue && units.length) units[units.length - 1].push(el); else units.push([el]); };
    for (const tok of tokens(text)) {
      if (tok.kind === "text" || tok.kind === "bold") {
        const bold = tok.kind === "bold";
        const raw = bold ? tok.text.slice(2, -2) : tok.text;
        const words = raw.split(/\s+/).filter(Boolean);
        words.forEach((w, j) => add(div().id(`${id}-${n++}`).text_color(base.color ?? c.text).when(bold || base.bold, (el) => el.font_weight(700)).child(w),
          j === 0 && open && !/^\s/.test(raw)));
        open = words.length > 0 ? !/\s$/.test(raw) : open && !/\s/.test(raw);
        continue;
      }
      const shown = tok.kind === "code" ? tok.text.slice(1, -1) : tok.kind === "link" ? tok.text.replace(/^\[([^\]]+)\].*$/, "$1") : tok.text;
      const href = tok.kind === "url" ? tok.text : tok.kind === "link" ? tok.text.replace(/^.*\]\(([^)]+)\)$/, "$1") : tok.kind === "pr" ? this.prUrl(tok.text) : tok.kind === "ticket" ? this.ticketUrl(tok.text) : null;
      let el = div().id(`${id}-${n++}`).text_color(c[tok.kind] ?? c.text);
      if (tok.kind === "code") el = el.px(4).rounded(4).bg(t.raised).font_family("Cascadia Mono").text_size(11.5);
      if (tok.kind === "ticket" || tok.kind === "pr") el = el.font_weight(600);
      if (href) el = el.cursor_pointer().hover((s) => s.underline()).tooltip(href).on_click((_e, cx) => cx.open_url(href));
      add(el.child(shown), open);
      open = true;
    }
    return h_flex().id(id).flex_wrap().gap_x(4).gap_y(1).min_w(0)
      .children(units.map((u, i) => (u.length === 1 ? u[0] : h_flex().id(`${id}-u${i}`).flex_none().children(u))));
  }

  prUrl(text) {
    const n = Number(text.split("#")[1]);
    const repo = text.split("#")[0];
    const hit = Object.values(this.agg.prs ?? {}).find((p) => p.number === n && (!repo || p.repo === repo));
    return hit?.url?.startsWith("https://") ? hit.url : null;
  }

  // tasks.snapshot is ~200 KB: reading it per ticket key stalled the render ("interrupted"),
  // so the Jira base is looked up once a minute.
  ticketUrl(key) {
    if (!this.jira || Date.now() - this.jira.at > 60000) {
      const snap = shared("tasks.snapshot");
      this.jira = { at: Date.now(), base: snap?.tickets?.find((x) => x.url)?.url?.replace(/\/browse\/.*$/, "") ?? null };
    }
    return this.jira.base?.startsWith("https://") ? `${this.jira.base}/browse/${key}` : null;
  }

  // Markdown blocks: fences, tables, headings, lists, quotes, paragraphs.
  rich(t, text, id) {
    const lines = text.replace(/\r/g, "").split("\n");
    const blocks = [];
    let para = [];
    const flush = () => { if (para.length) { blocks.push(this.inline(t, para.join(" "), `${id}-p${blocks.length}`)); para = []; } };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        flush();
        const code = [];
        for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
        blocks.push(v_flex().id(`${id}-c${blocks.length}`).p(8).rounded(6).bg(t.chrome).border_1().border_color(t.border)
          .font_family("Cascadia Mono").text_size(11.5).text_color(t.muted).overflow_x_scroll()
          .children(code.map((l, j) => div().id(`${id}-c${blocks.length}-${j}`).whitespace_nowrap().child(l || " "))));
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line)) {
        flush();
        const rows = [];
        for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) {
          if (/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) continue;
          rows.push(lines[i].trim().slice(1, -1).split("|").map((c) => c.trim()));
        }
        i--;
        blocks.push(this.table(t, rows, `${id}-t${blocks.length}`));
        continue;
      }
      const h = line.match(/^#{1,4}\s+(.*)$/);
      if (h) { flush(); blocks.push(this.inline(t, h[1], `${id}-h${blocks.length}`, { color: t.accent, bold: true })); continue; }
      const li = line.match(/^(\s*)([-*]|\d+[.)])\s+(.*)$/);
      if (li) {
        flush();
        const mark = /\d/.test(li[2]) ? li[2] : "•";
        blocks.push(h_flex().id(`${id}-l${blocks.length}`).items_start().gap(6).pl(li[1].length * 4)
          .child(div().flex_none().text_color(t.accent).child(mark))
          .child(div().flex_1().min_w(0).child(this.inline(t, li[3], `${id}-l${blocks.length}-x`))));
        continue;
      }
      const q = line.match(/^>\s?(.*)$/);
      if (q) { flush(); blocks.push(div().id(`${id}-q${blocks.length}`).pl(8).border_l(2).border_color(t.accent).child(this.inline(t, q[1], `${id}-q${blocks.length}-x`, { color: t.muted }))); continue; }
      if (!line.trim()) { flush(); continue; }
      para.push(line.trim());
    }
    flush();
    return v_flex().id(id).gap(6).min_w(0).children(blocks);
  }

  table(t, allRows, id) {
    const rows = allRows.slice(0, 25); // a header and 24 rows; longer tables are cut
    if (!rows.length) return div();
    const cols = Math.max(...rows.map((r) => r.length));
    return v_flex().id(id).rounded(6).border_1().border_color(t.border).overflow_hidden().min_w(0)
      .children(rows.map((r, i) => h_flex().id(`${id}-r${i}`).items_start().min_w(0)
        .bg(i === 0 ? t.chrome : i % 2 ? t.background : t.surface)
        .children(Array.from({ length: cols }, (_, j) => div().flex_1().min_w(0).px(8).py(4)
          .when(j > 0, (el) => el.border_l(1).border_color(t.border))
          .child(this.inline(t, r[j] ?? "", `${id}-r${i}-${j}`, i === 0 ? { color: t.muted, bold: true } : {}))))));
  }

  // ---- copy and select ----

  // A small "Copy" that says "Copied" until the next redraw after a moment.
  copyBtn(t, key, text, label = "Copy") {
    const done = this.copied?.key === key && Date.now() - this.copied.at < 2000;
    return div().id(`copy-${key}`).flex_none().px(6).rounded(4).text_size(11).cursor_pointer()
      .text_color(done ? t.done : t.dim).hover((st) => st.bg(t.hover).text_color(t.foreground))
      .tooltip("Copy to the clipboard")
      .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(text); this.copied = { key, at: Date.now() }; this.refresh(cx); })
      .child(done ? "Copied" : label);
  }

  // Under a message: Copy (the text without markdown backticks) and Select text, which swaps the
  // colored words for a selectable text view of the same message (each colored word is its own
  // element, so the colored view cannot be selected across words).
  actions(t, id, text) {
    const selecting = this.selecting.has(id);
    return h_flex().id(`${id}-act`).justify_end().gap(4)
      .child(this.copyBtn(t, id, plainCopy(text)))
      .child(div().id(`${id}-sel-btn`).flex_none().px(6).rounded(4).text_size(11).cursor_pointer()
        .text_color(selecting ? t.accent : t.dim).hover((st) => st.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { selecting ? this.selecting.delete(id) : this.selecting.add(id); this.refresh(cx); })
        .child(selecting ? "Done selecting" : "Select text"));
  }

  selectable(id, text) { return TextView.markdown(`${id}-sel`, text).selectable(true); }

  // An open tool row: the whole command (8 lines, then "Show all"), then the first output lines.
  // Both are selectable text, so a command can be copied by hand too.
  toolBody(t, it, r, id) {
    const CMD_LINES = 8;
    const cmd = String(it.detail ?? "");
    const lines = cmd.split("\n");
    const all = this.open.has(`${id}-cmdall`);
    const shown = all ? cmd : lines.slice(0, CMD_LINES).join("\n");
    const fence = (text) => "```\n" + text.replace(/```/g, "` ` `") + "\n```";
    return v_flex().px(10).py(6).gap(4).bg(t.chrome).rounded_b(6).text_size(11)
      .when(Boolean(cmd), (el) => el
        .child(h_flex().justify_between().items_center()
          .child(div().text_size(10.5).text_color(t.dim).child(lines.length > 1 ? `Command · ${lines.length} lines` : "Command"))
          .child(this.copyBtn(t, `${id}-cmd2`, cmd, "Copy command")))
        .child(div().text_color(t.ansi3).child(TextView.markdown(`${id}-cmdtext`, fence(shown)).selectable(true)))
        .when(lines.length > CMD_LINES, (x) => x.child(div().id(`${id}-cmdmore`).text_size(11.5).text_color(t.accent).cursor_pointer()
          .on_click((_e, cx) => { all ? this.open.delete(`${id}-cmdall`) : this.open.add(`${id}-cmdall`); this.refresh(cx); })
          .child(all ? "Show less" : `Show all ${lines.length} lines`))))
      .child(div().text_color(r.err ? t.blocked : t.muted)
        .child(TextView.markdown(`${id}-out`, fence(r.head.join("\n") || " ")).selectable(true)))
      .when(r.more > 0, (x) => x.child(div().text_color(t.dim).child(`+${r.more} more lines`)));
  }

  // ---- items ----

  item(t, it, i, results, answers, compact) {
    const id = `it-${i}`;
    // Over the word budget: one cheap line that opens the message on click.
    if (compact && ["user", "peer", "asst", "recap"].includes(it.k) && !this.open.has(id)) {
      const who = it.k === "user" ? "You" : it.k === "peer" ? it.from : it.k === "recap" ? "While you were away" : "Claude";
      return h_flex().id(id).gap(8).px(14).py(5).text_size(12).cursor_pointer().hover((s) => s.bg(t.hover))
        .border_b(1).border_color(t.border).on_click((_e, cx) => { this.open.add(id); this.refresh(cx); })
        .child(div().flex_none().font_weight(700).text_color(it.k === "peer" ? t.accent : it.k === "user" ? t.foreground : t.muted).child(who))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(String(it.text).replace(/\s+/g, " ").slice(0, 300)))
        .child(div().flex_none().text_color(t.dim).child(clock(it.t)));
    }
    if (it.k === "user") {
      // Images pasted into a message (herdr's terminal paste or the Reader's) show as thumbnails.
      const pics = [...it.text.matchAll(/[A-Za-z]:[\\/][^\s"'<>|]+?\.(?:png|jpe?g|gif|webp)\b/gi)].map((m) => m[0]).slice(0, 4);
      return v_flex().id(id).gap(3).px(14).py(9).bg(t.surface).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).text_size(11).text_color(t.dim).child(div().text_color(t.foreground).font_weight(700).child("You")).child(clock(it.t)))
        .when(pics.length > 0, (el) => el.child(h_flex().flex_wrap().gap(6)
          .children(pics.map((p, k) => image(p).id(`${id}-img${k}`).max_w(220).max_h(160).rounded(6).border_1().border_color(t.border)))))
        .child(this.selecting.has(id) ? this.selectable(id, it.text) : this.inline(t, it.text.length > 1200 ? `${it.text.slice(0, 1200)}…` : it.text, `${id}-x`))
        .child(this.actions(t, id, it.text));
    }
    if (it.k === "peer") {
      return v_flex().id(id).gap(3).px(14).py(9).border_l(3).border_color(t.accent).bg(t.surface).border_b(1)
        .child(h_flex().gap(8).text_size(11).text_color(t.dim).child(div().text_color(t.accent).font_weight(700).child(it.from)).child(it.pasted ? "pasted by you" : "message from another agent").child(clock(it.t)))
        .child(this.selecting.has(id) ? this.selectable(id, it.text) : this.inline(t, it.text.length > 1500 && !this.open.has(`${id}-all`) ? `${it.text.slice(0, 1500)}…` : it.text, `${id}-x`))
        .when(!this.selecting.has(id) && it.text.length > 1500 && !this.open.has(`${id}-all`), (el) => el.child(div().id(`${id}-more`).text_size(11.5).text_color(t.accent).cursor_pointer()
          .on_click((_e, cx) => { this.open.add(`${id}-all`); this.refresh(cx); }).child("Show all")))
        .child(this.actions(t, id, it.text));
    }
    if (it.k === "asst") {
      const long = it.text.length > LONG && !this.open.has(id);
      const text = long ? `${it.text.slice(0, LONG)}…` : it.text;
      const selecting = this.selecting.has(id);
      return v_flex().id(id).gap(4).px(14).py(7)
        .child(selecting ? this.selectable(id, it.text) : this.rich(t, text, `${id}-r`))
        .when(long && !selecting, (el) => el.child(div().id(`${id}-more`).text_size(11.5).text_color(t.accent).cursor_pointer()
          .on_click((_e, cx) => { this.open.add(id); this.refresh(cx); }).child(`Show more (${(it.text.length - LONG).toLocaleString()} characters)`)))
        .child(this.actions(t, id, it.text));
    }
    if (it.k === "tool") {
      const r = results.get(it.id);
      const isOpen = this.open.has(id) || (r?.err && !this.open.has(`${id}-shut`));
      const mark = !r ? div().text_color(t.working).child("…") : r.err ? div().text_color(t.blocked).child("✗") : div().text_color(t.done).child("✓");
      return v_flex().id(id).mx(14).my(2)
        .child(h_flex().id(`${id}-row`).gap(8).px(8).py(3).rounded(6).bg(t.chrome).border_1().border_color(r?.err ? t.blocked : t.border)
          .text_size(11.5).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { if (isOpen) { this.open.delete(id); this.open.add(`${id}-shut`); } else { this.open.add(id); this.open.delete(`${id}-shut`); } this.refresh(cx); })
          .child(div().flex_none().text_color(t.ansi6).font_weight(700).child(it.name))
          .child(div().flex_1().min_w(0).truncate().text_color(it.file ? t.ansi6 : t.muted).child(it.file ? base(it.file) : it.label || ""))
          .when(Boolean(r?.image), (el) => el.child(div().flex_none().text_color(t.dim).child("image")))
          .when(Boolean(it.detail), (el) => el.child(this.copyBtn(t, `${id}-cmd`, it.detail)))
          .child(mark))
        .when(Boolean(isOpen && r), (el) => el.child(this.toolBody(t, it, r, id)));
    }
    if (it.k === "ask") {
      const answer = answers.get(it.id);
      return v_flex().id(id).mx(14).my(4).p(10).gap(6).rounded(8).border_1().border_color(t.accent).bg(t.surface)
        .children(it.questions.map((q, j) => v_flex().id(`${id}-q${j}`).gap(4)
          .child(div().text_color(t.foreground).font_weight(700).child(q.question))
          .children(q.options.map((o, k) => h_flex().id(`${id}-q${j}-${k}`).gap(6).items_start().text_size(12)
            .child(div().flex_none().text_color(t.accent).font_weight(700).child(String(k + 1)))
            .child(v_flex().min_w(0).child(div().text_color(t.foreground).child(o.label)).when(Boolean(o.description), (el) => el.child(div().text_color(t.dim).child(o.description))))))))
        .child(div().text_size(12).text_color(answer ? t.done : t.working).child(answer ? `✓ You answered: ${answer}` : "Waiting for your answer"));
    }
    if (it.k === "recap") {
      return div().id(id).mx(14).my(4).px(10).py(6).rounded(7).border_1().border_color(t.border).text_size(12)
        .child(this.inline(t, `While you were away: ${it.text}`, `${id}-x`, { color: t.muted }));
    }
    if (it.k === "sys") {
      if (it.kind === "summary") {
        const isOpen = this.open.has(id);
        return v_flex().id(id).px(14).py(5).text_size(11.5).text_color(t.dim).cursor_pointer()
          .on_click((_e, cx) => { isOpen ? this.open.delete(id) : this.open.add(id); this.refresh(cx); })
          .child(`Summary of the earlier conversation (${it.text.split(/\s+/).length.toLocaleString()} words) · ${isOpen ? "hide" : "show"}`)
          .when(isOpen, (el) => el.child(div().pt(6).child(this.rich(t, it.text, `${id}-r`))));
      }
      const glyph = { compact: "✂", task: it.ok === false ? "✗" : "✓", cmd: "›", interrupt: "■" }[it.kind] ?? "·";
      const tone = it.kind === "task" ? (it.ok === false ? t.blocked : t.done) : t.dim;
      return h_flex().id(id).gap(8).px(14).py(4).text_size(11.5).text_color(t.dim)
        .when(it.kind === "compact", (el) => el.justify_center().border_t(1).border_b(1).border_color(t.border).py(7))
        .child(div().text_color(tone).child(glyph)).child(div().min_w(0).truncate().child(it.text)).child(div().text_color(t.dim).child(clock(it.t)));
    }
    return null;
  }

  // ---- the dock: what Claude waits on, at the bottom of the chat ----

  dock(t) {
    const pane = panes().find((p) => p.terminal === this.terminal);
    const status = pane?.status ?? null;
    if (status === "working" || Date.now() - this.sentAt < 8000) return null;
    const frame = (title, body) => v_flex().id("dock").flex_none().gap(8).px(14).py(10).border_t(2).border_color(t.accent).bg(t.surface)
      .child(h_flex().gap(8).text_size(12.5).font_weight(700).text_color(t.accent).child("◆").child(title))
      .children(body);
    const btn = (id, label, primary, onClick) => div().id(id).px(10).py(3).rounded(6).text_size(12).cursor_pointer()
      .bg(primary ? t.accent : t.raised).text_color(primary ? t.accent_foreground : t.foreground).border_1().border_color(primary ? t.accent : t.input)
      .hover((s) => s.opacity(0.85)).on_click(onClick).child(label);
    // Claude's multiple-choice pop-up shows one question at a time in the terminal, so every
    // question is drawn here from the transcript with its own options. Send presses the pop-up's
    // keys: per question Down to the option and Enter (which moves on), then Enter on "Submit
    // answers" when there was more than one. Multi-select questions use the screen mirror below.
    const ask = this.waiting.ask;
    if (ask && ask.questions.length && !ask.questions.some((q) => q.multi)) {
      if (this.askId !== ask.id) { this.askId = ask.id; this.askPicks = {}; }
      const picks = this.askPicks;
      const ready = ask.questions.every((_q, j) => picks[j] !== undefined);
      const submit = (_e, cx) => {
        if (!ready) return;
        const keys = [];
        ask.questions.forEach((_q, j) => { for (let d = 0; d < picks[j]; d++) keys.push("down"); keys.push("enter"); });
        if (ask.questions.length > 1) keys.push("enter");
        exec("hc", ["keys", this.terminal, ...keys]);
        this.sentAt = Date.now();
        this.refresh(cx);
      };
      return frame(ask.questions.length > 1 ? `Claude asks ${ask.questions.length} questions` : "Claude asks", [
        ...ask.questions.map((q, j) => v_flex().id(`aq-${j}`).gap(4)
          .child(h_flex().gap(8).items_center()
            .when(Boolean(q.header), (el) => el.child(div().flex_none().px(6).rounded(4).bg(t.raised).text_size(11).text_color(t.muted).child(q.header)))
            .child(div().flex_1().min_w(0).text_size(12.5).font_weight(600).text_color(t.foreground).child(q.question)))
          .children(q.options.map((o, k) => h_flex().id(`aq-${j}-${k}`).gap(8).items_start().px(8).py(4).rounded(6).cursor_pointer()
            .border_1().border_color(picks[j] === k ? t.accent : t.input).bg(picks[j] === k ? t.selected : t.background)
            .hover((st) => st.border_color(t.accent))
            .on_click((_e, cx) => { this.askPicks = { ...this.askPicks, [j]: k }; this.refresh(cx); })
            .child(div().flex_none().text_color(t.accent).font_weight(700).child(String(k + 1)))
            .child(v_flex().flex_1().min_w(0)
              .child(div().text_size(12.5).text_color(t.foreground).child(o.label))
              .when(Boolean(o.description), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(o.description))))))),
        h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.dim)
            .child(ready ? "Ready to send" : `${ask.questions.filter((_q, j) => picks[j] !== undefined).length} of ${ask.questions.length} answered`))
          .child(btn("ask-term", "Other answer in terminal", false, () => this.showTerminal(true)))
          .child(btn("ask-send", "Send answers", ready, submit)),
      ]);
    }
    // A prompt drawn in the terminal (permission, multi-select): its question and one button per
    // option it really has. A press moves the cursor to that option and presses Enter. The screen
    // itself is one click away; when no options can be read, the key pad below stays.
    if (status === "blocked" || this.waiting.ask) {
      const key = (id, label, k, primary) => btn(`k-${id}`, label, primary, () => this.keys(k));
      const prompt = readPrompt(this.screen);
      if (prompt) {
        const choose = (i) => {
          const d = i - prompt.cursor;
          const keys = [...Array(Math.abs(d)).fill(d > 0 ? "down" : "up"), "enter"];
          exec("hc", ["keys", this.terminal, ...keys]);
          this.sentAt = Date.now() - 6500;
          this.screen = null;
          // "Type something." opens a text field in the pop-up: type it in the terminal.
          if (/^type something/i.test(prompt.options[i].label)) this.showTerminal(true);
        };
        const showScreen = this.open.has("dock-screen");
        const plan = this.plan;
        return frame(plan ? "Claude wrote a plan" : prompt.ask || this.waiting.ask ? "Claude asks you to choose" : "Claude needs your permission", [
          ...(plan ? [v_flex().id("plan").max_h(Math.max(200, this.height * 0.6)).overflow_y_scroll().p(10).rounded(6)
            .bg(t.background).border_1().border_color(t.border).child(this.rich(t, plan.text, "plan"))] : []),
          ...(plan ? [] : prompt.context).map((l, j) => div().id(`pc-${j}`).text_size(12).text_color(t.muted).child(l)),
          div().text_size(13).font_weight(600).text_color(t.foreground).child(prompt.question),
          ...prompt.options.map((o, i) => h_flex().id(`po-${o.n}`).gap(10).items_start().w_full().px(10).py(7).rounded(7).cursor_pointer()
            .border_1().border_color(o.current ? t.accent : t.input).bg(t.background).hover((st) => st.border_color(t.accent).bg(t.hover))
            .on_click(() => choose(i))
            .child(div().flex_none().text_color(t.accent).font_weight(700).child(String(o.n)))
            .child(v_flex().flex_1().min_w(0)
              .child(div().text_size(12.5).text_color(t.foreground).child(o.label))
              .when(Boolean(o.more), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(o.more))))),
          h_flex().flex_wrap().gap(6)
            .when(prompt.esc, (el) => el.child(key("esc", "Cancel (Esc)", "esc")))
            .when(prompt.tab, (el) => el.child(key("tab", "Amend (Tab)", "tab")))
            .child(btn("scr", showScreen ? "Hide terminal text" : "Terminal text", false, (_e, cx) => { showScreen ? this.open.delete("dock-screen") : this.open.add("dock-screen"); this.refresh(cx); }))
            .child(btn("term", "Show terminal", false, () => this.showTerminal(true))),
          ...(showScreen ? [v_flex().id("screen").p(8).rounded(6).bg(t.chrome).border_1().border_color(t.border).font_family("Cascadia Mono").text_size(11)
            .text_color(t.muted).overflow_x_scroll().children(this.screen.slice(-30).map((l, j) => div().id(`sc-${j}`).whitespace_nowrap().child(l)))] : []),
        ]);
      }
      return frame(this.waiting.ask ? "Claude asks you to choose" : "Claude needs your permission", [
        v_flex().id("screen").p(8).rounded(6).bg(t.chrome).border_1().border_color(t.border).font_family("Cascadia Mono").text_size(11.5)
          .text_color(t.foreground).overflow_x_scroll()
          .children((this.screen ?? ["Reading the prompt..."]).map((l, j) => div().id(`sc-${j}`).whitespace_nowrap().child(l))),
        h_flex().flex_wrap().gap(6)
          .child(key("1", "1", "1", true)).child(key("2", "2", "2")).child(key("3", "3", "3")).child(key("4", "4", "4"))
          .child(key("up", "\u2191", "up")).child(key("down", "\u2193", "down")).child(key("tab", "Tab", "tab"))
          .child(key("enter", "Enter", "enter", true)).child(key("esc", "Esc", "esc"))
          .child(btn("term", "Show terminal", false, () => this.showTerminal(true))),
      ]);
    }
    const q = this.waiting.question;
    if (!q) return null;
    // One question with numbered options ("One answer is still open: 1. ... 2. ..."): tap to send.
    if (q.single && q.numbered?.[0]?.options.length) {
      const x = q.numbered[0];
      return frame("Claude is waiting on you", [
        this.inline(t, x.q, "dq-text"),
        ...x.options.map((o) => h_flex().id(`so-${o.n}`).gap(8).items_center().px(8).py(5).rounded(6).cursor_pointer()
          .border_1().border_color(t.input).bg(t.background).hover((s) => s.border_color(t.accent))
          .on_click((_e, cx) => this.send(String(o.n), cx))
          .child(div().flex_none().text_color(t.accent).font_weight(700).child(String(o.n)))
          .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.foreground).child(o.label))),
      ]);
    }
    if (q.numbered?.length) {
      const draft = q.numbered.map((x) => `${x.n}. ${this.picks[x.n] ?? "…"}`).join(" ");
      const ready = q.numbered.every((x) => this.picks[x.n]);
      return frame(`Claude is waiting on you · ${q.numbered.length} questions`, [
        // Each question: its own options as numbered toggles (the agent's "- 1: ..." list), else yes/no.
        ...q.numbered.map((x) => v_flex().id(`nq-${x.n}`).gap(3)
          .child(h_flex().gap(8).items_center().text_size(12.5)
            .child(div().flex_none().text_color(t.accent).font_weight(700).child(String(x.n)))
            .child(div().flex_1().min_w(0).text_color(t.foreground).child(x.q))
            .child(h_flex().flex_none().rounded(5).border_1().border_color(t.input).overflow_hidden()
              .children((x.options.length ? x.options.map((o) => String(o.n)) : ["yes", "no"]).map((v) => div().id(`nq-${x.n}-${v}`).px(8).text_size(11.5).cursor_pointer()
                .bg(this.picks[x.n] === v ? t.accent : t.background).text_color(this.picks[x.n] === v ? t.accent_foreground : t.muted)
                .tooltip(x.options.find((o) => String(o.n) === v)?.label ?? v)
                .on_click((_e, cx) => { this.picks = { ...this.picks, [x.n]: v }; this.refresh(cx); }).child(v)))))
          .children(x.options.map((o) => div().id(`nqo-${x.n}-${o.n}`).pl(18).text_size(11.5)
            .text_color(this.picks[x.n] === String(o.n) ? t.foreground : t.muted).child(`${o.n}  ${o.label}`)))),
        h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().font_family("Cascadia Mono").text_size(11.5).text_color(t.muted).child(draft))
          .child(btn("edit", "Reply in chat", false, () => this.goToChat()))
          .child(btn("send", "Send answers", ready, (_e, cx) => { if (ready) this.send(draft, cx); })),
      ]);
    }
    if (q.open) {
      return frame("Claude is waiting on you", [
        this.inline(t, q.text, "dq-text"),
        ...(q.choices ?? []).map((o) => h_flex().id(`co-${o.n}`).gap(8).items_center().px(8).py(5).rounded(6).cursor_pointer()
          .border_1().border_color(t.input).bg(t.background).hover((st) => st.border_color(t.accent))
          .on_click((_e, cx) => this.send(o.send, cx))
          .child(div().flex_none().text_color(t.accent).font_weight(700).child(String(o.n)))
          .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.foreground).child(o.label))),
        h_flex().gap(6).child(btn("reply", "Reply in chat", true, () => this.goToChat())),
      ]);
    }
    return frame("Claude is waiting on you", [
      this.inline(t, q.text, "dq-text"),
      h_flex().gap(6)
        .child(btn("yes", "Yes", true, (_e, cx) => this.send("yes", cx)))
        .child(btn("no", "No", false, (_e, cx) => this.send("no", cx)))
        .child(btn("reply", "Reply in chat", false, () => this.goToChat())),
    ]);
  }

  // ---- this agent: decisions, running, touched ----

  side(t) {
    const head = (text, n) => h_flex().justify_between().text_size(10.5).font_weight(700).text_color(t.dim).child(text.toUpperCase()).child(n === undefined ? "" : String(n));
    const decisions = [...(this.agg.decisions ?? [])].reverse().slice(0, 8);
    const running = Object.entries(this.agg.running ?? {});
    const prs = Object.values(this.agg.prs ?? {}).slice(-12).reverse(); // newest mention first
    const tickets = (this.agg.tickets ?? []).slice(-6);
    const files = (this.agg.files ?? []).slice(-8);
    const chip = (id, text, color, href) => div().id(id).px(6).rounded(5).bg(t.raised).border_1().border_color(t.border).text_size(11)
      .text_color(color).font_family("Cascadia Mono").when(Boolean(href), (el) => el.cursor_pointer().tooltip(href).on_click((_e, cx) => cx.open_url(href))).child(text);
    return v_flex().id("side").w(220).h_full().flex_none().gap(10).p(10).border_l(1).border_color(t.border).bg(t.chrome).overflow_y_scroll()
      .child(head("Decisions in this chat", this.agg.decisions?.length ?? 0))
      .child(v_flex().gap(6).children(decisions.length ? decisions.map((d, i) => v_flex().id(`d-${i}`).text_size(11.5)
        .child(h_flex().gap(6).child(div().flex_none().text_color(t.dim).child(clock(d.t))).child(div().min_w(0).truncate().text_color(t.foreground).tooltip(d.q).child(d.a)))
        .child(div().pl(42).truncate().text_color(t.dim).child(d.q))) : [div().text_size(11.5).text_color(t.dim).child("None yet")]))
      .child(head("Running", running.length))
      .child(v_flex().gap(4).children(running.length ? running.map(([k, r]) => h_flex().id(`run-${k}`).gap(6).text_size(11.5).text_color(t.muted)
        .child(svg(ICON("spinner")).size(10).flex_none().text_color(t.working).when(!shared("ui.calm"), (el) => el.spin(900))).child(div().min_w(0).truncate().child(r.label))) : [div().text_size(11.5).text_color(t.dim).child("Nothing")]))
      .child(head("Touched in this chat"))
      .child(h_flex().flex_wrap().gap(4)
        .children(prs.map((p, i) => chip(`pr-${i}`, `${p.repo}#${p.number}`, t.accent, p.url)))
        .children(tickets.map((k, i) => chip(`tk-${i}`, k, t.ansi4, this.ticketUrl(k))))
        .children(files.map((f, i) => chip(`f-${i}`, base(f), t.ansi6, null).tooltip(f))));
  }

  // Repaints this view and the retained message list.
  refresh(cx) {
    cx.notify();
    if (this.streamView) cx.notify(this.streamView);
  }

  renderStream(cx) {
    const t = theme();
    const results = new Map(this.items.filter((x) => x.k === "result").map((x) => [x.id, x]));
    const answers = new Map(this.items.filter((x) => x.k === "answer").map((x) => [x.id, x.text]));
    const visible = this.items.filter((x) => x.k !== "result" && x.k !== "answer");
    const from = Math.max(0, visible.length - this.shown);
    const pendingRows = this.pending.map((m, i) => v_flex().id(`pend-${i}`).gap(3).px(14).py(9).bg(t.surface).border_b(1).border_color(t.border).opacity(0.7)
      .child(h_flex().gap(8).text_size(11).text_color(t.dim).child(div().text_color(t.foreground).font_weight(700).child("You")).child("sending..."))
      .child(this.inline(t, m.text.length > 1200 ? `${m.text.slice(0, 1200)}...` : m.text, `pend-${i}-x`)));
    // Build from the newest message back and stop drawing in full once the frame has spent its
    // budget (by words and by time): older messages draw as one line each. A message drawn in
    // full stays in full, so heights do not change between redraws and the view does not jump.
    const slice = visible.slice(from);
    const started = Date.now();
    let budget = WORD_BUDGET;
    const built = [];
    for (let j = slice.length - 1; j >= 0; j--) {
      const key = `${slice[j].k}|${slice[j].t}|${slice[j].id ?? ""}|${String(slice[j].text ?? "").length}`;
      const compact = !this.full.has(key) && (budget <= 0 || Date.now() - started > RENDER_MS);
      if (!compact) {
        this.full.add(key);
        budget -= ["user", "peer", "asst", "recap"].includes(slice[j].k) ? Math.min(wordsIn(slice[j]), 400) : 4;
      }
      built.push(this.item(t, slice[j], from + j, results, answers, compact));
    }
    const rows = built.reverse().filter(Boolean).concat(pendingRows);
    // Follow scrolls to an empty marker after the last message: revealing a message taller than
    // the view only shows its top, which left the view a few scrolls short of the bottom.
    // scroll_to_item takes a real child index and is consumed after layout.
    if (this.toBottom) { this.toBottom = false; this.scroll.scroll_to_item(rows.length + (from > 0 ? 1 : 0)); }
    return v_flex().id("stream").size_full().min_h(0).overflow_y_scroll().track_scroll(this.scroll).pb(8)
      .bg(t.background).text_size(12.5).text_color(t.foreground)
      .when(from > 0, (el) => el.child(div().id("earlier").px(14).py(6).text_size(11.5).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => { this.shown += SHOWN; this.follow = false; this.refresh(cx); })
        .child(`Show earlier (${from.toLocaleString()} more)`)))
      .children(rows)
      .child(div().id("stream-end").h(1).flex_none())
      .when(!this.items.length, (el) => el.child(div().p(14).text_size(12).text_color(t.dim)
        .child(this.sessionOf() ? "Reading the chat…" : "No Claude session in this pane yet.")));
  }

  render(cx) {
    const t = theme();
    if (this.auto) return div().size_full();
    // A Reader in a tab that is not shown draws nothing: herdr repaints every copy on each change.
    if (!this.isShown()) return div().size_full().bg(t.background);
    if (this.stale && this.isShown()) { this.stale = false; cx.spawn(async (cx) => { await this.load(cx); }); }
    const pane = panes().find((p) => p.terminal === this.terminal);
    const status = pane?.status;
    const dock = this.dock(t);
    const wide = this.width >= 640;

    const header = h_flex().id("hdr").flex_none().h(34).px(12).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(div().flex_none().text_size(12).font_weight(700).text_color(t.accent).child("Reader"))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(this.title ?? pane?.title ?? ""))
      .when(Boolean(this.usage?.model ?? this.model), (el) => el.child(this.usageChip(t)))
      .child(div().flex_none().text_size(11).text_color(status === "working" ? t.working : status === "blocked" ? t.blocked : t.dim).child(status ?? ""))
      .child(div().id("follow").flex_none().px(6).rounded(4).text_size(11).cursor_pointer()
        .bg(this.follow ? t.selected : t.chrome).text_color(this.follow ? t.foreground : t.dim)
        .tooltip(this.follow ? "Following new messages. Click to stop." : "Click to follow new messages.")
        .on_click((_e, cx) => { this.follow = !this.follow; if (this.follow) this.toBottom = true; this.refresh(cx); })
        .child("Follow"))
      .child(div().id("term").flex_none().px(6).rounded(4).text_size(11).cursor_pointer().bg(t.chrome).text_color(t.muted).hover((s) => s.bg(t.hover))
        .tooltip(this.myPane()?.zoomed ? "Show the Claude terminal beside the Reader" : "Cover the terminal with the Reader")
        .on_click(() => this.showTerminal(Boolean(this.myPane()?.zoomed)))
        .child(this.myPane()?.zoomed ? "Terminal" : "Reader only"));

    const term = terminals().find((x) => x.address === this.terminal);
    const report = typeof term?.report === "string" ? term.report : term?.report?.msg ?? term?.report?.message ?? null;
    const activity = status === "working" ? h_flex().id("activity").flex_none().gap(8).items_center().px(14).py(6).border_t(1).border_color(t.border).bg(t.chrome)
      .child(svg(ICON("spinner")).size(11).flex_none().text_color(t.working).when(!shared("ui.calm"), (el) => el.spin(900)))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(report || "Claude is working..."))
      .child(div().id("stop").flex_none().px(8).py(2).rounded(5).text_size(11.5).cursor_pointer().border_1().border_color(t.blocked).text_color(t.blocked)
        .hover((s) => s.bg(t.hover)).tooltip("Stop this turn (Esc in the terminal)").on_click(() => exec("hc", ["interrupt", this.terminal])).child("Stop")) : null;
    const leftover = this.leftover ? v_flex().id("leftover").flex_none().gap(6).px(14).py(8).border_t(1).border_color(t.border).bg(t.surface)
      .child(div().text_size(12.5).text_color(t.foreground)
        .child(`The box still had "${this.leftover.old}" from your last message. Send "${this.leftover.rest}" instead?`))
      .child(h_flex().gap(6)
        .child(div().id("lo-rest").px(10).py(3).rounded(6).text_size(12).cursor_pointer().bg(t.accent).text_color(t.accent_foreground)
          .on_click((_e, cx) => { this.input.set_value(this.leftover.rest); this.leftover = null; this.sendInput(cx, true); })
          .child(`Send "${this.leftover.rest.slice(0, 40)}"`))
        .child(div().id("lo-all").px(10).py(3).rounded(6).text_size(12).cursor_pointer().bg(t.raised).border_1().border_color(t.input)
          .on_click((_e, cx) => { this.leftover = null; this.sendInput(cx, true); })
          .child("Send all of it"))
        .child(div().id("lo-edit").px(10).py(3).rounded(6).text_size(12).cursor_pointer().text_color(t.muted)
          .on_click((_e, cx) => { this.leftover = null; this.input.focus(); this.refresh(cx); })
          .child("Edit"))) : null;
    const composer = h_flex().id("composer").flex_none().gap(8).items_end().px(10).py(8).border_t(1).border_color(t.border).bg(t.surface)
      .child(div().flex_1().min_w(0).rounded(7).border_1().border_color(t.input).bg(t.background).p(4)
        .child(Textarea.new(this.input).w_full().text_size(12.5)))
      .child(div().id("send").flex_none().px(12).py(5).rounded(7).text_size(12.5).font_weight(600).cursor_pointer()
        .bg(t.accent).text_color(t.accent_foreground).hover((s) => s.opacity(0.85)).on_click((_e, cx) => this.sendInput(cx)).child("Send"));

    return v_flex().id("reader").size_full().min_h(0).overflow_hidden().bg(t.background).text_size(12.5).text_color(t.foreground)
      .on_size_change((size, cx) => { this.height = size.height; if (Math.abs(size.width - this.width) > 2) { this.width = size.width; this.refresh(cx); } })
      .child(header)
      .child(h_flex().flex_1().min_h(0).overflow_hidden()
        .child(v_flex().flex_1().h_full().min_w(0).min_h(0).overflow_hidden().child(div().flex_1().min_h(0).child(this.streamView))
          .when(Boolean(activity), (el) => el.child(activity)).when(Boolean(dock), (el) => el.child(dock)).when(Boolean(leftover), (el) => el.child(leftover)).child(composer))
        .when(wide, (el) => el.child(this.side(t))));
  }
}
