// Full Jira tickets and GitHub PRs for the detail views: body, comments, reviews, checks and diff.

import { jira, github, graphql } from "./data.js";

// ---- Jira: ADF (Atlassian Document Format) to markdown ----

function marks(text, list = []) {
  let out = text;
  for (const m of list) {
    if (m.type === "code") out = `\`${out}\``;
    else if (m.type === "strong") out = `**${out}**`;
    else if (m.type === "em") out = `*${out}*`;
    else if (m.type === "strike") out = `~~${out}~~`;
    else if (m.type === "link" && m.attrs?.href) out = `[${out}](${m.attrs.href})`;
  }
  return out;
}

function inline(nodes = []) {
  return nodes.map((n) => {
    switch (n.type) {
      case "text": return marks(n.text ?? "", n.marks);
      case "hardBreak": return "  \n";
      case "mention": return `**${n.attrs?.text ?? "@someone"}**`;
      case "emoji": return n.attrs?.text ?? n.attrs?.shortName ?? "";
      case "inlineCard": return n.attrs?.url ? `<${n.attrs.url}>` : "";
      case "status": return `\`${n.attrs?.text ?? ""}\``;
      case "date": return n.attrs?.timestamp ? new Date(+n.attrs.timestamp).toISOString().slice(0, 10) : "";
      default: return n.content ? inline(n.content) : "";
    }
  }).join("");
}

function block(n, indent = "") {
  const kids = n.content ?? [];
  switch (n.type) {
    case "doc": return kids.map((c) => block(c)).join("\n\n");
    case "paragraph": return indent + inline(kids);
    case "heading": return `${"#".repeat(n.attrs?.level ?? 2)} ${inline(kids)}`;
    case "bulletList":
    case "orderedList":
      return kids.map((item, i) => {
        const bullet = n.type === "orderedList" ? `${(n.attrs?.order ?? 1) + i}.` : "-";
        const [first, ...rest] = (item.content ?? []).map((c) => block(c, `${indent}  `).trimStart());
        return [`${indent}${bullet} ${first ?? ""}`, ...rest.map((r) => `${indent}  ${r}`)].join("\n");
      }).join("\n");
    case "taskList": return kids.map((item) => `${indent}- [${item.attrs?.state === "DONE" ? "x" : " "}] ${inline(item.content)}`).join("\n");
    case "codeBlock": return `\`\`\`${n.attrs?.language ?? ""}\n${kids.map((c) => c.text ?? "").join("")}\n\`\`\``;
    case "blockquote":
    case "panel": return kids.map((c) => block(c)).join("\n\n").split("\n").map((l) => `> ${l}`).join("\n");
    case "rule": return "---";
    case "table": {
      const rows = kids.map((r) => (r.content ?? []).map((cell) => (cell.content ?? []).map((c) => inline(c.content)).join(" ").replace(/\|/g, "\\|")));
      if (!rows.length) return "";
      const width = Math.max(...rows.map((r) => r.length));
      const line = (r) => `| ${[...r, ...Array(width - r.length).fill("")].join(" | ")} |`;
      return [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
    }
    case "mediaSingle":
    case "mediaGroup": return "*(attachment: open in Jira to view)*";
    case "expand":
    case "nestedExpand": return `**${n.attrs?.title ?? "Details"}**\n\n${kids.map((c) => block(c)).join("\n\n")}`;
    default: return kids.length ? kids.map((c) => block(c, indent)).join("\n\n") : inline([n]);
  }
}

export const adfToMarkdown = (doc) => (doc ? block(doc).trim() : "");

const ISSUE_FIELDS = "summary,description,status,priority,assignee,reporter,labels,issuetype,parent,comment,created,updated,project";

export async function fetchIssue(key) {
  const d = await jira(`/rest/api/3/issue/${key}?fields=${ISSUE_FIELDS}`);
  const f = d.fields;
  return {
    key: d.key,
    // The REST self link carries the site, so the URL never needs a hard-coded host.
    url: `${d.self.split("/rest/")[0]}/browse/${d.key}`,
    summary: f.summary ?? "",
    description: adfToMarkdown(f.description) || "*No description.*",
    status: f.status?.name ?? "",
    statusId: f.status?.id ?? "",
    category: f.status?.statusCategory?.key ?? "new",
    priority: f.priority?.name ?? "",
    type: f.issuetype?.name ?? "",
    assignee: f.assignee?.displayName ?? "Unassigned",
    reporter: f.reporter?.displayName ?? "",
    project: f.project?.key ?? "",
    labels: f.labels ?? [],
    epic: f.parent?.fields?.issuetype?.name === "Epic" ? { key: f.parent.key, summary: f.parent.fields.summary } : null,
    updated: f.updated,
    comments: (f.comment?.comments ?? []).map((c) => ({ id: c.id, author: c.author?.displayName ?? "", created: c.created, body: adfToMarkdown(c.body) })),
  };
}

// Plain text to ADF: one paragraph per line, so line breaks survive.
export async function postComment(key, text) {
  const content = text.split(/\r?\n/).map((line) => (line ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" }));
  await jira(`/rest/api/3/issue/${key}/comment`, { method: "POST", body: { body: { type: "doc", version: 1, content } } });
}

// ---- GitHub ----

// One GraphQL request, shaped like `gh pr view --json` so the page reads the same fields.
const PR_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number title body state isDraft url additions deletions changedFiles
      baseRefName headRefName updatedAt reviewDecision
      author { login }
      latestReviews(first: 50) { nodes { author { login } state body submittedAt } }
      reviewRequests(first: 50) { nodes { requestedReviewer {
        ... on User { login } ... on Team { name slug } ... on Bot { login } ... on Mannequin { login } } } }
      comments(first: 100) { nodes { author { login } body createdAt } }
      files(first: 100) { nodes { path additions deletions } }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } }
        ... on StatusContext { context state targetUrl }
      } } } } } }
    }
  }
}`;

const partsOf = (url) => {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`Not a pull request URL: ${url}`);
  return { owner: m[1], name: m[2], number: Number(m[3]) };
};

export async function fetchPr(url) {
  const { owner, name, number } = partsOf(url);
  const pr = (await graphql(PR_QUERY, { owner, name, number })).repository?.pullRequest;
  if (!pr) throw new Error(`${owner}/${name} #${number} was not found`);
  const contexts = pr.commits.nodes[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  return {
    ...pr,
    repo: `${owner}/${name}`,
    reviewDecision: pr.reviewDecision ?? "",
    latestReviews: pr.latestReviews.nodes,
    reviewRequests: pr.reviewRequests.nodes.map((n) => n.requestedReviewer).filter(Boolean),
    comments: pr.comments.nodes,
    files: pr.files.nodes,
    statusCheckRollup: contexts.map((c) => ({ ...c, workflowName: c.checkSuite?.workflowRun?.workflow?.name ?? "" })),
  };
}

