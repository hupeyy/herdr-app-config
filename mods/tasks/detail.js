// Orca-style detail views: a Jira ticket drawer beside the board, and a full PR page.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Textarea, TextView, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, run, notify, home, settings, closeOverlay, props, shared, setShared } from "herdr";
import { withMoves, snapshot } from "./data.js";
import { fetchIssue, postComment, fetchPr, fetchDiff, diffRows, ago, branchName, agentPrompt } from "./detail-data.js";
import { startSpec } from "./start.js";
import { ink, onFill } from "./colors.js";
import { brand, JIRA, GITHUB, brandColor } from "./brand.js";

// A name from workspace-chrome, or a full asset path (the brand marks).
const ICON = (name) => (name.includes("/") ? name : `mods/workspace-chrome/${name}.svg`);
const CATEGORY_TONE = { indeterminate: "working", done: "done", new: "muted" };

// ---- Loading: one cache entry per ticket or PR, kept while the board is open ----

export function load(view, cx, id, fetcher) {
  const entry = view.details.get(id);
  if (entry && !entry.stale) return entry;
  const next = { loading: true, data: entry?.data ?? null, error: null };
  view.details.set(id, next);
  cx.spawn(async (cx) => {
    try { next.data = await fetcher(); } catch (e) { next.error = String(e.message ?? e); }
    next.loading = false;
    cx.notify();
  });
  return next;
}

// ---- Start workspace (shared with start.mjs through start.js) ----

// A new dev workspace goes into the root workspace you are in, in that root's folder. Its root
// waits in shared("space.pending") until the space appears (space-tabs applies it).
function startWorkspace(item) {
  const active = spaces().find((s) => s.active);
  const root = (shared("roots") ?? []).find((r) => r.id === (shared("space.root") ?? {})[active?.id]);
  const spec = startSpec(item, root?.folder ?? `${home()}\\Desktop\\dev`);
  const existing = spaces().find((s) => s.name === spec.name);
  if (existing) run("space.select", { id: existing.id });
  else {
    // The new dev workspace's card shows where it came from: the Jira or the GitHub mark.
    setShared("space.pending", { before: spaces().map((s) => s.id), root: root?.id ?? null, icon: item.kind === "pr" ? "github" : "jira", at: Date.now() });
    run("space.new", spec);
  }
  if (props()?.overlay) closeOverlay(props().overlay);
}

// ---- Small parts ----

const button = (t, id, label, onClick, { primary = false, icon = null, disabled = false } = {}) =>
  h_flex().id(id).h(30).px(12).gap(6).flex_none().items_center().rounded(7).text_size(12.5)
    .bg(primary ? t.solid : t.surface).text_color(primary ? t.solid_foreground : t.foreground)
    .border_1().border_color(primary ? t.solid : t.border)
    .when(disabled, (el) => el.opacity(0.5))
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((e, cx) => { cx.stop_propagation(); onClick(cx); }))
    .when(Boolean(icon), (el) => el.child(svg(ICON(icon)).size(13)))
    .child(label);

const action = (t, id, label, icon, onClick, tint) =>
  h_flex().id(id).h(28).px(8).gap(8).items_center().rounded(6).text_size(12).text_color(t.muted)
    .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_click((_e, cx) => onClick(cx))
    .child(svg(ICON(icon)).size(13).flex_none().when(Boolean(tint), (el) => el.text_color(tint)))
    .child(div().truncate().child(label));

function copy(cx, text, what) {
  cx.write_to_clipboard(text);
  notify({ title: `Copied ${what}`, body: text.length > 90 ? `${text.slice(0, 90)}…` : text, level: "success", timeout: 2500 });
}

const markdown = (id, text) => TextView.markdown(id, text || "").selectable(true);

const pill = (t, label, tone) =>
  div().flex_none().px(7).h(20).rounded(10).flex().items_center().text_size(11.5).font_medium()
    .bg(t[tone] ?? t.muted).text_color(onFill(t, t[tone] ?? t.muted)).child(label);

// ---- Jira ticket drawer ----

