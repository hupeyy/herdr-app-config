// The board's Jira tab: list, Kanban board and epic views, with Jira-style filters and status moves.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { shared, setShared } from "herdr";
import { withMoves } from "./data.js";
import { ink, onFill } from "./colors.js";
import { brand } from "./brand.js";

const PREFS = "tasks.jira";
const VIEWS = [["list", "List"], ["board", "Board"], ["epic", "Epics"]];
const OTHER = "Other";
const CATEGORY_TONE = { indeterminate: "working", done: "done", new: "muted" };
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// View, assignees and statuses survive closing the board; the search starts empty each time.
export function prefs() {
  const p = shared(PREFS) ?? {};
  return { view: p.view ?? "list", assignees: p.assignees ?? ["me"], columns: p.columns ?? [] };
}
function setPrefs(change) {
  setShared(PREFS, { ...prefs(), ...change });
}
const toggle = (list, item) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

const columnOf = (columns, ticket) => columns.find((c) => c.statusIds.includes(ticket.statusId))?.name ?? OTHER;
const initials = (name) => name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

function filtered(snap, search) {
  const { assignees, columns: wanted } = prefs();
  const q = search.trim().toLowerCase();
  return withMoves(snap?.tickets ?? []).filter((x) =>
    (!assignees.length || assignees.some((a) => (a === "me" ? x.mine : x.assignee === a))) &&
    (!wanted.length || wanted.includes(columnOf(snap.columns ?? [], x))) &&
    (!q || x.key.toLowerCase().includes(q) || x.summary.toLowerCase().includes(q) || x.epic?.summary.toLowerCase().includes(q)));
}

const pill = (t, x) =>
  h_flex().flex_none().px(6).h(18).gap(4).rounded(5).items_center().text_size(11).font_medium()
    .bg(t[CATEGORY_TONE[x.category]] ?? t.muted).text_color(onFill(t, t[CATEGORY_TONE[x.category]] ?? t.muted))
    .when(Boolean(x.moving), (el) => el.child(div().frames(SPINNER, 80)))
    .child(x.status);

const chip = (t, id, label, on, onClick, count) =>
  h_flex().id(id).h(24).px(8).gap(5).flex_none().items_center().rounded(12).text_size(11.5)
    .border_1().border_color(on ? t.accent : t.border)
    .bg(on ? t.selected : t.popover).text_color(on ? t.foreground : t.muted)
    .cursor_pointer().hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => { onClick(cx); cx.notify(); })
    .child(label)
    .when(count != null, (el) => el.child(div().text_color(t.dim).child(String(count))));

export function toolbar(view, t, snap) {
  const p = prefs();
  const all = withMoves(snap?.tickets ?? []);
  const people = [...new Set(all.map((x) => x.assignee))].filter((n) => !all.some((x) => x.mine && x.assignee === n)).sort();
  const columnNames = [...(snap?.columns ?? []).map((c) => c.name), ...(all.some((x) => columnOf(snap.columns ?? [], x) === OTHER) ? [OTHER] : [])];
  const countBy = (pred) => all.filter(pred).length;

  return v_flex().px(14).pt(8).pb(6).gap(6).flex_none().border_b(1).border_color(t.border)
    .child(h_flex().gap(8).items_center()
      .child(h_flex().gap(2).p(2).rounded(8).bg(t.surface).children(VIEWS.map(([id, label]) =>
        div().id(`view-${id}`).px(10).h(24).rounded(6).flex().items_center().cursor_pointer()
          .text_color(p.view === id ? t.foreground : t.muted).when(p.view === id, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { setPrefs({ view: id }); cx.notify(); })
          .child(label))))
      .child(h_flex().flex_1().h(28).px(8).gap(6).items_center().rounded(7).border_1().border_color(view.searchFocused ? t.accent : t.input)
        .child(svg("mods/workspace-chrome/search.svg").size(13).text_color(t.dim))
        .child(Input.new(view.search).flex_1().h_full().text_size(12.5).text_color(t.foreground)))
      .child(div().text_size(11).text_color(t.dim).child(snap?.sprint ?? "")))
    .child(h_flex().gap(4).items_center().overflow_x_scrollbar()
      .child(div().w(64).flex_none().text_size(11).text_color(t.dim).child("Assignee"))
      .child(chip(t, "as-me", "Me", p.assignees.includes("me"), () => setPrefs({ assignees: toggle(p.assignees, "me") }), countBy((x) => x.mine)))
      .children(people.map((n) => chip(t, `as-${n}`, n === "Unassigned" ? n : initials(n) + " " + n.split(" ")[0], p.assignees.includes(n),
        () => setPrefs({ assignees: toggle(p.assignees, n) }), countBy((x) => x.assignee === n))))
      .when(p.assignees.length > 0, (el) => el.child(chip(t, "as-all", "Everyone", false, () => setPrefs({ assignees: [] })))))
    .child(h_flex().gap(4).items_center().overflow_x_scrollbar()
      .child(div().w(64).flex_none().text_size(11).text_color(t.dim).child("Status"))
      .children(columnNames.map((c) => chip(t, `col-${c}`, c, p.columns.includes(c), () => setPrefs({ columns: toggle(p.columns, c) }),
        countBy((x) => columnOf(snap.columns ?? [], x) === c))))
      .when(p.columns.length > 0, (el) => el.child(chip(t, "col-all", "Any status", false, () => setPrefs({ columns: [] })))));
}

