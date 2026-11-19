// Jira tickets and GitHub PRs, fetched once and shared by every copy of this mod.

import { exec, home, readTextFile, shared, setShared, notify } from "herdr";

export const POLL_MS = 120000;
// Data older than three polls is a lease that ran out: the views say it is stale.
export const STALE_MS = POLL_MS * 3;
const KEY = "tasks.snapshot";
const BUSY = "tasks.fetching";
const MOVES = "tasks.moves";
export const PR_CHANGED = "tasks.prChanged"; // { url, at } after a PR action, so an open PR page reloads
export const GH_ORG = "ripplepoint"; // the default owner of the board's All PRs tab
export const ALL_PRS = "tasks.allPrs"; // { owner, at, prs, total, owners, me } for the All PRs tab
// RIPPLE's Jira board: its columns, plus its active sprints and backlog for everyone's tickets.
const BOARD_ID = 21;
// The backlog's id in the fetch plan. Real sprint ids are numbers, so this never collides.
const BACKLOG = "backlog";
const FIELDS = "summary,status,priority,assignee,issuetype,parent,updated";
export const TICKET_KEY = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]+-\d+)/i;

const PR_FIELDS = `
fragment pr on PullRequest {
  number title url isDraft reviewDecision headRefName updatedAt
  author { __typename login }
  repository { name }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
  reviews(last: 50) { nodes { author { login } state submittedAt } }
  timelineItems(last: 30, itemTypes: [REVIEW_REQUESTED_EVENT]) {
    nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } } } }
  }
}`;

const PR_QUERY = `
query($mine: String!, $review: String!, $reviewed: String!, $others: String!) {
  viewer { login }
  mine: search(query: $mine, type: ISSUE, first: 50) { nodes { ...pr } }
  review: search(query: $review, type: ISSUE, first: 50) { nodes { ...pr } }
  reviewed: search(query: $reviewed, type: ISSUE, first: 50) { nodes { ...pr } }
  others: search(query: $others, type: ISSUE, first: 100) { nodes { ...pr } }
}
${PR_FIELDS}`;

// Every open PR of one owner (an organization, or the viewer's own repos), 100 a page.
const ALL_QUERY = `
query($q: String!, $after: String) {
  viewer { login organizations(first: 50) { nodes { login } } }
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ...pr }
  }
}
${PR_FIELDS}`;

export const snapshot = () => shared(KEY) ?? null;
export const ticketOf = (text) => text?.match(TICKET_KEY)?.[1]?.toUpperCase() ?? null;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
// The mod runtime has no TextEncoder or btoa.
function utf8(text) {
  const bytes = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return bytes;
}

function base64(text) {
  const bytes = utf8(text);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64[n & 63] : "=";
  }
  return out;
}

async function jiraConfig() {
  const text = await readTextFile(`${home()}/.config/jiratui/config.yaml`);
  if (!text) throw new Error("no ~/.config/jiratui/config.yaml");
  const config = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at > 0) config[line.slice(0, at).trim()] = line.slice(at + 1).trim().replace(/^["']|["']$/g, "");
  }
  config.base = config.jira_api_base_url.replace(/\/+$/, "");
  config.auth = `Basic ${base64(`${config.jira_api_username}:${config.jira_api_token}`)}`;
  return config;
}