export function ticketDrawer(view, t, cx, key) {
  const entry = load(view, cx, `jira:${key}`, () => fetchIssue(key));
  const snap = snapshot();
  const base = entry.data;
  const shell = v_flex().id("drawer").w(0.58 * (view.size?.width ?? 1400)).flex_none().h_full().min_h(0)
    .bg(t.popover).border_l(1).border_color(t.border);
  if (!base) {
    return shell.child(h_flex().p(16).justify_between()
      .child(div().text_color(entry.error ? ink(t, "blocked", t.popover) : t.dim).child(entry.error ?? `Loading ${key}…`))
      .child(closeX(view, t)));
  }
  const issue = withMoves([base])[0];
  const url = issue.url;
  const login = snap?.mine?.[0]?.author ?? "";
  const here = (snap?.columns ?? []).find((c) => c.statusIds.includes(issue.statusId))?.name;
  const picking = view.picking === `drawer-${key}`;

  const header = v_flex().px(16).pt(12).pb(10).gap(6).flex_none().border_b(1).border_color(t.border)
    .child(h_flex().gap(8).items_center().text_size(11.5).text_color(t.dim)
      .child(brand(t, "jira", 13, t.popover))
      .child(div().text_color(t.muted).child(issue.key)).child(div().child(issue.assignee))
      .child(div().child(issue.project)).child(div().child(ago(issue.updated)))
      .child(div().flex_1())
      .child(button(t, "start-ticket", "Start workspace", () => startWorkspace({ kind: "ticket", key, summary: issue.summary, url }), { primary: true, icon: "chevron-right" }))
      .child(closeX(view, t)))
    .child(div().text_size(18).font_semibold().text_color(t.foreground).child(issue.summary))
    .child(h_flex().gap(8).items_center().pt(4)
      .child(h_flex().id("drawer-status").h(28).px(10).gap(6).items_center().rounded(7).cursor_pointer()
        .bg(t[CATEGORY_TONE[issue.category]] ?? t.muted).text_color(onFill(t, t[CATEGORY_TONE[issue.category]] ?? t.muted))
        .hover((s) => s.opacity(0.85))
        .on_click((_e, cx) => { view.picking = picking ? null : `drawer-${key}`; cx.notify(); })
        .child(div().font_medium().child(issue.moving ? `${issue.status} …` : issue.status))
        .child(svg(ICON("chevron-down")).size(11)))
      .child(div().text_size(12).text_color(issue.priority.startsWith("High") ? ink(t, "blocked", t.popover) : t.muted).child(issue.priority))
      .child(div().px(10).h(28).flex().items_center().rounded(7).border_1().border_color(t.border).text_size(12.5).child(issue.assignee))
      .children(issue.labels.map((l) => div().px(8).h(22).flex().items_center().rounded(11).bg(t.raised).text_size(11).text_color(t.muted).child(l))))
    .when(picking, (el) => el.child(h_flex().gap(4).flex_wrap().pt(4)
      .child(div().text_size(11).text_color(t.dim).mr(4).child("Move to"))
      .children((snap?.columns ?? []).filter((c) => c.name !== here).map((c) =>
        div().id(`dmv-${c.name}`).h(24).px(9).flex().items_center().rounded(12).border_1().border_color(t.border).text_size(11.5)
          .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { view.picking = null; view.move(issue, c, cx); })
          .child(c.name)))));

  const body = v_flex().id("drawer-body").flex_1().min_w(0).min_h(0).px(16).py(12).gap(14).overflow_y_scrollbar()
    .child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.dim)
      .child(div().text_color(t.muted).font_medium().child(issue.type))
      .child(div().child(`${issue.project} · ${issue.reporter ? `reported by ${issue.reporter}` : ""}`))
      .when(Boolean(issue.epic), (el) => el.child(div().truncate().child(`· ${issue.epic.summary}`))))
    .child(div().text_size(13).text_color(t.foreground).child(markdown(`desc-${key}`, issue.description)))
    .child(div().text_size(12).font_medium().text_color(t.dim).pt(6).child(`Comments ${issue.comments.length}`))
    .children(issue.comments.map((c) => v_flex().gap(4).p(10).rounded(8).bg(t.surface).border_1().border_color(t.border)
      .child(h_flex().gap(8).text_size(11.5).child(div().font_medium().text_color(t.foreground).child(c.author)).child(div().text_color(t.dim).child(ago(c.created))))
      .child(div().text_size(12.5).text_color(t.foreground).child(markdown(`cm-${c.id}`, c.body)))));

  const side = v_flex().w(220).flex_none().h_full().px(8).py(12).gap(2).border_l(1).border_color(t.border)
    .child(action(t, "a-open", "Open in Jira", JIRA, (cx) => cx.open_url(url), brandColor(t, "jira", t.popover)))
    .child(action(t, "a-url", "Copy URL", "file-text", (cx) => copy(cx, url, "URL")))
    .child(action(t, "a-key", "Copy key", "file-text", (cx) => copy(cx, key, "key")))
    .child(action(t, "a-branch", "Copy suggested branch name", "git-branch", (cx) => copy(cx, branchName(issue, login), "branch name")))
    .child(action(t, "a-prompt", "Copy prompt", "square-pen", (cx) => copy(cx, agentPrompt(issue, url), "prompt")));

  const sending = view.commentBusy === key;
  const composer = h_flex().p(10).gap(8).flex_none().items_end().border_t(1).border_color(t.border)
    .child(div().flex_1().min_w(0).child(Textarea.new(view.comment).w_full().text_size(12.5)))
    .child(button(t, "comment-send", sending ? "Sending…" : "Comment", (cx) => {
      const text = view.comment.value().trim();
      if (!text) return;
      view.commentBusy = key;
      cx.spawn(async (cx) => {
        try {
          await postComment(key, text);
          view.comment.set_value("");
          view.details.get(`jira:${key}`).stale = true;
        } catch (e) {
          notify({ title: `Comment not posted on ${key}`, body: String(e.message ?? e), level: "error" });
        }
        view.commentBusy = null;
        cx.notify();
      });
    }, { disabled: sending }));

  return shell.child(header).child(h_flex().flex_1().min_h(0).child(body).child(side)).child(composer);
}