// A ticket row for the list and epic views. Clicking the status pill opens the move picker.
function row(view, t, snap, x, { showEpic }) {
  const picking = view.picking === x.key;
  const line = h_flex().id(`tk-${x.key}`).px(8).h(28).flex_none().gap(8).items_center().rounded(7)
    .cursor_pointer().hover((s) => s.bg(t.hover)).when(picking, (el) => el.bg(t.raised))
    .on_click((_e, cx) => view.openDetail({ kind: "ticket", key: x.key, url: x.url }, cx))
    .child(div().w(96).flex_none().text_color(t.dim).child(x.key))
    .child(h_flex().id(`st-${x.key}`).w(130).flex_none().cursor_pointer().tooltip("Change status")
      .on_click((_e, cx) => { cx.stop_propagation(); view.picking = picking ? null : x.key; cx.notify(); })
      .child(pill(t, x)))
    .child(div().w(30).flex_none().text_size(11).text_color(t.muted).tooltip(x.assignee).child(initials(x.assignee)))
    .child(div().w(60).flex_none().text_color(x.priority.startsWith("High") ? ink(t, "blocked", t.popover) : t.muted).child(x.priority))
    .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(x.summary))
    .when(showEpic && Boolean(x.epic), (el) => el.child(div().max_w(220).flex_none().truncate().text_size(11).text_color(t.dim).child(x.epic.summary)))
    .child(div().id(`web-${x.key}`).flex_none().p(2).rounded(4).opacity(0.75).tooltip("Open in Jira")
      .hover((s) => s.opacity(1).bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(x.url); })
      .child(brand(t, "jira", 12, t.popover)));
  if (!picking) return [line];
  const here = columnOf(snap.columns ?? [], x);
  const picker = h_flex().pl(112).pr(8).pb(6).pt(2).gap(4).flex_none().flex_wrap()
    .child(div().text_size(11).text_color(t.dim).mr(4).child("Move to"))
    .children((snap.columns ?? []).filter((c) => c.name !== here).map((c) =>
      chip(t, `mv-${x.key}-${c.name}`, c.name, false, (cx) => { view.picking = null; view.move(x, c, cx); })));
  return [line, picker];
}

function groupHeader(view, t, id, label, count, tone, extra) {
  const open = !view.folded.has(id);
  return h_flex().id(id).px(8).pt(10).h(30).flex_none().gap(6).items_center().text_size(11.5).font_medium().cursor_pointer()
    .hover((s) => s.text_color(t.foreground))
    .on_click((_e, cx) => { open ? view.folded.add(id) : view.folded.delete(id); cx.notify(); })
    .child(svg(`mods/workspace-chrome/${open ? "chevron-down" : "chevron-right"}.svg`).size(11).flex_none().text_color(t.dim))
    .child(div().truncate().text_color(tone ? ink(t, tone, t.popover) : t.dim).child(label))
    .child(div().text_color(t.dim).child(String(count)))
    .when(Boolean(extra), (el) => el.child(extra));
}

function listView(view, t, snap, tickets) {
  const order = [...(snap.columns ?? []).map((c) => c.name), OTHER];
  const groups = order.map((name) => ({ name, items: tickets.filter((x) => columnOf(snap.columns ?? [], x) === name) })).filter((g) => g.items.length);
  // Done starts folded, like Orca's done lane.
  if (!view.foldedDone) { view.folded.add("ls-Done"); view.foldedDone = true; }
  return groups.flatMap((g) => [
    groupHeader(view, t, `ls-${g.name}`, g.name, g.items.length, CATEGORY_TONE[g.items[0].category]),
    ...(view.folded.has(`ls-${g.name}`) ? [] : g.items.flatMap((x) => row(view, t, snap, x, { showEpic: true }))),
  ]);
}

