// The board's Pull requests tab: every open PR of one owner (an organization, or your own repos) in
// one list, with Jira-style filters. Filters live in shared "tasks.prs" so they survive closing the
// board; the search starts empty each time.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { shared, setShared } from "herdr";
import { ALL_PRS, GH_ORG, POLL_MS, fetchAllPrs } from "./data.js";

const PREFS = "tasks.prs";
const GROUPS = [["repo", "Repo"], ["involve", "Involvement"], ["none", "None"]];
// Mine: what I have to do with a PR. A PR can match more than one.
const INVOLVE = [["mine", "Authored by me"], ["requested", "Review requested"], ["rerequested", "Re-requested"], ["reviewed", "Reviewed by me"]];
const STATES = [["ready", "Ready"], ["draft", "Draft"]];
const CI = [["SUCCESS", "Passing"], ["FAILURE", "Failing"], ["PENDING", "Running"], ["", "No checks"]];
const REVIEWS = [["APPROVED", "Approved"], ["CHANGES_REQUESTED", "Changes requested"], ["REREQUESTED", "Re-requested"], ["REVIEW_REQUIRED", "In review"]];

export function prPrefs() {
  const p = shared(PREFS) ?? {};
  return {
    owner: p.owner ?? GH_ORG, group: p.group ?? "repo", repos: p.repos ?? [], involve: p.involve ?? [],
    authors: p.authors ?? [], states: p.states ?? [], ci: p.ci ?? [], reviews: p.reviews ?? [],
  };
}
export function setPrPrefs(change) {
  setShared(PREFS, { ...prPrefs(), ...change });
}
const toggle = (list, item) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

// The old My PRs / Review requests links open this tab with that filter.
export const PRESETS = { mine: { involve: ["mine"] }, review: { involve: ["requested", "rerequested"] }, all: { involve: [] } };

// ---- data ----

// The shared PRs of the chosen owner, fetched when missing, for another owner, or a poll old.
export function prData(view, cx, force = false) {
  const { owner } = prPrefs();
  const data = shared(ALL_PRS);
  const current = data?.owner === owner ? data : null;
  if (!view.prLoading && (force || !current || Date.now() - current.at > POLL_MS)) {
    view.prLoading = true;
    view.prError = null;
    cx.spawn(async (cx) => {
      try { await fetchAllPrs(owner, data?.me); } catch (e) { view.prError = String(e.message ?? e); }
      view.prLoading = false;
      cx.notify();
    });
  }
  return { owner, data: current, owners: data?.owners ?? [owner], me: data?.me ?? null };
}

// What I have to do with each PR. Pending requests come from the snapshot's review-requested search
// (exact, for the default org); for other owners, from my request and review history on the PR.
function involvement(pr, me, requestedUrls) {
  const requested = requestedUrls.has(pr.url) || Boolean(pr.requestedAt && (!pr.myReview || pr.rerequested));
  return {
    mine: Boolean(me) && pr.author === me,
    requested: requested && !pr.rerequested,
    rerequested: Boolean(pr.rerequested),
    reviewed: Boolean(pr.myReview) && !requested,
  };
}

function withInvolvement(prs, me, snap) {
  const requestedUrls = new Set((snap?.review ?? []).map((p) => p.url));
  return prs.map((p) => ({ ...p, involve: involvement(p, me, requestedUrls) }));
}

export function filteredPrs(view, snap, data, me) {
  const p = prPrefs();
  const q = (view.prSearch?.value() ?? "").trim().toLowerCase();
  return withInvolvement(data?.prs ?? [], me, snap).filter((x) =>
    (!p.repos.length || p.repos.includes(x.repo)) &&
    (!p.involve.length || p.involve.some((k) => x.involve[k])) &&
    (!p.authors.length || p.authors.includes(x.author)) &&
    (!p.states.length || p.states.includes(x.draft ? "draft" : "ready")) &&
    (!p.ci.length || p.ci.includes(ciOf(x))) &&
    (!p.reviews.length || p.reviews.includes(x.review || "REVIEW_REQUIRED")) &&
    (!q || `#${x.number} ${x.title} ${x.branch} ${x.ticket ?? ""} ${x.author} ${x.repo}`.toLowerCase().includes(q)));
}

// ERROR counts as failing and EXPECTED as running, like the badges.
const ciOf = (pr) => (pr.checks === "ERROR" ? "FAILURE" : pr.checks === "EXPECTED" ? "PENDING" : pr.checks || "");

// Groups for the list: by repo, by involvement (a PR shows once, under its most urgent kind), or none.
export function prGroupsOf(prs) {
  const { group } = prPrefs();
  if (group === "none") return [{ id: "prs-all", label: "Open pull requests", tone: null, items: prs }];
  if (group === "involve") {
    const order = [["rerequested", "Re-requested", "working"], ["requested", "Review requested", "blocked"], ["mine", "Authored by me", "blue"], ["reviewed", "Reviewed by me", "done"], ["other", "Others", null]];
    const kind = (x) => order.find(([k]) => k !== "other" && x.involve[k])?.[0] ?? "other";
    return order.map(([k, label, tone]) => ({ id: `prs-inv-${k}`, label, tone, items: prs.filter((x) => kind(x) === k) })).filter((g) => g.items.length);
  }
  const repos = [...new Set(prs.map((x) => x.repo))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return repos.map((r) => ({ id: `prs-repo-${r}`, label: r, tone: null, items: prs.filter((x) => x.repo === r) }));
}

// ---- toolbar ----

const chip = (t, id, label, on, onClick, count) =>
  h_flex().id(id).h(24).px(8).gap(5).flex_none().items_center().rounded(12).text_size(11.5)
    .border_1().border_color(on ? t.accent : t.border)
    .bg(on ? t.selected : t.popover).text_color(on ? t.foreground : t.muted)
    .cursor_pointer().hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => { onClick(cx); cx.notify(); })
    .child(label)
    .when(count != null, (el) => el.child(div().text_color(t.dim).child(String(count))));