function closeX(view, t) {
  return div().id("drawer-close").p(4).rounded(5).text_color(t.dim).cursor_pointer().tooltip("Close (Esc)")
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_click((_e, cx) => { view.detail = null; cx.notify(); })
    .child(svg(ICON("x")).size(14));
}

// ---- PR page ----

const CHECK = {
  SUCCESS: ["✓", "Successful", "done"], NEUTRAL: ["○", "Neutral", "dim"], SKIPPED: ["○", "Skipped", "dim"],
  FAILURE: ["✗", "Failed", "blocked"], ERROR: ["✗", "Error", "blocked"], CANCELLED: ["✗", "Cancelled", "blocked"],
  TIMED_OUT: ["✗", "Timed out", "blocked"], ACTION_REQUIRED: ["!", "Action required", "blocked"],
  PENDING: ["●", "Running", "working"], IN_PROGRESS: ["●", "Running", "working"], QUEUED: ["●", "Queued", "working"],
};
const checkOf = (c) => ({
  name: c.workflowName && c.name ? `${c.workflowName} / ${c.name}` : c.name ?? c.context ?? "check",
  state: c.conclusion || (c.status && c.status !== "COMPLETED" ? c.status : null) || c.state || "PENDING",
  url: c.detailsUrl ?? c.targetUrl ?? null,
});
const REVIEW_STATE = { APPROVED: ["Approved", "done"], CHANGES_REQUESTED: ["Changes requested", "blocked"], COMMENTED: ["Commented", "muted"], DISMISSED: ["Dismissed", "dim"] };

