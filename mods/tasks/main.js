// Jira and GitHub, Orca style. props.view "rail" is the compact sidebar block (props.rail "jira" or
// "github" draws only that side, as the panel's Jira and GitHub tabs); with no view (opened by
// mod.open or a tab) it is the full board.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, TextareaState } from "gpui-base";
import { spaces, focused, panes, props, theme, layout, closeOverlay, run, shared, setShared, settings } from "herdr";

// One board at a time. An open board holds a lease in shared("tasks.board"), renewed every 15 s
// and cleared by close(); a crash that skips close() lets it lapse after 40 s. The rail never
// opens its own overlay: it posts shared("tasks.request"), which an open board takes, and opens
// the board with mod.open (the same toggle as ctrl-shift-j) only when none holds the lease.
const BOARD = "tasks.board";
const REQUEST = "tasks.request";
// The tickets and PRs open as tabs in the board, in tab order.
const OPEN = "tasks.open";
const tabId = (x) => (x.kind === "ticket" ? `t:${x.key}` : `p:${x.url}`);
const BOARD_LEASE_MS = 40000;
const boardOpen = () => Date.now() - (shared(BOARD)?.at ?? 0) < BOARD_LEASE_MS;
import { POLL_MS, STALE_MS, snapshot, refresh, forBranch, withMoves, moveTicket } from "./data.js";
import { ticketDrawer, prPage } from "./detail.js";
import { toolbar, jiraBody } from "./jira.js";
import { ink, onFill, contrast } from "./colors.js";
import { brand } from "./brand.js";

// Which mark a board tab and a rail section carry.
const TAB_BRAND = { jira: "jira", mine: "github", review: "github" };

// The surface this render draws on (rail: chrome, board: popover), for readable status text.
// Set at the start of each render, which runs to the end before another copy renders.
let paper = null;

// GitHub's link blue: the dark-mode shade, or the light-mode one where that falls under 3:1.
const blue = (bg) => (contrast("#58A6FF", bg) >= 3 ? "#58A6FF" : "#0969DA");

const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const CI = { SUCCESS: ["✓", "passing", "done"], FAILURE: ["✗", "failing", "blocked"], ERROR: ["✗", "error", "blocked"], PENDING: ["●", "running", "working"], EXPECTED: ["●", "waiting", "working"] };
const REVIEW = { APPROVED: ["approved", "done"], CHANGES_REQUESTED: ["changes", "blocked"], REVIEW_REQUIRED: ["review", "muted"] };
const CATEGORY = { indeterminate: "working", done: "done", new: "muted" };
const CATEGORY_ORDER = { indeterminate: 0, new: 1, done: 2 };
const TABS = [["jira", "Jira"], ["mine", "My PRs"], ["review", "Review requests"], ["here", "This space"]];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
// The rail goes compact when it is drawn under 160 px. Its measured width (on_size_change) decides;
// before the first measure, the column's layout size clamped to its min and max. The raw px alone
// misleads: a panel dragged to 24 px stays in the layout while herdr draws it at its 280 px min.
const COMPACT_PX = 160;
function layoutWidth() {
  const col = find(layout(), props()?.column ?? "sidebar");
  const px = col?.size?.px;
  if (px == null) return Infinity;
  return Math.min(Math.max(px, col.min ?? 0), col.max ?? Infinity);
}
const narrow = (measured) => (measured ?? layoutWidth()) < COMPACT_PX;
// Under Agents the rail needs a top border; alone in its own column it does not.
const ownColumn = () => Boolean(props()?.column);

function age(snap) {
  if (!snap) return "loading…";
  const m = Math.floor((Date.now() - snap.at) / 60000);
  return m < 1 ? "just now" : `${m}m ago`;
}

// The branch of the shown space: its focused pane's, else the space's first terminal's.
function currentBranch() {
  const f = focused();
  const pane = panes().find((p) => p.pane === f?.pane);
  return pane?.branch ?? spaces().find((s) => s.active)?.branch ?? null;
}

const pill = (t, text, tone) =>
  div().flex_none().px(6).h(18).rounded(5).items_center().text_size(11).font_medium()
    .bg(t[tone] ?? t.muted).text_color(onFill(t, t[tone] ?? t.muted)).child(text);

const ciBadge = (t, pr, long) => {
  const [glyph, word, tone] = CI[pr.checks] ?? ["", "", "dim"];
  return div().flex_none().text_color(ink(t, tone, paper)).child(long ? (glyph ? `${glyph} ${word}` : "") : glyph);
};

