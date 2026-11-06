// Workspace summary: every dev workspace with agents, what they are doing and whether their work is
// done, opened from the status bar chip (status-usage). Shells and other terminals are left out.
// Rows come from the live world, so a closed dev workspace or pane drops out at once. The summary
// column comes from Haiku: status-usage re-summarises one agent when it finishes or runs /clear,
// and the Summarize buttons re-run one agent, one dev workspace or all of them. summarize.mjs writes ~/.cache/herdr-app/space-summary.json,
// which this reads.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, terminals, exec, home, theme, closeOverlay, props, shared, setShared, run, readTextFile } from "herdr";

const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const SCRIPT = () => `${home()}/.config/herdr-app/mods/space-summary/summarize.mjs`;
const FILE = () => `${home()}/.cache/herdr-app/space-summary.json`;
export const SUMMARY = "space.summary"; // { at, items }: the cache file, for the status bar chip
const LOCKED = "space.locked"; // set by menu-spaces: a locked dev workspace has no Close
const ART = "space.art"; // set by space-panel: each card's Pokémon and Poké Ball
const RUN_STALE_MS = 3 * 60 * 1000; // a "running" mark this old is from a run that died
const TICKET_KEY = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]+-\d+)/i;
// Collapsed dev workspaces { spaceId: true }, kept across openings; closed spaces are pruned.
const COLLAPSED = "space.summary.collapsed";
const collapsedSet = () => shared(COLLAPSED) ?? {};
function setCollapsed(ids, on) {
  const live = new Set(spaces().map((s) => s.id));
  const next = Object.fromEntries(Object.entries(collapsedSet()).filter(([id]) => live.has(id)));
  for (const id of [].concat(ids)) { if (on) next[id] = true; else delete next[id]; }
  setShared(COLLAPSED, next);
}
const norm = (p) => String(p ?? "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
const ROOT_FOLDER = () => norm(`${home()}/Desktop/dev`);

// The sidebar card's title (space-panel card()): a name given by hand as it is; else the first
// ticket key in the space name, a tab name, an agent title or the branch, as "KEY summary"; else
// the space name. A bare ticket key as the name gets its summary too.
function cardTitle(space, children) {
  const bareKey = space.named && TICKET_KEY.exec(space.name)?.[0] === space.name.trim();
  if (space.named && !bareKey) return space.name;
  const texts = [space.name, ...space.tabs.map((x) => x.name), ...children.map((c) => c.title), space.branch];
  const key = texts.map((x) => x?.match(TICKET_KEY)?.[1]?.toUpperCase()).find(Boolean);
  const ticket = key ? shared("tasks.snapshot")?.tickets?.find((x) => x.key === key) : null;
  return ticket ? `${ticket.key} ${ticket.summary}` : space.name;
}

const RANK = { you: 0, others: 1, working: 2, unknown: 3, cleared: 4, done: 5 };
const LABEL = { you: "Needs you", others: "Waiting", working: "Working", unknown: "Not summarized", cleared: "Cleared", done: "Done" };

const ago = (ms) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
};

// Each dev workspace that has agents, with its agents in tab order; a sub-agent without a pane
// follows its parent. An agent reports a status or carries a Claude session; a shell does neither.
export function world() {
  const live = terminals().filter((x) => x.state === "live");
  const byAddress = new Map(live.map((x) => [x.address, x]));
  const all = panes();
  const shown = new Set(all.map((p) => p.terminal).filter(Boolean));
  return spaces().map((space) => {
    const children = [];
    for (const tab of space.tabs) {
      for (const p of all.filter((q) => q.tab === tab.id && q.terminal)) {
        const x = byAddress.get(p.terminal);
        children.push(child(space, tab, p, x, 0));
        for (const sub of live.filter((s) => s.parent === p.terminal && !shown.has(s.address))) children.push(child(space, tab, null, sub, 1));
      }
    }
    return { space, children: children.filter((c) => c.status || c.session) };
  }).filter((r) => r.children.length);
}

function child(space, tab, pane, x, depth) {
  const status = pane?.status ?? (typeof x?.status === "string" ? x.status : null);
  return {
    id: x?.address ?? pane.pane, space: space.id, tab: tab.id, tabName: tab.name, pane: pane?.pane ?? null, depth,
    title: x?.title || pane?.title || x?.address || "", status,
    session: x?.labels?.["claude.session"] ?? null, turn: x?.turn ?? null,
  };
}

// A child's verdict: live status first (working, blocked), then its cached summary.
export function verdictOf(c, items) {
  if (c.status === "working") return { verdict: "working" };
  if (c.status === "blocked") return { verdict: "you", summary: "Waiting for a permission prompt." };
  if (!c.session) return { verdict: "unknown" };
  const item = items[c.id];
  if (!item) return { verdict: "unknown" };
  return { ...item, verdict: item.verdict ?? "unknown", outdated: item.session !== c.session || item.turn !== c.turn };
}