export function prPage(view, t, cx, url) {
  const entry = load(view, cx, `pr:${url}`, () => fetchPr(url));
  const pr = entry.data;
  const back = h_flex().id("pr-back").gap(6).items_center().text_color(t.muted).cursor_pointer()
    .hover((s) => s.text_color(t.foreground))
    .on_click((_e, cx) => { view.detail = null; cx.notify(); })
    .child(svg(ICON("chevron-left")).size(13)).child("Pull requests");
  if (!pr) {
    return v_flex().size_full().p(18).gap(12).child(back)
      .child(div().text_color(entry.error ? ink(t, "blocked", t.popover) : t.dim).child(entry.error ?? "Loading the pull request…"));
  }
  const checks = (pr.statusCheckRollup ?? []).map(checkOf);
  const passing = checks.filter((c) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.state)).length;
  const failing = checks.filter((c) => (CHECK[c.state]?.[2] ?? "") === "blocked").length;
  const state = pr.state === "MERGED" ? ["Merged", "accent"] : pr.state === "CLOSED" ? ["Closed", "blocked"] : pr.isDraft ? ["Draft", "muted"] : ["Open", "done"];
  const tab = view.prTab ?? "conversation";
  const tabs = [["conversation", "Conversation", null], ["checks", "Checks", checks.length], ["files", "Files changed", pr.files.length]];

  const head = v_flex().px(22).pt(14).pb(0).gap(10).flex_none().border_b(1).border_color(t.border)
    .child(h_flex().gap(10).items_center().text_size(12.5)
      .child(back).child(brand(t, "github", 14)).child(div().text_color(t.dim).child(`${pr.repo}  ·  #${pr.number}`)).child(div().flex_1())
      .child(action(t, "pr-copy", "Copy URL", "file-text", (cx) => copy(cx, pr.url, "URL")))
      .child(action(t, "pr-open", "Open in GitHub", GITHUB, (cx) => cx.open_url(pr.url), brandColor(t, "github"))))
    .child(h_flex().gap(16).items_start()
      .child(div().flex_1().min_w(0).text_size(20).font_semibold().text_color(t.foreground)
        .child(`${pr.title}  `).child(div().text_color(t.dim).child(`#${pr.number}`)))
      .child(button(t, "start-pr", "Start workspace", () => startWorkspace({
        kind: "pr", url: pr.url, number: pr.number, title: pr.title, branch: pr.headRefName, base: pr.baseRefName,
        repo: pr.repo.split("/")[1] ?? pr.repo,
      }), { primary: true, icon: "chevron-right" })))
    .child(h_flex().gap(8).items_center().text_size(12)
      .child(pill(t, state[0], state[1]))
      .child(div().font_medium().text_color(t.foreground).child(pr.author?.login ?? ""))
      .child(div().px(6).h(20).flex().items_center().rounded(5).bg(t.raised).text_color(t.muted).child(pr.baseRefName))
      .child(div().text_color(t.dim).child("←"))
      .child(div().px(6).h(20).flex().items_center().rounded(5).bg(t.raised).text_color(t.muted).child(pr.headRefName))
      .child(div().text_color(t.dim).child(`·  updated ${ago(pr.updatedAt)}  ·  +${pr.additions} −${pr.deletions}`)))
    .child(h_flex().gap(4).children(tabs.map(([id, label, count]) => h_flex().id(`prt-${id}`).px(10).h(34).gap(6).items_center()
      .cursor_pointer().text_color(tab === id ? t.foreground : t.muted)
      .when(tab === id, (el) => el.border_b(2).border_color(t.accent))
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { view.prTab = id; cx.notify(); })
      .child(label)
      .when(count != null, (el) => el.child(div().px(5).rounded(8).bg(t.raised).text_size(11).text_color(t.dim).child(String(count)))))));

  const content = tab === "checks" ? checksTab(t, checks, passing, failing)
    : tab === "files" ? filesTab(view, t, cx, pr)
    : conversationTab(view, t, pr, checks, passing, failing);
  return v_flex().id("pr-page").size_full().min_h(0).child(head).child(div().flex_1().min_h(0).child(content));
}

function checkRow(t, c, i, bg) {
  const [glyph, word, tone] = CHECK[c.state] ?? ["●", c.state, "dim"];
  return h_flex().id(`chk-${i}`).px(12).h(34).gap(10).items_center().border_b(1).border_color(t.border)
    .when(Boolean(c.url), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => cx.open_url(c.url)))
    .child(div().w(14).text_color(ink(t, tone, bg)).child(glyph))
    .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.name))
    .child(div().text_size(11.5).text_color(ink(t, tone, bg)).child(word));
}