const reviewBadge = (t, pr) => {
  const [word, tone] = pr.draft ? ["draft", "dim"] : REVIEW[pr.review] ?? ["", "dim"];
  return div().flex_none().text_color(ink(t, tone, paper)).child(word);
};

export default class Tasks extends View {
  init(_props, cx) {
    this.rail = props()?.view === "rail";
    this.tab = "jira";
    this.folded = new Set(["rail-sprint"]);
    this.foldedDone = false;
    if (!this.rail) {
      this.handle = cx.focus_handle();
      this.handle.focus();
      this.search = InputState.new({ placeholder: "Search key, summary or epic   ( / )" });
      this.search.on("change", (_e, cx) => cx.notify());
      // Board shortcuts pause while typing, so "r" in a search does not refresh.
      this.search.on("focus", (_e, cx) => { this.searchFocused = true; cx.notify(); });
      this.search.on("blur", (_e, cx) => { this.searchFocused = false; cx.notify(); });
      this.comment = TextareaState.new({ placeholder: "Add a Jira comment…", rows: 3 });
      this.comment.on("focus", (_e, cx) => { this.searchFocused = true; cx.notify(); });
      this.comment.on("blur", (_e, cx) => { this.searchFocused = false; cx.notify(); });
      // Detail views: a ticket drawer or a PR page. The rail opens the board straight onto one.
      this.details = new Map();
      // A request younger than a few seconds is the click that opened this board.
      const request = shared(REQUEST);
      this.seenRequest = request?.at ?? 0;
      // Open tickets and PRs are tabs (shared "tasks.open", so a reopened board keeps them);
      // this.detail is the shown one, null for the Board tab.
      this.open = (shared(OPEN) ?? []).filter((x) => x?.kind);
      this.detail = null;
      if (request && Date.now() - request.at < 5000) this.takeRequest(request.target);
      this.holdBoard();
      cx.timer.every(15000, () => this.holdBoard());
    }
    this.move = (ticket, column, cx) => cx.spawn(async (cx) => { await moveTicket(ticket, column); cx.notify(); });
    const tick = (cx, force) => cx.spawn(async (cx) => { await refresh({ force }); cx.notify(); });
    this.reload = (cx) => tick(cx, true);
    // Each copy polls; refresh() skips the call when another copy fetched within the poll.
    cx.timer.every(POLL_MS, (cx) => tick(cx, false));
    tick(cx, false);
    // Repaints the "updated Nm ago" text; the data itself is shared and re-renders by itself.
    cx.timer.every(60000, (cx) => cx.notify());
  }

  fold(id, cx) {
    this.folded.has(id) ? this.folded.delete(id) : this.folded.add(id);
    cx.notify();
  }