function epicView(view, t, snap, tickets) {
  const byEpic = new Map();
  for (const x of tickets) {
    const id = x.epic?.key ?? "none";
    if (!byEpic.has(id)) byEpic.set(id, { epic: x.epic, items: [] });
    byEpic.get(id).items.push(x);
  }
  const groups = [...byEpic.values()].sort((a, b) => (!a.epic) - (!b.epic) || b.items.length - a.items.length);
  return groups.flatMap((g) => {
    const id = `ep-${g.epic?.key ?? "none"}`;
    const done = g.items.filter((x) => x.category === "done").length;
    const bar = h_flex().w(80).h(5).ml(6).rounded(3).bg(t.border).child(div().h_full().rounded(3).bg(t.done).w(Math.round((80 * done) / g.items.length)));
    const label = g.epic ? `${g.epic.key}  ${g.epic.summary}` : "No epic";
    return [
      groupHeader(view, t, id, label, g.items.length, g.epic ? "accent" : null,
        h_flex().gap(6).items_center().child(bar).child(div().text_color(t.dim).child(`${done}/${g.items.length} done`))),
      ...(view.folded.has(id) ? [] : g.items.flatMap((x) => row(view, t, snap, x, { showEpic: false }))),
    ];
  });
}

// Kanban: one column per board column. Press a card, release it over another column to move it.
function boardView(view, t, snap, tickets) {
  const columns = [...(snap.columns ?? []), ...(tickets.some((x) => columnOf(snap.columns ?? [], x) === OTHER) ? [{ name: OTHER, statusIds: [] }] : [])];
  const card = (x) => v_flex().id(`card-${x.key}`).p(8).gap(5).flex_none().rounded(8).border_1()
    .border_color(view.dragging?.key === x.key ? t.accent : t.border).bg(t.surface)
    .when(view.dragging?.key === x.key, (el) => el.opacity(0.55))
    .cursor_pointer().hover((s) => s.border_color(t.input))
    .on_mouse_down("left", (_e, cx) => { view.dragging = x; cx.notify(); })
    .on_click((_e, cx) => view.openDetail({ kind: "ticket", key: x.key, url: x.url }, cx))
    .child(h_flex().gap(6).items_center().text_size(11)
      .child(div().text_color(t.dim).child(x.key))
      .when(Boolean(x.moving), (el) => el.child(div().text_color(ink(t, "working", t.surface)).frames(SPINNER, 80)))
      .child(div().flex_1())
      .child(div().text_color(x.priority.startsWith("High") ? ink(t, "blocked", t.surface) : t.dim).child(x.priority)))
    .child(div().text_size(12.5).text_color(t.foreground).child(x.summary))
    .child(h_flex().gap(6).items_center().text_size(11)
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(x.epic?.summary ?? ""))
      .child(div().flex_none().px(5).h(18).rounded(9).items_center().bg(x.mine ? t.accent : t.raised)
        .text_color(x.mine ? onFill(t, t.accent) : t.muted).tooltip(x.assignee).child(initials(x.assignee))));

  return h_flex().id("kanban").size_full().min_h(0).gap(10).px(4).pb(4).overflow_x_scrollbar()
    .on_mouse_up("left", (_e, cx) => { view.dragging = null; view.dropTarget = null; cx.notify(); })
    .children(columns.map((c) => {
      const items = tickets.filter((x) => columnOf(snap.columns ?? [], x) === c.name);
      const target = view.dragging && view.dropTarget === c.name && c.name !== OTHER && columnOf(snap.columns ?? [], view.dragging) !== c.name;
      return v_flex().id(`kcol-${c.name}`).w(250).flex_none().h_full().min_h(0).rounded(10).p(6).gap(6)
        .bg(target ? t.selected : t.canvas).border_1().border_color(target ? t.accent : t.border)
        .on_hover((on, cx) => { if (on) view.dropTarget = c.name; else if (view.dropTarget === c.name) view.dropTarget = null; cx.notify(); })
        .on_mouse_up("left", (_e, cx) => {
          const x = view.dragging;
          if (x && c.name !== OTHER && columnOf(snap.columns ?? [], x) !== c.name) view.move(x, c, cx);
          view.dragging = null; view.dropTarget = null;
          cx.notify();
        })
        .child(h_flex().px(4).h(22).gap(6).items_center().flex_none().text_size(11.5).font_medium()
          .child(div().text_color(t.muted).child(c.name.toUpperCase()))
          .child(div().text_color(t.dim).child(String(items.length))))
        .child(v_flex().id(`kcards-${c.name}`).flex_1().min_h(0).gap(6).overflow_y_scrollbar().children(items.map(card)));
    }));
}

export function jiraBody(view, t, snap) {
  if (!snap?.columns) return div().p(12).text_color(t.dim).child("Loading the sprint…");
  const tickets = filtered(snap, view.search.value());
  if (!tickets.length) return div().p(12).text_color(t.dim).child("No tickets match these filters.");
  const { view: mode } = prefs();
  if (mode === "board") return boardView(view, t, snap, tickets);
  const rows = mode === "epic" ? epicView(view, t, snap, tickets) : listView(view, t, snap, tickets);
  return v_flex().id("jira-list").size_full().min_h(0).px(10).pb(10).overflow_y_scrollbar().children(rows);
}