// The PR's diff, split per file. A file's text is capped so a generated file cannot stall the UI.
// GraphQL has no diff, so this one call stays on REST.
const MAX_FILE_LINES = 3000;
export async function fetchDiff(url) {
  const { owner, name, number } = partsOf(url);
  const text = await github(`/repos/${owner}/${name}/pulls/${number}`, { accept: "application/vnd.github.diff" });
  const files = [];
  for (const line of text.split("\n")) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) { files.push({ path: head[2], lines: [] }); continue; }
    const file = files.at(-1);
    if (!file || /^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(line)) continue;
    if (file.lines.length < MAX_FILE_LINES) file.lines.push(line);
    else file.capped = true;
  }
  return files;
}

// Numbers each diff line once, like the shipped Changes panel.
export function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, old: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") return { kind, old: old++, number: next++, text: line.slice(1) || " " };
    return { kind: "", text: line };
  });
}

// ---- Shared helpers ----

export function ago(iso) {
  if (!iso) return "";
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h > 1 ? "s" : ""} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d > 1 ? "s" : ""} ago`;
}

export function branchName(ticket, login) {
  const slug = ticket.summary.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 6).join("-");
  return `${login ? `${login}/` : ""}${ticket.key}-${slug}`;
}

export function agentPrompt(issue, url) {
  return `Work on Jira issue ${issue.key}: ${issue.summary}\n\n${url}\n\n${issue.description}`;
}
