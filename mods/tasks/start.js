// One place that decides how a ticket or PR becomes a herdr workspace with a prompted agent.
// Pure (no herdr imports), so the mod's Start button and start.mjs (for chat) share it.

// Alex's sessions run in auto mode; plain `claude` would start in the configured plan mode.
export const AGENT_ARGV = ["claude", "--permission-mode", "auto"];

const TICKET_KEY = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]+-\d+)/i;
export const ticketIn = (...texts) => texts.map((t) => t?.match(TICKET_KEY)?.[1]?.toUpperCase()).find(Boolean) ?? null;

// The space and its first tab carry the ticket key, so the Agents list shows it on the agent row.
export function startSpec(item, devRoot) {
  if (item.kind === "ticket") {
    const name = item.key;
    const task = [
      `Let's work on ticket ${item.key}${item.summary ? `: ${item.summary}` : ""}.`,
      item.url,
    ].filter(Boolean).join("\n");
    return { name, tab: name, folder: devRoot, argv: AGENT_ARGV, task };
  }
  const key = item.ticket ?? ticketIn(item.branch, item.title);
  const name = `${key ?? item.repo} #${item.number}`;
  const task = [
    `Let's work on PR ${item.url} (${item.repo} #${item.number}${key ? `, ticket ${key}` : ""}): ${item.title}.`,
    `Branch ${item.branch} into ${item.base}. Check out the branch in a worktree, read the PR description,`,
    `the open review threads and the CI state, then tell me what is left to do.`,
  ].join("\n");
  return { name, tab: name, folder: devRoot, argv: AGENT_ARGV, task };
}