const label = (t, text) => div().w(78).flex_none().text_size(11).text_color(t.dim).child(text);

// One filter row: a label, a chip per value (with how many PRs of the owner have it), and a reset.
function filterRow(t, id, title, values, picked, set, countOf, resetLabel) {
  return h_flex().id(`prf-${id}`).gap(4).items_center().overflow_x_scrollbar()
    .child(label(t, title))
    .children(values.map(([value, text]) => chip(t, `prf-${id}-${value || "none"}`, text, picked.includes(value), () => set(toggle(picked, value)), countOf(value))))
    .when(picked.length > 0, (el) => el.child(chip(t, `prf-${id}-reset`, resetLabel, false, () => set([]))));
}

export function prToolbar(view, t, cx, snap) {
  const p = prPrefs();
  const { owner, data, owners, me } = prData(view, cx);
  const all = withInvolvement(data?.prs ?? [], me, snap);
  const count = (pred) => all.filter(pred).length;
  const repos = [...new Set(all.map((x) => x.repo))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const authors = [...new Set(all.map((x) => x.author))].filter((a) => a && a !== me).sort((a, b) => count((x) => x.author === b) - count((x) => x.author === a));
  const shown = data ? filteredPrs(view, snap, data, me).length : 0;
  const status = view.prError ? view.prError
    : !data ? "Loading…"
    : `${shown} of ${data.total} open${data.total > data.prs.length ? ` (first ${data.prs.length} loaded)` : ""}${view.prLoading ? " · refreshing…" : ""}`;
  // Switching owner clears the repo and author filters: they name another owner's repos and people.
  const setOwner = (o) => { setPrPrefs({ owner: o, repos: [], authors: [] }); prData(view, cx); };

  return v_flex().id("pr-toolbar").px(14).pt(8).pb(6).gap(6).flex_none().border_b(1).border_color(t.border)
    .child(h_flex().gap(8).items_center()
      .child(div().text_size(11).text_color(t.dim).child("Group by"))
      .child(h_flex().gap(2).p(2).rounded(8).bg(t.surface).children(GROUPS.map(([id, text]) =>
        div().id(`prg-${id}`).px(10).h(24).rounded(6).flex().items_center().cursor_pointer()
          .text_color(p.group === id ? t.foreground : t.muted).when(p.group === id, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { setPrPrefs({ group: id }); cx.notify(); })
          .child(text))))
      .child(h_flex().flex_1().h(28).px(8).gap(6).items_center().rounded(7).border_1().border_color(view.searchFocused ? t.accent : t.input)
        .child(svg("mods/workspace-chrome/search.svg").size(13).text_color(t.dim))
        .child(Input.new(view.prSearch).flex_1().h_full().text_size(12.5).text_color(t.foreground)))
      .child(div().text_size(11).text_color(view.prError ? t.blocked : t.dim).child(status))
      .child(div().id("prs-refresh").px(4).rounded(5).text_color(t.dim).cursor_pointer().tooltip("Refresh")
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { prData(view, cx, true); cx.notify(); })
        .child("↻")))
    .child(h_flex().gap(4).items_center().overflow_x_scrollbar()
      .child(label(t, "Owner"))
      .children([...new Set([owner, ...owners])].map((o) => chip(t, `pro-${o}`, o === me ? `${o} (you)` : o, o === owner, () => setOwner(o)))))
    .child(filterRow(t, "involve", "Mine", INVOLVE, p.involve, (v) => setPrPrefs({ involve: v }), (k) => count((x) => x.involve[k]), "Everyone's"))
    .child(filterRow(t, "repo", "Repo", repos.map((r) => [r, r]), p.repos, (v) => setPrPrefs({ repos: v }), (r) => count((x) => x.repo === r), "All repos"))
    .child(filterRow(t, "author", "Author", authors.map((a) => [a, a]), p.authors, (v) => setPrPrefs({ authors: v }), (a) => count((x) => x.author === a), "Anyone"))
    .child(h_flex().gap(14).items_center().overflow_x_scrollbar()
      .child(filterRow(t, "state", "State", STATES, p.states, (v) => setPrPrefs({ states: v }), (s) => count((x) => (x.draft ? "draft" : "ready") === s), "Any"))
      .child(filterRow(t, "ci", "CI", CI, p.ci, (v) => setPrPrefs({ ci: v }), (c) => count((x) => ciOf(x) === c), "Any")))
    .child(filterRow(t, "review", "Review", REVIEWS, p.reviews, (v) => setPrPrefs({ reviews: v }), (r) => count((x) => (x.review || "REVIEW_REQUIRED") === r), "Any"));
}