function summaryLine(t, checks, passing, failing, bg) {
  const tone = failing ? "blocked" : passing === checks.length ? "done" : "working";
  const text = !checks.length ? "No checks" : failing ? `${failing} failing, ${passing} passing` : passing === checks.length ? "All checks passing" : `${checks.length - passing} running, ${passing} passing`;
  return div().font_medium().text_color(checks.length ? ink(t, tone, bg) : t.dim).child(text);
}

function checksTab(t, checks, passing, failing) {
  return v_flex().id("checks").size_full().min_h(0).p(18).gap(10).overflow_y_scrollbar()
    .child(summaryLine(t, checks, passing, failing, t.popover))
    .child(v_flex().rounded(8).border_1().border_color(t.border).overflow_hidden().children(checks.map((c, i) => checkRow(t, c, i, t.popover))));
}

function conversationTab(view, t, pr, checks, passing, failing) {
  const events = [
    { who: pr.author?.login, at: pr.updatedAt, body: pr.body || "*No description provided.*", id: "body" },
    ...(pr.latestReviews ?? []).filter((r) => r.body).map((r, i) => ({ who: r.author?.login, at: r.submittedAt, body: r.body, id: `rv${i}`, state: r.state })),
    ...(pr.comments ?? []).map((c, i) => ({ who: c.author?.login, at: c.createdAt, body: c.body, id: `cm${i}` })),
  ];
  const card = (e) => v_flex().rounded(8).border_1().border_color(t.border).bg(t.surface)
    .child(h_flex().px(12).h(34).gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
      .child(div().font_medium().text_color(t.foreground).child(e.who ?? ""))
      .when(Boolean(e.state), (el) => el.child(div().text_color(ink(t, REVIEW_STATE[e.state]?.[1] ?? "muted", t.surface)).child(REVIEW_STATE[e.state]?.[0] ?? e.state)))
      .child(div().text_color(t.dim).child(ago(e.at))))
    .child(div().p(12).text_size(13).text_color(t.foreground).child(markdown(`pr-${e.id}`, e.body)));

  const reviewers = [
    ...(pr.latestReviews ?? []).map((r) => ({ who: r.author?.login, state: REVIEW_STATE[r.state] ?? [r.state, "muted"] })),
    ...(pr.reviewRequests ?? []).map((r) => ({ who: r.login ?? r.name ?? r.slug, state: ["Requested", "dim"] })),
  ];
  const side = v_flex().w(300).flex_none().gap(14)
    .child(v_flex().gap(6).p(12).rounded(8).border_1().border_color(t.border)
      .child(div().text_size(11).font_medium().text_color(t.dim).child("REVIEWERS"))
      .when(!reviewers.length, (el) => el.child(div().text_size(12).text_color(t.dim).child("No reviewers")))
      .children(reviewers.map((r) => h_flex().gap(8).items_center().text_size(12.5)
        .child(div().flex_1().truncate().text_color(t.foreground).child(r.who ?? ""))
        .child(div().text_size(11.5).text_color(ink(t, r.state[1], t.popover)).child(r.state[0])))))
    .child(v_flex().gap(6).p(12).rounded(8).border_1().border_color(t.border)
      .child(h_flex().items_center().child(div().flex_1().text_size(11).font_medium().text_color(t.dim).child("CHECKS")))
      .child(summaryLine(t, checks, passing, failing, t.popover))
      .child(v_flex().gap(0).children(checks.slice(0, 12).map((c, i) => checkRow(t, c, `s${i}`, t.popover))))
      .when(checks.length > 12, (el) => el.child(div().id("more-checks").text_size(11.5).text_color(t.muted).cursor_pointer()
        .on_click((_e, cx) => { view.prTab = "checks"; cx.notify(); }).child(`All ${checks.length} checks →`))));

  return h_flex().id("conv").size_full().min_h(0).p(18).gap(16).items_start().overflow_y_scrollbar()
    .child(v_flex().flex_1().min_w(0).gap(12).children(events.map(card)))
    .child(side);
}

