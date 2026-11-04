// Jira tickets and GitHub PRs, fetched once and shared by every copy of this mod.

import { exec, home, readTextFile, shared, setShared, notify } from "herdr";

export const POLL_MS = 120000;
// Data older than three polls is a lease that ran out: the views say it is stale.
export const STALE_MS = POLL_MS * 3;
const KEY = "tasks.snapshot";
const BUSY = "tasks.fetching";
const MOVES = "tasks.moves";
const GH_ORG = "ripplepoint";
// RIPPLE's Jira board: its columns, and its active sprint for everyone's tickets.
const BOARD_ID = 21;
const FIELDS = "summary,status,priority,assignee,issuetype,parent,updated";
export const TICKET_KEY = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]+-\d+)/i;

const PR_QUERY = `
query($mine: String!, $review: String!) {
  mine: search(query: $mine, type: ISSUE, first: 50) { nodes { ...pr } }
  review: search(query: $review, type: ISSUE, first: 50) { nodes { ...pr } }
}
fragment pr on PullRequest {
  number title url isDraft reviewDecision headRefName updatedAt
  author { login }
  repository { name }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

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

function toTicket(issue, base, me) {
  const f = issue.fields ?? {};
  const epic = f.parent?.fields?.issuetype?.name === "Epic" ? f.parent : null;
  return {
    key: issue.key,
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

// The board's columns and every ticket in its active sprint (a page holds at most 100).
async function fetchJira() {
  const config = await jiraConfig();
  const [me, board, sprints] = await Promise.all([
    jira("/rest/api/3/myself"),
    jira(`/rest/agile/1.0/board/${BOARD_ID}/configuration`),
    jira(`/rest/agile/1.0/board/${BOARD_ID}/sprint?state=active`),
  ]);
  const columns = board.columnConfig.columns
    .filter((c) => c.statuses.length)
    .map((c) => ({ name: c.name, statusIds: c.statuses.map((x) => x.id) }));
  const tickets = [];
  for (const sprint of sprints.values ?? []) {
    for (let at = 0; ; at += 100) {
      const page = await jira(`/rest/agile/1.0/sprint/${sprint.id}/issue?fields=${FIELDS}&maxResults=100&startAt=${at}`);
      tickets.push(...page.issues.map((i) => toTicket(i, config.base, me.accountId)));
      if (!page.issues.length || at + page.issues.length >= page.total) break;
    }
  }
  return { tickets, columns, sprint: (sprints.values ?? []).map((x) => x.name).join(", ") };
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

function toPr(node) {
  return {
    repo: node.repository.name,
    number: node.number,
    title: node.title,
    url: node.url,
    draft: node.isDraft,
    review: node.reviewDecision ?? "",
    checks: node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? "",
    branch: node.headRefName,
    author: node.author?.login ?? "",
    ticket: ticketOf(node.headRefName) ?? ticketOf(node.title),
  };
}

async function fetchPrs() {
  const scope = `is:pr is:open archived:false org:${GH_ORG}`;
  const r = await exec("gh", [
    "api", "graphql",
    "-f", `query=${PR_QUERY}`,
    "-f", `mine=${scope} author:@me sort:updated-desc`,
    "-f", `review=${scope} review-requested:@me sort:updated-desc`,
  ]);
  if (r.code !== 0) throw new Error(r.stderr.trim().slice(0, 160) || `gh exited ${r.code}`);
  const data = JSON.parse(r.stdout).data;
  return { mine: data.mine.nodes.map(toPr), review: data.review.nodes.map(toPr) };
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
    mine: prs?.mine ?? last?.mine ?? [],
    review: prs?.review ?? last?.review ?? [],
    errors,
  });
  setShared(BUSY, 0);
  if (jiraData) pruneMoves(now);
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