  header(t, id, label, count, tone, mark) {
    const open = !this.folded.has(id);
    return h_flex().id(id).px(8).pt(8).h(28).flex_none().gap(6).items_center()
      .text_size(11).font_medium().cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => this.fold(id, cx))
      .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(11).flex_none().text_color(t.dim))
      .when(Boolean(mark), (el) => el.child(brand(t, mark, 11, t.chrome)))
      .child(div().truncate().text_color(tone ? ink({ ...t, blue: blue(paper) }, tone, paper) : t.dim).child(label))
      .child(div().text_color(t.dim).child(String(count)));
  }

  // A request opens a ticket or PR ({ kind, ... }), several at once ({ targets: [...] }, from a
  // dev workspace's Jira or GitHub button), or one of the board's lists ({ tab }).
  // A request from a dev workspace's button carries `workspace`: the tabs left open for other
  // workspaces close first (pinned ones stay), so the strip shows that workspace's tickets and PRs.
  takeRequest(target) {
    if (target?.workspace) this.keepWorkspace(target.workspace);
    if (target?.targets) this.openTabs(target.targets.map((x) => ({ ...x, workspace: target.workspace })));
    else if (target?.tab) { this.tab = target.tab; this.detail = null; }
    else if (target?.kind) this.openTabs([target]);
  }

  keepWorkspace(workspace) {
    this.open = this.open.filter((o) => o.pinned || o.workspace === workspace);
    setShared(OPEN, this.open);
    if (this.detail && !this.open.some((o) => tabId(o) === tabId(this.detail))) this.show(null);
  }

  // Adds each target as a tab (an open one is reused) and shows the first.
  openTabs(targets) {
    const list = targets.filter((x) => x?.kind);
    if (!list.length) return;
    for (const x of list) if (!this.open.some((o) => tabId(o) === tabId(x))) this.open.push(x);
    setShared(OPEN, this.open);
    this.show(this.open.find((o) => tabId(o) === tabId(list[0])));
  }

  // A pinned tab stays through workspace switches and Close all; pinned tabs sit first.
  togglePin(target, cx) {
    this.open = this.open.map((o) => (tabId(o) === tabId(target) ? { ...o, pinned: !o.pinned } : o));
    this.open = [...this.open.filter((o) => o.pinned), ...this.open.filter((o) => !o.pinned)];
    setShared(OPEN, this.open);
    cx.notify();
  }

  show(target) {
    this.detail = target ?? null;
    this.prTab = "conversation";
    this.prFile = null;
  }

  closeTab(target, cx) {
    const i = this.open.findIndex((o) => tabId(o) === tabId(target));
    if (i < 0) return;
    this.open.splice(i, 1);
    setShared(OPEN, this.open);
    if (this.detail && tabId(this.detail) === tabId(target)) this.show(this.open[Math.min(i, this.open.length - 1)] ?? null);
    cx.notify();
  }

  // Board, then one tab per open ticket or PR, like browser tabs.
  tabStrip(t) {
    const snap = snapshot();
    const label = (x) => (x.kind === "ticket" ? x.key : (() => {
      const m = x.url?.match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/);
      return m ? `${m[1]} #${m[2]}` : "Pull request";
    })());
    const tip = (x) => (x.kind === "ticket"
      ? `${x.key} ${snap?.tickets?.find((k) => k.key === x.key)?.summary ?? ""}`
      : [...(snap?.mine ?? []), ...(snap?.review ?? [])].find((p) => p.url === x.url)?.title ?? x.url);
    const tab = (id, active, children, onClick, onClose, pin) => h_flex().id(id).h(28).pl(10).pr(onClose || pin ? 4 : 10).gap(6).flex_none()
      .items_center().rounded(7).cursor_pointer().max_w(240)
      .bg(active ? t.selected : t.popover).text_color(active ? t.foreground : t.muted).hover((s) => s.bg(active ? t.selected : t.hover))
      .on_click((_e, cx) => { onClick(); cx.notify(); })
      .children(children)
      // Pin: dim until pinned; a pinned tab has no close button (unpin it first).
      .when(Boolean(pin), (el) => el.child(div().id(`${id}-pin`).p(2).rounded(4).tooltip(pin.on ? "Unpin" : "Pin: keep this tab open")
        .text_color(pin.on ? t.accent : t.dim).opacity(pin.on ? 1 : 0.6)
        .hover((s) => s.bg(t.raised).text_color(t.foreground).opacity(1))
        .on_click((_e, cx) => { cx.stop_propagation(); pin.toggle(cx); })
        .child(svg(ICON("pin")).size(11))))
      .when(Boolean(onClose) && !pin?.on, (el) => el.child(div().id(`${id}-x`).p(2).rounded(4).text_color(t.dim)
        .hover((s) => s.bg(t.raised).text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); onClose(cx); })
        .child(svg(ICON("x")).size(11))));
    return h_flex().id("open-tabs").px(10).h(40).flex_none().gap(4).items_center().border_b(1).border_color(t.border).overflow_x_scrollbar()
      .child(tab("open-board", !this.detail, [svg(ICON("layers")).size(13), div().child("Board")], () => this.show(null)))
      .children(this.open.map((x) => tab(`open-${tabId(x)}`, Boolean(this.detail) && tabId(this.detail) === tabId(x),
        [brand(t, x.kind === "ticket" ? "jira" : "github", 13, t.popover), div().truncate().tooltip(tip(x)).child(label(x))],
        () => this.show(x), (cx) => this.closeTab(x, cx), { on: Boolean(x.pinned), toggle: (cx) => this.togglePin(x, cx) })))
      .child(div().flex_1())
      .when(this.open.filter((o) => !o.pinned).length > 1, (el) => el.child(div().id("close-all-tabs").px(8).h(26).flex_none()
        .flex().items_center().rounded(6).text_size(11.5).text_color(t.dim).cursor_pointer().tooltip("Close every tab that is not pinned")
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          this.open = this.open.filter((o) => o.pinned);
          setShared(OPEN, this.open);
          if (this.detail && !this.open.some((o) => tabId(o) === tabId(this.detail))) this.show(null);
          cx.notify();
        })
        .child("Close all")))
      .when(Boolean(props()?.overlay), (el) => el.child(div().id("close-board").size(26).flex_none().flex().items_center().justify_center()
        .rounded(6).text_color(t.dim).cursor_pointer().tooltip("Close (Esc)")
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => closeOverlay(props().overlay))
        .child(svg(ICON("x")).size(14))));
  }

  holdBoard() {
    setShared(BOARD, { overlay: props()?.overlay ?? null, at: Date.now() });
  }

  async close() {
    if (!this.rail && shared(BOARD)?.overlay === (props()?.overlay ?? null)) setShared(BOARD, null);
  }

  openDetail(target, cx) {
    if (this.rail) {
      const open = boardOpen();
      setShared(REQUEST, { target, at: Date.now() });
      if (!open) run("mod.open", { name: "tasks" });
      return;
    }
    else { this.openTabs([target]); cx.notify(); }
  }

  row(t, id, target, cells) {
    return h_flex().id(id).px(8).h(26).flex_none().gap(8).items_center().rounded(7)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.openDetail(target, cx))
      .children(cells)
      .child(div().id(`${id}-web`).flex_none().p(2).rounded(4).opacity(0.75).tooltip(target.kind === "pr" ? "Open in GitHub" : "Open in Jira")
        .hover((s) => s.opacity(1).bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(target.url); })
        .child(brand(t, target.kind === "pr" ? "github" : "jira", 12, t.chrome)));
  }

  // ---- Rail: the compact sidebar view ----

  renderRail(t, snap) {
    const branch = currentBranch();
    const here = forBranch(snap, branch);
    const inProgress = withMoves(snap?.tickets ?? []).filter((x) => x.mine && x.category === "indeterminate");
    const stale = snap && Date.now() - snap.at > STALE_MS;

    // Both rail views report their drawn width, so switching between them follows the real size.
    const measure = (size, cx) => {
      const width = size.width / (settings().zoom || 1); // layout px, like COMPACT_PX
      if (Math.abs((this.railWidth ?? -1) - width) < 1) return;
      this.railWidth = width;
      cx.notify();
    };
    if (narrow(this.railWidth)) {
      const count = (n, tone, label) => v_flex().items_center().gap(1).tooltip(label)
        .child(div().text_size(12).font_medium().text_color(n ? t[tone] : t.dim).child(String(n)));
      return v_flex().id("tasks-rail").size_full().on_size_change(measure).bg(t.chrome).when(!ownColumn(), (el) => el.border_t(1).border_color(t.border))
        .pt(10).gap(8).items_center().cursor_pointer().on_click(() => run("mod.open", { name: "tasks" }))
        .child(svg(ICON("layers")).size(15).text_color(stale ? ink(t, "blocked", paper) : t.dim))
        .child(count(snap?.review.length ?? 0, "blocked", "Review requests"))
        .child(count(snap?.mine.length ?? 0, "foreground", "My PRs"))
        .child(count(inProgress.length, "working", "Active tickets"));
    }

    const prRow = (pr, prefix) => this.row(t, `${prefix}-${pr.url}`, { kind: "pr", url: pr.url }, [
      div().flex_none().text_color(t.dim).child(`#${pr.number}`),
      div().flex_1().min_w(0).truncate().text_color(t.foreground).child(pr.title),
      ciBadge(t, pr, false),
    ]);
    const section = (id, label, items, tone, draw, mark) => [
      this.header(t, id, label, items.length, tone, mark),
      ...(this.folded.has(id) ? [] : items.map(draw)),
    ];

    const hereRows = [];
    if (here.ticket) {
      hereRows.push(this.row(t, "here-ticket", { kind: "ticket", key: here.ticket.key, url: here.ticket.url }, [
        div().flex_none().text_color(t.dim).child(here.ticket.key),
        div().flex_1().min_w(0).truncate().text_color(t.foreground).child(here.ticket.summary),
        pill(t, here.ticket.status, CATEGORY[here.ticket.category]),
      ]));
    }
    for (const pr of here.prs.slice(0, 3)) {
      hereRows.push(this.row(t, `here-${pr.url}`, { kind: "pr", url: pr.url }, [
        div().flex_none().text_color(pr.branch === branch ? ink(t, "accent", paper) : t.dim).child(`#${pr.number}`),
        div().flex_1().min_w(0).truncate().text_color(t.foreground).child(pr.title),
        ciBadge(t, pr, false),
        reviewBadge(t, pr),
      ]));
    }

    const rows = [
      ...(here.key || here.prs.length
        ? [this.header(t, "rail-here", here.key ?? "This branch", hereRows.length, "accent"), ...(this.folded.has("rail-here") ? [] : hereRows)]
        : []),
      ...section("rail-review", "Review requests", snap?.review ?? [], "blocked", (pr) => prRow(pr, "rv"), "github"),
      ...section("rail-mine", "My PRs", snap?.mine ?? [], null, (pr) => prRow(pr, "mn"), "github"),
      ...section("rail-sprint", "Active", inProgress, "working", (x) => this.row(t, `sp-${x.key}`, { kind: "ticket", key: x.key, url: x.url }, [
        div().flex_none().text_color(t.dim).child(x.key),
        div().flex_1().min_w(0).truncate().text_color(t.foreground).child(x.summary),
      ]), "jira"),
    ];

    return v_flex().id("tasks-rail").size_full().min_h(0).on_size_change(measure).bg(t.chrome).when(!ownColumn(), (el) => el.border_t(1).border_color(t.border)).text_size(12.5)
      .child(h_flex().px(16).h(41).pt(14).pb(5).flex_none().items_center().gap(8)
        .child(div().flex_1().text_size(11.5).font_medium().text_color(t.dim).child("Tasks"))
        .child(div().id("rail-age").text_size(11).text_color(stale ? ink(t, "blocked", paper) : t.dim)
          .tooltip(snap?.errors?.join("\n") || "Refresh").cursor_pointer()
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => this.reload(cx))
          .child(stale ? `stale · ${age(snap)}` : age(snap)))
        .child(div().id("rail-open").text_color(t.dim).cursor_pointer().tooltip("Open the board (ctrl-shift-j)")
          .hover((s) => s.text_color(t.foreground))
          .on_click(() => run("mod.open", { name: "tasks" }))
          .child(svg(ICON("layers")).size(14))))
      .child(v_flex().id("rail-list").flex_1().min_h(0).px(8).overflow_y_scrollbar().children(rows));
  }

  // ---- Jira and GitHub rails: one side each, for the panel's Jira and GitHub tabs ----

  // Both report their drawn width, so the compact view follows the real size.
  measureRail(size, cx) {
    const width = size.width / (settings().zoom || 1); // layout px, like COMPACT_PX
    if (Math.abs((this.railWidth ?? -1) - width) < 1) return;
    this.railWidth = width;
    cx.notify();
  }

  // Under COMPACT_PX: the mark and a count per list; a click opens that side of the board.
  compactRail(t, mark, tab, counts) {
    return v_flex().id(`${mark}-rail`).size_full().on_size_change((size, cx) => this.measureRail(size, cx)).bg(t.chrome)
      .pt(10).gap(8).items_center().cursor_pointer().on_click((_e, cx) => this.openDetail({ tab }, cx))
      .child(brand(t, mark, 15, t.chrome))
      .children(counts.map(([n, tone, label]) => div().tooltip(label).text_size(12).font_medium()
        .text_color(n ? t[tone] : t.dim).child(String(n))));
  }

  railFrame(t, snap, mark, title, subtitle, tab, rows, empty, filter) {
    const stale = snap && Date.now() - snap.at > STALE_MS;
    return v_flex().id(`${mark}-rail`).size_full().min_h(0).on_size_change((size, cx) => this.measureRail(size, cx)).bg(t.chrome).text_size(12.5)
      .child(h_flex().px(16).h(41).pt(14).pb(5).flex_none().items_center().gap(8)
        .child(brand(t, mark, 13, t.chrome))
        .child(div().flex_none().text_size(11.5).font_medium().text_color(t.muted).child(title))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(subtitle ?? ""))
        .when(Boolean(filter), (el) => el.child(filter))
        .child(div().id(`${mark}-age`).flex_none().text_size(11).text_color(stale ? ink(t, "blocked", paper) : t.dim)
          .tooltip(snap?.errors?.join("\n") || "Refresh").cursor_pointer()
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => this.reload(cx))
          .child(stale ? `stale · ${age(snap)}` : age(snap)))
        .child(div().id(`${mark}-open`).flex_none().text_color(t.dim).cursor_pointer().tooltip("Open the board (ctrl-shift-j)")
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => this.openDetail({ tab }, cx))
          .child(svg(ICON("layers")).size(14))))
      .child(v_flex().id(`${mark}-list`).flex_1().min_h(0).px(8).overflow_y_scrollbar()
        .when(!snap, (el) => el.child(div().p(8).text_color(t.dim).child("Loading…")))
        .when(Boolean(snap) && !rows.length, (el) => el.child(div().p(8).text_color(t.dim).child(empty)))
        .children(rows));
  }

  // An empty list draws nothing, not even its header.
  railSection(t, id, label, items, tone, draw) {
    if (!items.length) return [];
    return [this.header(t, id, label, items.length, tone), ...(this.folded.has(id) ? [] : items.map(draw))];
  }

  // The sprint and backlog tickets in the board's columns, in board order, so each row has room
  // for its summary. Mine only by default; the header button switches to everyone's (remembered).
  // A column of done tickets starts folded.
  renderJiraRail(t, snap) {
    const branch = currentBranch();
    const here = forBranch(snap, branch);
    this.jiraAll ??= localStorage.getItem("jira.all") === "1";
    const all = this.jiraAll;
    const mine = withMoves(snap?.tickets ?? []).filter((x) => (all || x.mine) && x.key !== here.ticket?.key);
    const columns = [...(snap?.columns ?? []), { name: "Other", statusIds: [] }];
    const columnOf = (x) => columns.find((c) => c.statusIds.includes(x.statusId)) ?? columns[columns.length - 1];
    const groups = columns.map((c) => ({ c, items: mine.filter((x) => columnOf(x) === c) })).filter((g) => g.items.length);
    if (narrow(this.railWidth)) {
      const count = (category) => mine.filter((x) => x.category === category).length;
      return this.compactRail(t, "jira", "jira", [[count("indeterminate"), "working", "In progress"], [count("new"), "foreground", "To do"]]);
    }
    for (const g of groups) {
      const id = `jr-col-${g.c.name}`;
      if (this.seenColumns?.has(id)) continue;
      (this.seenColumns ??= new Set()).add(id);
      if (g.items.every((x) => x.category === "done")) this.folded.add(id);
    }
    const ticketRow = (prefix, withStatus) => (x) => this.row(t, `${prefix}-${x.key}`, { kind: "ticket", key: x.key, url: x.url }, [
      div().flex_none().text_color(t.dim).child(x.key),
      div().flex_1().min_w(0).truncate().text_color(t.foreground).tooltip(x.epic ? `${x.summary}\nEpic: ${x.epic.summary}` : x.summary).child(x.summary),
      ...(all && !x.mine ? [div().flex_none().max_w(80).truncate().text_size(11).text_color(t.muted).child(x.assignee)] : []),
      ...(withStatus ? [pill(t, x.status, CATEGORY[x.category])] : []),
      ...(x.scope === "backlog" ? [div().flex_none().text_size(11).text_color(t.dim).child("Backlog")] : []),
    ]);
    const rows = [
      ...this.railSection(t, "jr-here", here.key ?? "This branch", here.ticket ? [here.ticket] : [], "accent", ticketRow("jh", true)),
      ...groups.flatMap((g) => this.railSection(t, `jr-col-${g.c.name}`, g.c.name, g.items, CATEGORY[g.items[0].category], ticketRow("jc", false))),
    ];
    const filter = div().id("jira-filter").flex_none().px(7).h(20).flex().items_center().rounded(5).text_size(11)
      .bg(t.selected).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
      .tooltip(all ? "Showing everyone's tickets. Click for mine." : "Showing my tickets. Click for everyone's.")
      .on_click((_e, cx) => {
        this.jiraAll = !all;
        localStorage.setItem("jira.all", this.jiraAll ? "1" : "0");
        cx.notify();
      })
      .child(all ? "View mine" : "View all");
    return this.railFrame(t, snap, "jira", "Jira", snap?.sprint, "jira", rows, all ? "No tickets." : "No tickets assigned to you.", filter);
  }

  renderGithubRail(t, snap) {
    const branch = currentBranch();
    const here = forBranch(snap, branch);
    const onBranch = new Set(here.prs.map((p) => p.url));
    const review = (snap?.review ?? []).filter((p) => !onBranch.has(p.url));
    const mine = (snap?.mine ?? []).filter((p) => !onBranch.has(p.url));
    if (narrow(this.railWidth)) {
      return this.compactRail(t, "github", "mine", [[review.length, "blocked", "Review requests"], [mine.length, "foreground", "My PRs"]]);
    }
    const prRow = (prefix, withAuthor) => (pr) => this.row(t, `${prefix}-${pr.url}`, { kind: "pr", url: pr.url }, [
      ciBadge(t, pr, false),
      div().flex_none().text_color(pr.branch === branch ? ink(t, "accent", paper) : t.dim).child(`#${pr.number}`),
      div().flex_1().min_w(0).truncate().text_color(pr.draft ? t.muted : t.foreground).tooltip(`${pr.repo} #${pr.number}  ${pr.title}`).child(pr.title),
      withAuthor ? div().flex_none().max_w(90).truncate().text_color(t.muted).child(pr.author) : reviewBadge(t, pr),
    ]);
    // My PRs under one header, with a repo label above each repo's rows once they span more than one.
    const repos = [...new Set(mine.map((p) => p.repo))].sort((a, b) => a.localeCompare(b));
    const repoLabel = (repo) => div().id(`gh-repo-${repo}`).px(8).pt(6).h(22).flex_none().text_size(11).text_color(t.dim).child(repo);
    const mineRows = !mine.length ? [] : [
      this.header(t, "gh-mine", "My PRs", mine.length, "blue"),
      ...(this.folded.has("gh-mine") ? [] : repos.flatMap((repo) => [
        ...(repos.length > 1 ? [repoLabel(repo)] : []),
        ...mine.filter((p) => p.repo === repo).map(prRow("gm", false)),
      ])),
    ];
    const rows = [
      ...this.railSection(t, "gh-here", here.key ?? "This branch", here.prs, "accent", prRow("gh", false)),
      ...this.railSection(t, "gh-review", "Review requests", review, "blocked", prRow("gr", true)),
      ...mineRows,
    ];
    return this.railFrame(t, snap, "github", "GitHub", null, "mine", rows, "No open PRs or review requests.");
  }

  // ---- Board: the full Orca-style view ----

  prGroups(t, prs, withAuthor) {
    const byRepo = new Map();
    for (const pr of prs) byRepo.set(pr.repo, [...(byRepo.get(pr.repo) ?? []), pr]);
    return [...byRepo.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([repo, items]) => ({
      id: `repo-${withAuthor ? "rv" : "mn"}-${repo}`, label: repo, tone: null, items,
      draw: (pr) => this.row(t, `pr-${withAuthor ? "rv" : "mn"}-${pr.url}`, { kind: "pr", url: pr.url }, [
        div().w(52).flex_none().text_color(t.dim).child(`#${pr.number}`),
        div().w(96).flex_none().text_color(t.dim).child(pr.ticket ?? ""),
        div().w(84).flex_none().child(ciBadge(t, pr, true)),
        div().w(72).flex_none().child(reviewBadge(t, pr)),
        ...(withAuthor ? [div().w(90).flex_none().truncate().text_color(t.muted).child(pr.author)] : []),
        div().flex_1().min_w(0).truncate().text_color(t.foreground).child(pr.title),
      ]),
    }));
  }

  hereGroups(t, snap) {
    const branch = currentBranch();
    const here = forBranch(snap, branch);
    const items = [...(here.ticket ? [{ kind: "ticket", ...here.ticket }] : []), ...here.prs.map((p) => ({ kind: "pr", ...p }))];
    return [{
      id: "here", label: here.key ?? `No ticket on ${branch ?? "this space"}`, tone: "accent", items,
      draw: (x) => x.kind === "ticket"
        ? this.row(t, "here-t", { kind: "ticket", key: x.key, url: x.url }, [
            div().w(140).flex_none().text_color(t.dim).child(x.key),
            pill(t, x.status, CATEGORY[x.category]),
            div().flex_1().min_w(0).truncate().text_color(t.foreground).child(x.summary)])
        : this.row(t, `here-${x.url}`, { kind: "pr", url: x.url }, [
            div().w(140).flex_none().text_color(t.dim).child(`${x.repo} #${x.number}`),
            div().w(84).flex_none().text_color(x.branch === branch ? ink(t, "accent", paper) : t.dim).child(x.branch === branch ? "this branch" : "same ticket"),
            div().w(84).flex_none().child(ciBadge(t, x, true)),
            div().w(72).flex_none().child(reviewBadge(t, x)),
            div().flex_1().min_w(0).truncate().text_color(t.foreground).child(x.title)]),
    }];
  }

  renderBoard(t, snap, cx) {
    const groups = {
      jira: () => [],
      mine: () => this.prGroups(t, snap?.mine ?? [], false),
      review: () => this.prGroups(t, snap?.review ?? [], true),
      here: () => this.hereGroups(t, snap),
    }[this.tab]();
    const counts = { jira: snap?.tickets.filter((x) => x.mine).length, mine: snap?.mine.length, review: snap?.review.length };
    const rows = groups.flatMap((g) => [
      this.header(t, g.id, g.label, g.items.length, g.tone),
      ...(this.folded.has(g.id) ? [] : g.items.map(g.draw)),
    ]);
    const frame = this.boardFrame(t).child(this.tabStrip(t));
    if (this.detail?.kind === "pr") return frame.child(div().flex_1().min_h(0).child(prPage(this, t, cx, this.detail.url)));
    if (this.detail?.kind === "ticket") {
      return frame.child(h_flex().flex_1().min_h(0).child(ticketDrawer(this, t, cx, this.detail.key, { full: true })));
    }
    return frame
      .child(h_flex().px(18).pt(14).pb(4).flex_none().items_center().gap(10)
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Tasks"))
        .child(div().flex_1().text_size(11.5).text_color(snap?.errors?.length ? ink(t, "blocked", paper) : t.dim)
          .child(snap?.errors?.length ? snap.errors.join("  ·  ") : `Updated ${age(snap)}`))
        .child(div().text_size(11).text_color(t.dim).child("1-4 tabs · / search · r refresh · Esc")))
      .child(h_flex().px(14).h(34).flex_none().gap(2).items_center().border_b(1).border_color(t.border)
        .children(TABS.map(([id, label], i) => h_flex().id(`tab-${id}`).px(10).h(26).gap(6).items_center().rounded(7)
          .cursor_pointer().text_color(this.tab === id ? t.foreground : t.muted)
          .when(this.tab === id, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.tab = id; cx.notify(); })
          .when(Boolean(TAB_BRAND[id]), (el) => el.child(brand(t, TAB_BRAND[id], 13, t.popover)))
          .child(label)
          .when(counts[id] != null, (el) => el.child(div().text_size(11).text_color(t.dim).child(String(counts[id]))))
          .tooltip(`${i + 1}`))))
      .child(h_flex().flex_1().min_h(0)
        .child(v_flex().flex_1().min_w(0).h_full().min_h(0)
          .when(this.tab === "jira", (el) => el.child(toolbar(this, t, snap)).child(div().flex_1().min_h(0).pt(6).child(jiraBody(this, t, snap))))
          .when(this.tab !== "jira", (el) => el.child(v_flex().id("board-list").flex_1().min_h(0).px(10).pb(10).overflow_y_scrollbar()
            .when(!snap, (el) => el.child(div().p(12).text_color(t.dim).child("Loading Jira and GitHub…")))
            .children(rows)))));
  }

  // The board's root: focus, keys and size. The size sets the ticket drawer's width.
  boardFrame(t) {
    const close = () => props()?.overlay && closeOverlay(props().overlay);
    return v_flex().id("tasks-board").track_focus(this.handle).size_full().min_h(0).bg(t.popover).text_size(13)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .on_key_down((e, cx) => {
        const i = ["1", "2", "3", "4"].indexOf(e.key);
        if (e.key === "escape" && this.searchFocused) this.handle.focus();
        else if (this.searchFocused) return;
        else if (e.key === "escape" && this.detail) this.detail = null;
        else if (e.key === "escape") close();
        else if (this.detail?.kind === "pr") return;
        else if (e.key === "/") { this.tab = "jira"; this.search.focus(); }
        else if (i >= 0) this.tab = TABS[i][0];
        else if (e.key === "r") this.reload(cx);
        else return;
        cx.stop_propagation();
        cx.notify();
      });
  }

  render(cx) {
    const t = theme();
    const snap = snapshot();
    const request = this.rail ? null : shared(REQUEST);
    if (request && request.at > this.seenRequest) {
      this.seenRequest = request.at;
      this.takeRequest(request.target);
    }
    paper = this.rail ? t.chrome : t.popover;
    if (!this.rail) return this.renderBoard(t, snap, cx);
    const side = props()?.rail;
    return side === "jira" ? this.renderJiraRail(t, snap) : side === "github" ? this.renderGithubRail(t, snap) : this.renderRail(t, snap);
  }
}
