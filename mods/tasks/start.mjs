// Opens a ticket or PR in a new herdr workspace with a prompted Claude, from a shell or a chat:
//   node ~/.config/herdr-app/mods/tasks/start.mjs RIPPLE-4801
//   node ~/.config/herdr-app/mods/tasks/start.mjs https://github.com/ripplepoint/RP_25_Backend/pull/1459
// If a space with that name exists, it is shown instead of a second one being made.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startSpec, ticketIn } from "./start.js";

const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", windowsHide: true });
const arg = process.argv[2];
if (!arg) {
  console.error("usage: start.mjs <TICKET-KEY | PR URL | owner/repo#number>");
  process.exit(2);
}

function jiraBase() {
  const text = readFileSync(join(homedir(), ".config", "jiratui", "config.yaml"), "utf8");
  const line = text.split(/\r?\n/).find((l) => l.startsWith("jira_api_base_url:"));
  return line?.slice(line.indexOf(":") + 1).trim().replace(/^["']|["']$/g, "").replace(/\/+$/, "");
}

function item() {
  const key = /^[A-Z][A-Z0-9]+-\d+$/i.test(arg) ? arg.toUpperCase() : null;
  if (key) return { kind: "ticket", key, url: `${jiraBase()}/browse/${key}` };
  const short = /^([^/\s]+\/[^#\s]+)#(\d+)$/.exec(arg);
  const ref = short ? `https://github.com/${short[1]}/pull/${short[2]}` : arg;
  const pr = JSON.parse(run("gh", ["pr", "view", ref, "--json", "number,title,headRefName,baseRefName,url"]));
  return {
    kind: "pr", url: pr.url, number: pr.number, title: pr.title, branch: pr.headRefName, base: pr.baseRefName,
    repo: pr.url.match(/github\.com\/[^/]+\/([^/]+)\/pull/)?.[1] ?? "", ticket: ticketIn(pr.headRefName, pr.title),
  };
}

const spec = startSpec(item(), join(homedir(), "Desktop", "dev"));
if (process.argv.includes("--dry-run")) {
  console.log(JSON.stringify(spec, null, 2));
  process.exit(0);
}
const existing = JSON.parse(run("herdr-app", ["ls"])).spaces.find((s) => s.name === spec.name);
if (existing) {
  run("herdr-app", ["do", "space.select", JSON.stringify({ id: existing.id })]);
  console.log(`Space "${spec.name}" already exists; showed it.`);
} else {
  console.log(run("herdr-app", ["do", "space.new", JSON.stringify(spec)]).trim());
  console.log(`Started "${spec.name}" with: ${spec.task.split("\n")[0]}`);
}