function filesTab(view, t, cx, pr) {
  const entry = load(view, cx, `diff:${pr.url}`, () => fetchDiff(pr.url));
  const files = entry.data ?? [];
  const stats = new Map((pr.files ?? []).map((f) => [f.path, f]));
  const open = files.find((f) => f.path === view.prFile) ?? files[0];
  if (open && view.rowsFor !== `${pr.url}:${open.path}`) {
    view.rowsFor = `${pr.url}:${open.path}`;
    view.diffRows = diffRows(open.lines);
    view.diffWidth = Math.max(600, ...open.lines.map((l) => l.length * 7 + 90));
  }
  const list = v_flex().id("pr-files").w(320).flex_none().h_full().min_h(0).p(6).gap(1).overflow_y_scrollbar().border_r(1).border_color(t.border)
    .child(div().px(8).py(6).text_size(11).font_medium().text_color(t.dim).child(`FILES  ${files.length || pr.files.length}`))
    .when(!files.length, (el) => el.child(div().px(8).text_size(12).text_color(entry.error ? ink(t, "blocked", t.popover) : t.dim).child(entry.error ?? "Loading the diff…")))
    .children(files.map((f) => {
      const s = stats.get(f.path), parts = f.path.split("/"), name = parts.pop();
      const kind = s?.changeType === "ADDED" ? ["A", "done"] : s?.changeType === "DELETED" ? ["D", "blocked"] : ["M", "working"];
      return h_flex().id(`pf-${f.path}`).h(40).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .when(open?.path === f.path, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { view.prFile = f.path; cx.notify(); })
        .child(div().w(12).text_size(11).text_color(ink(t, kind[1], t.popover)).child(kind[0]))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(12.5).text_color(t.foreground).child(name))
          .when(parts.length > 0, (el) => el.child(div().truncate().text_size(10.5).text_color(t.dim).child(parts.join("/")))))
        .when(Boolean(s), (el) => el.child(div().text_size(11).text_color(ink(t, "done", t.popover)).child(`+${s.additions}`))
          .child(div().text_size(11).text_color(ink(t, "blocked", t.popover)).child(`−${s.deletions}`)));
    }));

  const add = t.ansi2 ?? t.done, del = t.ansi1 ?? t.blocked;
  const row = ({ kind, old, number, text }) => kind === "@"
    ? div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text)
    : h_flex().w_full().h(20).flex_none().gap(8)
      .when(kind === "+", (e) => e.bg(`${add.slice(0, 7)}22`)).when(kind === "-", (e) => e.bg(`${del.slice(0, 7)}22`))
      .child(div().w(38).flex_none().text_right().text_color(t.dim).child(old === undefined ? "" : String(old)))
      .child(div().w(38).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().w(12).flex_none().text_color(kind === "+" ? ink(t, "done", t.background) : kind === "-" ? ink(t, "blocked", t.background) : t.dim).child(kind === " " ? "" : kind))
      .child(div().flex_1().min_w(0).whitespace_nowrap().child(text));

  const diff = v_flex().flex_1().min_w(0).h_full().min_h(0).bg(t.background)
    .when(Boolean(open), (el) => el.child(h_flex().px(12).h(34).flex_none().items_center().gap(8).border_b(1).border_color(t.border).text_size(12)
      .child(div().flex_1().truncate().text_color(t.foreground).child(open.path))
      .when(Boolean(open.capped), (el) => el.child(div().text_color(t.dim).child("first 3,000 lines")))))
    .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11.5).text_color(t.foreground)
      .child(div().id("pr-diff-x").size_full().overflow_x_scrollbar()
        .child(div().w_full().min_w(view.diffWidth ?? 600).h_full()
          .child(v_virtual_list("pr-diff", (view.diffRows ?? []).length, 20, (i) => String(i),
            (range) => (view.diffRows ?? []).slice(range.start, range.end).map(row)).size_full())))
      .child(Scrollbar.vertical("pr-diff").viewport_from_layout().absolute().inset_0()));

  return h_flex().size_full().min_h(0).child(list).child(diff);
}