export async function jira(path, { method = "GET", body } = {}) {
  const config = await jiraConfig();
  const headers = { Authorization: config.auth, Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  const response = await fetch(`${config.base}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) {
    const text = await response.text();
    let reason = text.slice(0, 200);
    try { reason = JSON.parse(text).errorMessages?.join(" ") || reason; } catch {}
    throw new Error(`HTTP ${response.status} ${reason}`.trim());
  }
  return response.status === 204 ? null : response.json();
}

function toTicket(issue, base, me, scope) {
  const f = issue.fields ?? {};
  const epic = f.parent?.fields?.issuetype?.name === "Epic" ? f.parent : null;
  return {
    key: issue.key,
    scope, // "sprint" or "backlog"
    summary: f.summary ?? "",
    status: f.status?.name ?? "",
    statusId: f.status?.id ?? "",
    category: f.status?.statusCategory?.key ?? "new",
    priority: f.priority?.name ?? "",
    type: f.issuetype?.name ?? "",
    assignee: f.assignee?.displayName ?? "Unassigned",
    mine: Boolean(me) && f.assignee?.accountId === me,
    epic: epic ? { key: epic.key, summary: epic.fields?.summary ?? "" } : null,
    url: `${base}/browse/${issue.key}`,
  };
}

// The board's columns and every ticket in its active sprints and backlog, in one round of parallel
// calls. REST beat Jira's GraphQL here: GraphQL pages hold 50 tickets and need the previous page's
// cursor, so a 147-ticket sprint took three rounds in a row. The ids and ticket counts of the last
// refresh (shared snapshot "jiraPlan") let every page start before the sprint list answers; a new
// sprint or extra pages are fetched after it.
const PAGE = 100;
let myAccountId = null;
const page = (id, at) => jira(id === BACKLOG
  ? `/rest/agile/1.0/board/${BOARD_ID}/backlog?fields=${FIELDS}&maxResults=${PAGE}&startAt=${at}`
  : `/rest/agile/1.0/sprint/${id}/issue?fields=${FIELDS}&maxResults=${PAGE}&startAt=${at}`);
const pageStarts = (total) => Array.from({ length: Math.max(1, Math.ceil(total / PAGE)) }, (_, i) => i * PAGE);

// Every page of one sprint or the backlog, reusing the pages started early.
async function allPages(id, early) {
  let pages = await Promise.all(early.get(id) ?? [page(id, 0)]);
  if (pages.some((p) => !p)) pages = [await page(id, 0)]; // an early page failed: start over
  const total = pages[0].total;
  const more = pageStarts(total).slice(pages.length);
  pages = [...pages, ...(await Promise.all(more.map((at) => page(id, at))))];
  return { id, total, issues: pages.flatMap((p) => p.issues) };
}

async function fetchJira() {
  const config = await jiraConfig();
  myAccountId ??= snapshot()?.jiraMe ?? null;
  const early = new Map((snapshot()?.jiraPlan ?? []).map((s) =>
    [s.id, pageStarts(s.total).map((at) => page(s.id, at).catch(() => null))]));
  // The backlog needs no sprint id, so it starts with the board calls, not after them.
  const backlog = allPages(BACKLOG, early);
  backlog.catch(() => {}); // awaited below; this only stops an early failure from counting as unhandled
  const [me, board, sprints] = await Promise.all([
    myAccountId ? null : jira("/rest/api/3/myself"),
    jira(`/rest/agile/1.0/board/${BOARD_ID}/configuration`),
    jira(`/rest/agile/1.0/board/${BOARD_ID}/sprint?state=active`),
  ]);
  if (me) myAccountId = me.accountId;
  const columns = board.columnConfig.columns
    .filter((c) => c.statuses.length)
    .map((c) => ({ name: c.name, statusIds: c.statuses.map((x) => x.id) }));
  const plan = await Promise.all([...(sprints.values ?? []).map((sprint) => allPages(sprint.id, early)), backlog]);
  // A ticket can shift pages between two parallel requests, or move from the backlog into a sprint
  // between them: keep each key once, sprint first.
  const seen = new Set();
  const tickets = plan.flatMap((s) => s.issues.map((i) => [i, s.id === BACKLOG ? "backlog" : "sprint"]))
    .filter(([i]) => !seen.has(i.key) && seen.add(i.key))
    .map(([i, scope]) => toTicket(i, config.base, myAccountId, scope));
  return {
    tickets, columns, sprint: (sprints.values ?? []).map((x) => x.name).join(", "),
    plan: plan.map(({ id, total }) => ({ id, total })), me: myAccountId,
  };
}

// ---- Status moves: optimistic, with rollback ----
// A move shows at once through an override in shared("tasks.moves"). It is dropped only when a
// fetch that started after Jira confirmed it lands, so an older in-flight poll cannot put the old
// status back. A failed move rolls back only if it is still the latest move for that ticket.

const PENDING_LIMIT_MS = 60000;
const categoryOf = (name) => (/done/i.test(name) ? "done" : /to do|backlog/i.test(name) ? "new" : "indeterminate");

export function withMoves(tickets) {
  const moves = shared(MOVES) ?? {};
  const now = Date.now();
  return tickets.map((x) => {
    const m = moves[x.key];
    if (!m || (m.state === "pending" && now - m.at > PENDING_LIMIT_MS)) return x;
    return { ...x, status: m.status, statusId: m.statusId, category: m.category, moving: m.state === "pending" };
  });
}

function setMove(key, move) {
  const moves = { ...(shared(MOVES) ?? {}) };
  if (move) moves[key] = move;
  else delete moves[key];
  setShared(MOVES, moves);
}

const latest = (key, seq) => (shared(MOVES) ?? {})[key]?.seq === seq;

// Moves a ticket to a board column. Picks the transition that lands in that column: the status
// named like the column first, else the column's first status Jira allows from here.
export async function moveTicket(ticket, column) {
  if (column.statusIds.includes(ticket.statusId)) return;
  // Unique across mod copies, which each have their own module state.
  const seq = `${Date.now()}-${Math.random()}`;
  setMove(ticket.key, { state: "pending", seq, at: Date.now(), status: column.name, statusId: column.statusIds[0], category: categoryOf(column.name) });
  try {
    const { transitions } = await jira(`/rest/api/3/issue/${ticket.key}/transitions`);
    const into = transitions.filter((t) => column.statusIds.includes(t.to.id));
    const pick = into.find((t) => t.to.name.toLowerCase() === column.name.toLowerCase())
      ?? column.statusIds.map((id) => into.find((t) => t.to.id === id)).find(Boolean);
    if (!pick) throw new Error(`Jira allows no move from ${ticket.status} to ${column.name}.`);
    await jira(`/rest/api/3/issue/${ticket.key}/transitions`, { method: "POST", body: { transition: { id: pick.id } } });
    if (latest(ticket.key, seq)) {
      setMove(ticket.key, { state: "ok", seq, at: Date.now(), status: pick.to.name, statusId: pick.to.id, category: pick.to.statusCategory?.key ?? categoryOf(pick.to.name) });
    }
  } catch (error) {
    if (latest(ticket.key, seq)) setMove(ticket.key, null);
    notify({ title: `${ticket.key} stayed in ${ticket.status}`, body: String(error.message ?? error), level: "error" });
  }
}

function pruneMoves(fetchStartedAt) {
  const moves = shared(MOVES) ?? {};
  const keep = Object.fromEntries(Object.entries(moves).filter(([, m]) =>
    m.state === "ok" ? m.at > fetchStartedAt : Date.now() - m.at < PENDING_LIMIT_MS));
  if (Object.keys(keep).length !== Object.keys(moves).length) setShared(MOVES, keep);
}

// Each reviewer's latest review, from the full list. Not latestReviews: GitHub drops a reviewer
// from it once their review is requested again, which hid every re-request.
// at: their latest review of any kind; state: their latest verdict, else that review's state.
function reviewsByAuthor(node) {
  const by = new Map();
  for (const r of node.reviews?.nodes ?? []) {
    const who = r.author?.login;
    if (!who || r.state === "PENDING") continue;
    const e = by.get(who) ?? { who, at: "", state: null, verdict: null };
    if (r.submittedAt >= e.at) { e.at = r.submittedAt; e.state = r.state; }
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state) && (!e.verdict || r.submittedAt >= e.verdict.at)) e.verdict = { state: r.state, at: r.submittedAt };
    by.set(who, e);
  }
  return [...by.values()].map((e) => ({ who: e.who, at: e.at, state: e.verdict?.state ?? e.state }));
}

// When each reviewer was last asked for a review.
function askedAtOf(node) {
  const askedAt = new Map();
  for (const e of node.timelineItems?.nodes ?? []) {
    const who = e.requestedReviewer?.login;
    if (who && (!askedAt.has(who) || e.createdAt > askedAt.get(who))) askedAt.set(who, e.createdAt);
  }
  return askedAt;
}

// My own side of a PR: my latest review, and the last time my review was requested.
// Re-requested: asked again after that review (the author pushed fixes and wants another look).
function myReviewOf(node, me) {
  if (!me) return {};
  const mine = reviewsByAuthor(node).find((r) => r.who === me);
  const asked = askedAtOf(node).get(me) ?? null;
  const myReview = mine ? { state: mine.state, at: mine.at } : null;
  return { myReview, rerequested: Boolean(myReview && asked && asked > myReview.at), requestedAt: asked };
}

// The PR's review state for its author. GitHub gives no reviewDecision when the repo does not
// require reviews (.github), so it is worked out from each reviewer's latest review. REREQUESTED:
// a reviewer was asked again after their latest review (changes pushed, waiting on them), which
// wins over their old verdict unless the PR is approved anyway.
function reviewOf(node) {
  const author = node.author?.login;
  const reviewers = reviewsByAuthor(node).filter((r) => r.who !== author);
  const askedAt = askedAtOf(node);
  const decision = node.reviewDecision
    || (reviewers.some((r) => r.state === "CHANGES_REQUESTED") ? "CHANGES_REQUESTED" : reviewers.some((r) => r.state === "APPROVED") ? "APPROVED" : "REVIEW_REQUIRED");
  const askedAgain = reviewers.filter((r) => askedAt.get(r.who) > r.at).map((r) => ({ who: r.who, was: r.state, at: askedAt.get(r.who) }));
  return { review: askedAgain.length && decision !== "APPROVED" ? "REREQUESTED" : decision, decision, askedAgain, reviewers };
}

function toPr(node, me) {
  return {
    ...myReviewOf(node, me),
    ...reviewOf(node),
    repo: node.repository.name,
    number: node.number,
    title: node.title,
    url: node.url,
    draft: node.isDraft,
    checks: node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? "",
    branch: node.headRefName,
    author: node.author?.login ?? "",
    ticket: ticketOf(node.headRefName) ?? ticketOf(node.title),
  };
}

// GitHub straight over HTTPS with gh's token. Starting gh for each call cost about a second
// more than the request itself. The token is read once and stays in this module's memory.
let ghToken = null;
async function githubToken() {
  if (ghToken) return ghToken;
  const r = await exec("gh", ["auth", "token"]);
  if (r.code !== 0 || !r.stdout.trim()) throw new Error(r.stderr.trim().slice(0, 160) || "gh auth token failed");
  ghToken = r.stdout.trim();
  return ghToken;
}

// accept: a media type that returns text (the diff); otherwise the response is JSON.
export async function github(path, { query, variables, accept } = {}) {
  const headers = { Authorization: `bearer ${await githubToken()}`, "User-Agent": "herdr-tasks", Accept: accept ?? "application/json" };
  if (query) headers["Content-Type"] = "application/json";
  const response = await fetch(`https://api.github.com${path}`, {
    method: query ? "POST" : "GET", headers, ...(query ? { body: JSON.stringify({ query, variables }) } : {}),
  });
  if (!response.ok) {
    if (response.status === 401) ghToken = null; // gh may have refreshed it: read it again next time
    throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 160)}`.trim());
  }
  return accept ? response.text() : response.json();
}

export async function graphql(query, variables) {
  const result = await github("/graphql", { query, variables });
  if (result.errors?.length) throw new Error(result.errors.map((e) => e.message).join("; ").slice(0, 200));
  return result.data;
}

async function fetchPrs() {
  const scope = `is:pr is:open archived:false org:${GH_ORG}`;
  const data = await graphql(PR_QUERY, {
    mine: `${scope} author:@me sort:updated-desc`,
    review: `${scope} review-requested:@me sort:updated-desc`,
    reviewed: `${scope} reviewed-by:@me -author:@me sort:updated-desc`,
    others: `${scope} -author:@me -review-requested:@me sort:updated-desc`,
  });
  const me = data.viewer?.login ?? null;
  // Bots (Dependabot) never request a review, and drafts are often not requested from me yet, so
  // both stay in the list while open, showing my review. A push after my review asks me again.
  const extra = data.others.nodes.filter((n) => n.author?.__typename === "Bot" || n.isDraft).map((n) => {
    const pr = toPr(n, me);
    const pushed = n.commits?.nodes?.[0]?.commit?.committedDate;
    if (!pr.myReview || !pushed || pushed <= pr.myReview.at) return pr;
    return { ...pr, rerequested: true, requestedAt: pushed, review: "REREQUESTED", askedAgain: [{ who: me, was: pr.myReview.state, at: pushed }] };
  });
  const review = [...data.review.nodes.map((n) => toPr(n, me)), ...extra];
  const asked = new Set(review.map((p) => p.url));
  return {
    me,
    mine: data.mine.nodes.map((n) => toPr(n, me)),
    review,
    // Open PRs I reviewed that are not waiting on me again.
    reviewed: data.reviewed.nodes.map((n) => toPr(n, me)).filter((p) => !asked.has(p.url) && p.myReview),
  };
}

// Refreshes the shared snapshot unless another copy just did or is doing it.
// A source that fails keeps its last good rows, so a Jira blip does not empty the board.
export async function refresh({ force = false } = {}) {
  const now = Date.now();
  const last = snapshot();
  const fresh = last && !last.errors.length && last.columns && now - last.at < POLL_MS - 5000;
  if (!force && fresh) return;
  if (now - (shared(BUSY) ?? 0) < 60000) return;
  setShared(BUSY, now);
  const errors = [];
  const [jiraData, prs] = await Promise.all([
    fetchJira().catch((e) => { errors.push(`Jira: ${e.message ?? e}`); return null; }),
    fetchPrs().catch((e) => { errors.push(`GitHub: ${e.message ?? e}`); return null; }),
  ]);
  setShared(KEY, {
    at: jiraData && prs ? Date.now() : last?.at ?? Date.now(),
    tickets: jiraData?.tickets ?? last?.tickets ?? [],
    columns: jiraData?.columns ?? last?.columns ?? [],
    sprint: jiraData?.sprint ?? last?.sprint ?? "",
    jiraPlan: jiraData?.plan ?? last?.jiraPlan ?? [],
    jiraMe: jiraData?.me ?? last?.jiraMe ?? null,
    mine: prs?.mine ?? last?.mine ?? [],
    review: prs?.review ?? last?.review ?? [],
    reviewed: prs?.reviewed ?? last?.reviewed ?? [],
    ghMe: prs?.me ?? last?.ghMe ?? null,
    errors,
  });
  setShared(BUSY, 0);
  if (jiraData) pruneMoves(now);
}

// The PR actions in the rail's dropdown, through gh. Merge uses a merge commit, as the team does.
const PR_ACTIONS = {
  merge: (url) => ["pr", "merge", url, "--merge"],
  close: (url) => ["pr", "close", url],
  draft: (url) => ["pr", "ready", url, "--undo"],
  ready: (url) => ["pr", "ready", url],
};

// Patches the snapshot at once (refresh skips while another fetch runs), then refetches.
export async function prAction(url, kind) {
  const r = await exec("gh", PR_ACTIONS[kind](url));
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 200) || `gh exited ${r.code}`);
  const snap = snapshot();
  if (snap) {
    const gone = kind === "merge" || kind === "close";
    const patch = (list) => (gone ? list.filter((p) => p.url !== url) : list.map((p) => (p.url === url ? { ...p, draft: kind === "draft" } : p)));
    setShared(KEY, { ...snap, mine: patch(snap.mine), review: patch(snap.review), reviewed: patch(snap.reviewed) });
  }
  setShared(PR_CHANGED, { url, at: Date.now() });
  refresh({ force: true }).catch(() => {});
}

const ALL_PAGES = 3; // up to 300 open PRs per owner

// The All PRs tab's data for `owner`: an organization's login, or the viewer's own (their repos).
export async function fetchAllPrs(owner, me) {
  const scope = me && owner === me ? `user:${owner}` : `org:${owner}`;
  let after = null, prs = [], total = 0, viewer = null;
  for (let page = 0; page < ALL_PAGES; page++) {
    const data = await graphql(ALL_QUERY, { q: `is:pr is:open archived:false ${scope} sort:updated-desc`, after });
    viewer = data.viewer;
    prs = prs.concat(data.search.nodes.filter((n) => n?.url).map((n) => toPr(n, viewer.login)));
    total = data.search.issueCount;
    if (!data.search.pageInfo.hasNextPage) break;
    after = data.search.pageInfo.endCursor;
  }
  const owners = [viewer.login, ...viewer.organizations.nodes.map((o) => o.login)];
  const result = { owner, at: Date.now(), prs, total, owners, me: viewer.login };
  setShared(ALL_PRS, result);
  return result;
}

export function openUrl(url) {
  exec("rundll32", ["url.dll,FileProtocolHandler", url]);
}

// The ticket and PRs a branch belongs to: the PR on that branch first, then its ticket's other PRs.
export function forBranch(snap, branch) {
  const key = ticketOf(branch);
  const ticket = withMoves(snap?.tickets ?? []).find((t) => t.key === key) ?? null;
  const prs = [...(snap?.mine ?? []), ...(snap?.review ?? [])]
    .filter((p) => (branch && p.branch === branch) || (key && p.ticket === key))
    .sort((a, b) => (b.branch === branch) - (a.branch === branch));
  return { key, ticket, prs };
}
