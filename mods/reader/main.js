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

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, TextareaState, Textarea } from "gpui-base";
import { exec, appHome, home, readTextFile, theme, props, panes, terminals, focused, shared, setShared, run, watchFolder, checking } from "herdr";

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

export default class Reader extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.auto = Boolean(p.auto);
    if (this.auto) {
      if (!checking()) cx.timer.every(3000, () => this.autoOpen());
      return;
    }
    this.terminal = p.terminal ?? null;
    this.items = [];
    this.agg = { decisions: [], running: {}, prs: {}, tickets: [], files: [] };
    this.waiting = { question: null, ask: null };
    this.title = null;
    this.session = null;
    this.path = null;
    this.shown = SHOWN;
    this.open = new Set(); // expanded tool rows, long replies and summaries
    this.picks = {}; // numbered question -> "yes" | "no"
    this.sentAt = 0;
    this.width = 0;
    this.scroll = ScrollHandle.new();
    this.follow = true;
    this.input = TextareaState.new({ placeholder: "Message Claude", rows: 2 });
    this.input.set_auto_grow(1, 8);
    this.input.on("submit", (_e, cx) => this.sendInput(cx));
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

  // Covers the terminal the first time it shows, and mirrors the terminal's screen while Claude
  // waits on a prompt that lives only there (a permission, a multiple-choice question).
  async tick(cx) {
    if (!this.isShown()) return;
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
      this.screen = lines.slice(-18);
      cx.notify();
    } else if (this.screen) { this.screen = null; cx.notify(); }
  }

  async sendInput(cx) {
    const text = this.input.value().replace(/\s+$/, "");
    if (!text.trim()) return;
    this.input.set_value("");
    this.pending.push({ text, t: new Date().toISOString() });
    this.follow = true;
    this.toBottom = true;
    await this.send(text, cx);
  }

  keys(key) { exec("hc", ["keys", this.terminal, key]); }

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
      if (first) { this.session = session; this.shown = SHOWN; this.open.clear(); }
      this.items = data.replaced ? data.items : this.items.concat(data.items).slice(-1200);
      const said = new Set(data.items.filter((x) => x.k === "user").map((x) => x.text.trim()));
      this.pending = this.pending.filter((m) => !said.has(m.text.trim()) && Date.now() - Date.parse(m.t) < 120000);
      this.agg = data.agg;
      this.waiting = data.waiting ?? this.waiting;
      this.title = data.title;
      if (data.path && data.path !== this.path) { this.path = data.path; this.watch(cx); }
      if ((first || data.items.length) && this.follow) this.toBottom = true;
      cx.notify();
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

  async close() { this.watcher?.cancel(); this.scroll?.release(); }

  // Types the answer into the chat (hx wakes a sleeping pane first), as if Alex typed it.
  async send(text, cx) {
    this.sentAt = Date.now();
    this.picks = {};
    cx.notify();
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

  // ---- items ----

  item(t, it, i, results, answers, compact) {
    const id = `it-${i}`;
    // Over the word budget: one cheap line that opens the message on click.
    if (compact && ["user", "peer", "asst", "recap"].includes(it.k) && !this.open.has(id)) {
      const who = it.k === "user" ? "You" : it.k === "peer" ? it.from : it.k === "recap" ? "While you were away" : "Claude";
      return h_flex().id(id).gap(8).px(14).py(5).text_size(12).cursor_pointer().hover((s) => s.bg(t.hover))
        .border_b(1).border_color(t.border).on_click((_e, cx) => { this.open.add(id); cx.notify(); })
        .child(div().flex_none().font_weight(700).text_color(it.k === "peer" ? t.accent : it.k === "user" ? t.foreground : t.muted).child(who))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(String(it.text).replace(/\s+/g, " ").slice(0, 300)))
        .child(div().flex_none().text_color(t.dim).child(clock(it.t)));
    }
    if (it.k === "user") {
      return v_flex().id(id).gap(3).px(14).py(9).bg(t.surface).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).text_size(11).text_color(t.dim).child(div().text_color(t.foreground).font_weight(700).child("You")).child(clock(it.t)))
        .child(this.inline(t, it.text.length > 1200 ? `${it.text.slice(0, 1200)}…` : it.text, `${id}-x`));
    }
    if (it.k === "peer") {
      return v_flex().id(id).gap(3).px(14).py(9).border_l(3).border_color(t.accent).bg(t.surface).border_b(1)
        .child(h_flex().gap(8).text_size(11).text_color(t.dim).child(div().text_color(t.accent).font_weight(700).child(it.from)).child(it.pasted ? "pasted by you" : "message from another agent").child(clock(it.t)))
        .child(this.inline(t, it.text.length > 1500 && !this.open.has(`${id}-all`) ? `${it.text.slice(0, 1500)}…` : it.text, `${id}-x`))
        .when(it.text.length > 1500 && !this.open.has(`${id}-all`), (el) => el.child(div().id(`${id}-more`).text_size(11.5).text_color(t.accent).cursor_pointer()
          .on_click((_e, cx) => { this.open.add(`${id}-all`); cx.notify(); }).child("Show all")));
    }
    if (it.k === "asst") {
      const long = it.text.length > LONG && !this.open.has(id);
      const text = long ? `${it.text.slice(0, LONG)}…` : it.text;
      return v_flex().id(id).gap(4).px(14).py(7)
        .child(this.rich(t, text, `${id}-r`))
        .when(long, (el) => el.child(div().id(`${id}-more`).text_size(11.5).text_color(t.accent).cursor_pointer()
          .on_click((_e, cx) => { this.open.add(id); cx.notify(); }).child(`Show more (${(it.text.length - LONG).toLocaleString()} characters)`)));
    }
    if (it.k === "tool") {
      const r = results.get(it.id);
      const isOpen = this.open.has(id) || (r?.err && !this.open.has(`${id}-shut`));
      const mark = !r ? div().text_color(t.working).child("…") : r.err ? div().text_color(t.blocked).child("✗") : div().text_color(t.done).child("✓");
      return v_flex().id(id).mx(14).my(2)
        .child(h_flex().id(`${id}-row`).gap(8).px(8).py(3).rounded(6).bg(t.chrome).border_1().border_color(r?.err ? t.blocked : t.border)
          .text_size(11.5).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { if (isOpen) { this.open.delete(id); this.open.add(`${id}-shut`); } else { this.open.add(id); this.open.delete(`${id}-shut`); } cx.notify(); })
          .child(div().flex_none().text_color(t.ansi6).font_weight(700).child(it.name))
          .child(div().flex_1().min_w(0).truncate().text_color(it.file ? t.ansi6 : t.muted).child(it.file ? base(it.file) : it.label || ""))
          .when(Boolean(r?.image), (el) => el.child(div().flex_none().text_color(t.dim).child("image")))
          .child(mark))
        .when(Boolean(isOpen && r), (el) => el.child(v_flex().px(10).py(6).font_family("Cascadia Mono").text_size(11)
          .text_color(r.err ? t.blocked : t.muted).bg(t.chrome).rounded_b(6)
          .when(Boolean(it.detail), (x) => x.child(div().text_color(t.ansi3).child(`$ ${it.detail}`)))
          .children(r.head.map((l, j) => div().id(`${id}-o${j}`).child(l || " ")))
          .when(r.more > 0, (x) => x.child(div().text_color(t.dim).child(`+${r.more} more lines`)))));
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
          .on_click((_e, cx) => { isOpen ? this.open.delete(id) : this.open.add(id); cx.notify(); })
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
    // A prompt drawn in the terminal (permission, multiple choice): show its screen and press its keys.
    if (status === "blocked" || this.waiting.ask) {
      const key = (id, label, k, primary) => btn(`k-${id}`, label, primary, () => this.keys(k));
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
                .on_click((_e, cx) => { this.picks = { ...this.picks, [x.n]: v }; cx.notify(); }).child(v)))))
          .children(x.options.map((o) => div().id(`nqo-${x.n}-${o.n}`).pl(18).text_size(11.5)
            .text_color(this.picks[x.n] === String(o.n) ? t.foreground : t.muted).child(`${o.n}  ${o.label}`)))),
        h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().font_family("Cascadia Mono").text_size(11.5).text_color(t.muted).child(draft))
          .child(btn("edit", "Reply in chat", false, () => this.goToChat()))
          .child(btn("send", "Send answers", ready, (_e, cx) => { if (ready) this.send(draft, cx); })),
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
    const prs = Object.values(this.agg.prs ?? {}).slice(-6);
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
        .child(svg(ICON("spinner")).size(10).flex_none().text_color(t.working).spin(900)).child(div().min_w(0).truncate().child(r.label))) : [div().text_size(11.5).text_color(t.dim).child("Nothing")]))
      .child(head("Touched in this chat"))
      .child(h_flex().flex_wrap().gap(4)
        .children(prs.map((p, i) => chip(`pr-${i}`, `${p.repo}#${p.number}`, t.accent, p.url)))
        .children(tickets.map((k, i) => chip(`tk-${i}`, k, t.ansi4, this.ticketUrl(k))))
        .children(files.map((f, i) => chip(`f-${i}`, base(f), t.ansi6, null).tooltip(f))));
  }

  render(cx) {
    const t = theme();
    if (this.auto) return div().size_full();
    if (this.stale && this.isShown()) { this.stale = false; cx.spawn(async (cx) => { await this.load(cx); }); }
    const pane = panes().find((p) => p.terminal === this.terminal);
    const results = new Map(this.items.filter((x) => x.k === "result").map((x) => [x.id, x]));
    const answers = new Map(this.items.filter((x) => x.k === "answer").map((x) => [x.id, x.text]));
    const visible = this.items.filter((x) => x.k !== "result" && x.k !== "answer");
    const from = Math.max(0, visible.length - this.shown);
    const status = pane?.status;
    const dock = this.dock(t);
    const wide = this.width >= 640;

    const header = h_flex().id("hdr").flex_none().h(34).px(12).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(div().flex_none().text_size(12).font_weight(700).text_color(t.accent).child("Reader"))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(this.title ?? pane?.title ?? ""))
      .child(div().flex_none().text_size(11).text_color(status === "working" ? t.working : status === "blocked" ? t.blocked : t.dim).child(status ?? ""))
      .child(div().id("follow").flex_none().px(6).rounded(4).text_size(11).cursor_pointer()
        .bg(this.follow ? t.selected : t.chrome).text_color(this.follow ? t.foreground : t.dim)
        .tooltip(this.follow ? "Following new messages. Click to stop." : "Click to follow new messages.")
        .on_click((_e, cx) => { this.follow = !this.follow; if (this.follow) this.toBottom = true; cx.notify(); })
        .child("Follow"))
      .child(div().id("term").flex_none().px(6).rounded(4).text_size(11).cursor_pointer().bg(t.chrome).text_color(t.muted).hover((s) => s.bg(t.hover))
        .tooltip(this.myPane()?.zoomed ? "Show the Claude terminal beside the Reader" : "Cover the terminal with the Reader")
        .on_click(() => this.showTerminal(Boolean(this.myPane()?.zoomed)))
        .child(this.myPane()?.zoomed ? "Terminal" : "Reader only"));

    const pendingRows = this.pending.map((m, i) => v_flex().id(`pend-${i}`).gap(3).px(14).py(9).bg(t.surface).border_b(1).border_color(t.border).opacity(0.7)
      .child(h_flex().gap(8).text_size(11).text_color(t.dim).child(div().text_color(t.foreground).font_weight(700).child("You")).child("sending..."))
      .child(this.inline(t, m.text.length > 1200 ? `${m.text.slice(0, 1200)}...` : m.text, `pend-${i}-x`)));
    const term = terminals().find((x) => x.address === this.terminal);
    const report = typeof term?.report === "string" ? term.report : term?.report?.msg ?? term?.report?.message ?? null;
    const activity = status === "working" ? h_flex().id("activity").flex_none().gap(8).items_center().px(14).py(6).border_t(1).border_color(t.border).bg(t.chrome)
      .child(svg(ICON("spinner")).size(11).flex_none().text_color(t.working).spin(900))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(report || "Claude is working..."))
      .child(div().id("stop").flex_none().px(8).py(2).rounded(5).text_size(11.5).cursor_pointer().border_1().border_color(t.blocked).text_color(t.blocked)
        .hover((s) => s.bg(t.hover)).tooltip("Stop this turn (Esc in the terminal)").on_click(() => exec("hc", ["interrupt", this.terminal])).child("Stop")) : null;
    const composer = h_flex().id("composer").flex_none().gap(8).items_end().px(10).py(8).border_t(1).border_color(t.border).bg(t.surface)
      .child(div().flex_1().min_w(0).rounded(7).border_1().border_color(t.input).bg(t.background).p(4)
        .child(Textarea.new(this.input).w_full().text_size(12.5)))
      .child(div().id("send").flex_none().px(12).py(5).rounded(7).text_size(12.5).font_weight(600).cursor_pointer()
        .bg(t.accent).text_color(t.accent_foreground).hover((s) => s.opacity(0.85)).on_click((_e, cx) => this.sendInput(cx)).child("Send"));

    // Build from the newest message back and stop drawing in full once the frame has spent its
    // budget (by words and by time): older messages draw as one line each.
    const slice = visible.slice(from);
    const started = Date.now();
    let budget = WORD_BUDGET;
    const built = [];
    for (let j = slice.length - 1; j >= 0; j--) {
      const compact = budget <= 0 || Date.now() - started > RENDER_MS;
      if (!compact) budget -= ["user", "peer", "asst", "recap"].includes(slice[j].k) ? Math.min(wordsIn(slice[j]), 400) : 4;
      built.push(this.item(t, slice[j], from + j, results, answers, compact));
    }
    const rows = built.reverse().filter(Boolean).concat(pendingRows);
    // scroll_to_item takes a real child index and is consumed after layout, so ask for the last one here.
    if (this.toBottom && rows.length) { this.toBottom = false; this.scroll.scroll_to_item(rows.length - 1 + (from > 0 ? 1 : 0)); }
    const stream = v_flex().id("stream").flex_1().min_h(0).overflow_y_scroll().track_scroll(this.scroll).pb(8)
      .when(from > 0, (el) => el.child(div().id("earlier").px(14).py(6).text_size(11.5).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => { this.shown += SHOWN; this.follow = false; cx.notify(); })
        .child(`Show earlier (${from.toLocaleString()} more)`)))
      .children(rows)
      .when(!this.items.length, (el) => el.child(div().p(14).text_size(12).text_color(t.dim)
        .child(this.sessionOf() ? "Reading the chat…" : "No Claude session in this pane yet.")));

    return v_flex().id("reader").size_full().min_h(0).overflow_hidden().bg(t.background).text_size(12.5).text_color(t.foreground)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 2) { this.width = size.width; cx.notify(); } })
      .child(header)
      .child(h_flex().flex_1().min_h(0).overflow_hidden()
        .child(v_flex().flex_1().h_full().min_w(0).min_h(0).overflow_hidden().child(stream)
          .when(Boolean(activity), (el) => el.child(activity)).when(Boolean(dock), (el) => el.child(dock)).child(composer))
        .when(wide, (el) => el.child(this.side(t))));
  }
}