// A working or blocked agent shows its live state, so a summary of it would not be shown.
const canSummarize = (c) => Boolean(c.session) && c.status !== "working" && c.status !== "blocked";

export function needsSummary(c, items) {
  if (!canSummarize(c)) return false;
  const item = items[c.id];
  return !item || item.session !== c.session || item.turn !== c.turn;
}

export default class SpaceSummary extends View {
  init(_props, cx) {
    this.cache = null;
    this.busy = false;
    this.error = null;
    this.note = null;
    this.armed = null; // the row whose Close/End was pressed once
    this.load(cx);
    cx.timer.every(1500, (cx) => this.load(cx)); // status-usage writes per-agent summaries at any time
    cx.timer.every(30000, (cx) => cx.notify()); // "Summarized 3m ago"
  }

  running() { return this.busy || (this.cache?.running && Date.now() - this.cache.running < RUN_STALE_MS); }

  load(cx) {
    cx.spawn(async (cx) => {
      try {
        const raw = await readTextFile(FILE());
        if (this.cache && raw === this.raw) return;
        this.raw = raw;
        this.cache = raw ? JSON.parse(raw) : { items: {} };
        const mirror = { at: this.cache.at ?? null, items: this.cache.items ?? {} };
        if (JSON.stringify(mirror) !== JSON.stringify(shared(SUMMARY) ?? {})) setShared(SUMMARY, mirror);
      } catch { this.cache = { items: {} }; }
      cx.notify();
    });
  }

  // Summarizes the agents `ids` names (all when null), even when their summary is current.
  summarize(cx, ids = null) {
    if (this.running()) return;
    const rows = world();
    const children = rows.flatMap((r) => r.children.map((c) => ({ c, space: r.space })));
    const live = children.filter(({ c }) => c.session).map(({ c }) => c.id);
    const stale = children.filter(({ c }) => canSummarize(c) && (!ids || ids.includes(c.id)))
      .map(({ c, space }) => ({ id: c.id, session: c.session, turn: c.turn, title: c.title, space: space.name, tab: c.tabName }));
    this.error = null;
    this.note = stale.length ? null : "Nothing to summarize: these agents are working, blocked or have no Claude session.";
    if (!stale.length) { cx.notify(); return; }
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("node", [SCRIPT(), JSON.stringify({ live, stale })]);
        if (r.code !== 0) this.error = r.stderr.trim().slice(0, 300) || `summarize.mjs exited ${r.code}`;
      } catch (e) { this.error = String(e.message ?? e); }
      this.busy = false;
      this.load(cx);
    });
  }

  jump(c) {
    run("space.select", { id: c.space });
    if (c.tab) run("tab.select", { id: c.tab });
    if (c.pane) run("pane.focus", { pane: c.pane });
    else if (c.id) run("agent.focus", { terminal: c.id });
    closeOverlay(props()?.overlay);
  }

  button(t, id, label, tip, onClick, { danger = false, disabled = false } = {}) {
    const armed = this.armed === id;
    return div().id(id).px(7).py(2).flex_none().rounded(5).text_size(11.5).tooltip(tip)
      .text_color(disabled ? t.dim : armed ? "#ffffff" : danger ? t.muted : t.foreground)
      .when(armed, (el) => el.bg(t.blocked))
      .when(!disabled, (el) => el.cursor_pointer()
        .hover((s) => s.bg(armed ? t.blocked : t.hover).text_color(armed ? "#ffffff" : danger ? t.blocked : t.foreground)))
      .on_click((_e, cx) => {
        cx.stop_propagation(); // the row under it jumps on click, even when this is disabled
        if (disabled) return;
        if (danger && !armed) { this.armed = id; cx.notify(); return; }
        this.armed = null;
        onClick(cx);
        cx.notify();
      })
      .child(armed ? `${label}?` : label);
  }

  chip(t, verdict) {
    const color = { you: t.blocked, others: t.working, working: t.working, done: t.done }[verdict] ?? t.dim;
    return h_flex().w(112).flex_none().gap(6).items_center().text_size(11.5).text_color(color)
      .child(verdict === "working" ? svg(ICON("spinner")).size(11).spin(900)
        : verdict === "done" ? svg(ICON("circle-check")).size(11)
        : div().text_size(9).child("●"))
      .child(LABEL[verdict]);
  }

  summaryCell(t, v, c) {
    const body = v.summary
      ?? (v.verdict === "working" ? c?.title || "Working…"
        : v.verdict === "unknown" ? "Press Summarize to summarize." : "");
    return v_flex().flex_1().min_w(0).gap(2)
      .child(div().text_color(v.outdated || v.verdict === "unknown" ? t.muted : t.foreground).child(body))
      .when(Boolean(v.next), (el) => el.child(div().text_size(11.5).text_color(t.muted).child(`Next: ${v.next}`)))
      .when(Boolean(v.outdated), (el) => el.child(div().text_size(11).text_color(t.dim).child("Outdated: the agent ran another turn. Summarize to update.")));
  }

  // A click anywhere on the row jumps to it; the chevron and the buttons stop the click first.
  // The dev workspace's still Poké Ball and its Pokémon, as the sidebar card shows them (space-panel
  // publishes shared "space.art"); nothing until space-panel has drawn them.
  art(spaceId) {
    const a = (shared(ART) ?? {})[spaceId];
    const p = a?.pokemon, fit = p ? Math.min(30 / p.w, 24 / p.h) : 0;
    return h_flex().flex_none().gap(3).items_center()
      .when(Boolean(a?.ball), (el) => el.child(div().w(20).h(24).flex_none().relative().overflow_hidden()
        .child(image(a.ball.sheet).absolute().top(0).left(-2).w(24 * a.ball.cells).h(24))))
      .when(fit > 0, (el) => el.child(div().w(30).h(24).flex_none().flex().items_center().justify_center().tooltip(p.name ?? "")
        .child(image(p.path).w(Math.round(p.w * fit)).h(Math.round(p.h * fit)))));
  }

  row(t, { id, name, sub, verdict, summary, actions, onJump, art = null, depth = 0, header = false, locked = false, collapsed = null, onToggle = null }) {
    return h_flex().id(id).pl(12 + depth * 18).pr(12).py(8).gap(12).items_start().border_t(1).border_color(t.border)
      .when(header, (el) => el.bg(t.surface))
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => onJump())
      .child(v_flex().w(300 - depth * 18).flex_none().min_w(0)
        .child(h_flex().gap(5).items_center().min_w(0)
          .when(collapsed !== null, (el) => el.child(div().id(`${id}-toggle`).flex_none().p(2).rounded(4).hover((s) => s.bg(t.border))
            .on_click((_e, cx) => { cx.stop_propagation(); onToggle(); cx.notify(); })
            .child(svg(ICON(collapsed ? "chevron-right" : "chevron-down")).size(11).text_color(t.muted))))
          .when(Boolean(art), (el) => el.child(art))
          .when(locked, (el) => el.child(svg(ICON("pin")).size(11).flex_none().text_color(t.dim)))
          .child(div().id(`${id}-name`).truncate().tooltip(name).text_color(t.foreground).when(depth === 0, (el) => el.font_semibold()).child(name)))
        .when(Boolean(sub), (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(sub))))
      .child(this.chip(t, verdict))
      .child(summary)
      .child(h_flex().w(118).flex_none().gap(4).justify_end().children(actions));
  }

  spaceRows(t, { space, children }, items, locked) {
    const agents = children.map((c) => ({ c, v: verdictOf(c, items) }));
    const rollup = agents.map(({ v }) => v.verdict).sort((a, b) => RANK[a] - RANK[b])[0];
    const isLocked = Boolean(locked[space.id]);
    const close = this.button(t, `close-${space.id}`, "Close", isLocked ? "Locked: unlock it from the card menu first" : "Close this dev workspace and end its terminals",
      () => run("space.close", { id: space.id, confirmed: true }), { danger: true, disabled: isLocked });
    const busy = this.running();
    const summarize = (id, ids, tip) => this.button(t, id, "Summarize", busy ? "A summary is already running" : tip,
      (cx) => this.summarize(cx, ids), { disabled: busy });
    const name = cardTitle(space, children);

    const counts = `${agents.length} agent${agents.length > 1 ? "s" : ""}`;
    const collapsed = Boolean(collapsedSet()[space.id]);
    // Collapsed, the header carries the next step of its most urgent agent.
    const urgent = agents.slice().sort((a, b) => RANK[a.v.verdict] - RANK[b.v.verdict])[0];
    const head = this.row(t, {
      id: `space-${space.id}`, name, locked: isLocked, verdict: rollup, header: true, art: this.art(space.id),
      collapsed, onToggle: () => setCollapsed(space.id, !collapsed),
      sub: [name !== space.name ? space.name : null, norm(space.folder) !== ROOT_FOLDER() ? space.folder : null].filter(Boolean).join(" · "),
      summary: v_flex().flex_1().min_w(0).gap(2).text_size(11.5).text_color(t.muted)
        .child(`${counts} · ${agents.filter(({ v }) => v.verdict === "done").length} of ${agents.length} done`)
        .when(collapsed && Boolean(urgent?.v.next), (el) => el.child(div().text_color(t.foreground).child(`Next: ${urgent.v.next}`))),
      onJump: () => this.jump(agents.length === 1 ? agents[0].c : { space: space.id, tab: space.tabs.find((x) => x.active)?.id }),
      actions: [summarize(`sum-${space.id}`, agents.map(({ c }) => c.id), "Summarize the agents in this dev workspace (Haiku)"), close],
    });
    if (collapsed) return [head];
    return [head, ...agents.map(({ c, v }) => this.row(t, {
      id: `child-${c.id}`, name: c.depth ? `↳ ${c.title || c.id}` : c.tabName, sub: c.depth ? "sub-agent" : c.title,
      verdict: v.verdict, depth: 1 + c.depth, summary: this.summaryCell(t, v, c), onJump: () => this.jump(c),
      actions: [
        canSummarize(c) ? summarize(`sum-${c.id}`, [c.id], "Summarize this agent (Haiku)")
          : this.button(t, `sum-${c.id}`, "Summarize", c.session ? "Its live state shows while it works or waits on a prompt" : "No Claude session to summarize", () => {}, { disabled: true }),
        this.button(t, `end-${c.id}`, "End", isLocked ? "Locked dev workspace" : c.pane ? "Close this pane and end its terminal" : "End this sub-agent",
          () => (c.pane ? run("pane.close", { pane: c.pane }) : exec("hc", ["kill", c.id])), { danger: true, disabled: isLocked }),
      ],
    }))];
  }

  render(cx) {
    const t = theme();
    const items = this.cache?.items ?? {};
    const locked = shared(LOCKED) ?? {};
    const rows = world(); // sidebar order, one group per dev workspace
    const stale = rows.flatMap((r) => r.children).filter((c) => needsSummary(c, items)).length;
    const meta = [
      this.cache?.at ? `Summarized ${ago(this.cache.at)}` : "Not summarized yet",
      stale ? `${stale} to update` : null,
      this.cache?.cost ? `last run $${this.cache.cost.toFixed(4)}` : null,
    ].filter(Boolean).join(" · ");
    const error = this.error ?? this.cache?.error;

    return v_flex().id("space-summary").size_full().min_h(0).bg(t.popover).text_size(12.5)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props()?.overlay); cx.stop_propagation(); } })
      .child(h_flex().h(46).px(14).gap(10).flex_none().items_center().border_b(1).border_color(t.border)
        .child(svg(ICON("layers")).size(14).text_color(t.muted))
        .child(div().font_semibold().text_color(t.foreground).child("Workspace summary"))
        .child(div().flex_1().truncate().text_size(11.5).text_color(t.dim).child(meta))
        .child((() => {
          const ids = rows.map((r) => r.space.id);
          const allCollapsed = ids.length > 0 && ids.every((id) => collapsedSet()[id]);
          return div().id("toggle-all").px(10).h(28).flex().items_center().rounded(6).cursor_pointer().text_color(t.muted)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { setCollapsed(ids, !allCollapsed); cx.notify(); })
            .child(allCollapsed ? "Expand all" : "Collapse all");
        })())
        .child(h_flex().id("summarize-all").px(10).h(28).gap(6).items_center().rounded(6).border_1().border_color(t.border)
          .cursor_pointer().text_color(t.foreground).hover((s) => s.bg(t.hover))
          .tooltip("Summarize every agent that is not working or blocked (Haiku)")
          .on_click((_e, cx) => this.summarize(cx))
          .when(this.running(), (el) => el.child(svg(ICON("spinner")).size(12).text_color(t.muted).spin(900)))
          .child(this.running() ? "Summarizing…" : "Summarize all"))
        .child(div().id("close-panel").px(6).py(2).rounded(5).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover))
          .on_click(() => closeOverlay(props()?.overlay)).child(svg(ICON("x")).size(12))))
      .when(Boolean(error), (el) => el.child(div().px(14).py(8).flex_none().text_color(t.blocked).child(error)))
      .when(Boolean(this.note), (el) => el.child(div().px(14).py(6).flex_none().text_size(11.5).text_color(t.muted).child(this.note)))
      .child(h_flex().h(28).px(12).gap(12).flex_none().items_center().text_size(11).text_color(t.dim)
        .child(div().w(300).flex_none().child("Dev workspace"))
        .child(div().w(112).flex_none().child("State"))
        .child(div().flex_1().child("What is happening"))
        .child(div().w(118).flex_none().text_right().child("Actions")))
      .child(v_flex().id("summary-rows").flex_1().min_h(0).overflow_y_scrollbar()
        .children(rows.flatMap((r) => this.spaceRows(t, r, items, locked)))
        .when(!rows.length, (el) => el.child(div().p(14).text_color(t.dim).child("No agents."))));
  }
}
