// The PR actions dropdown (board rows and the PR page), on my own PRs only.
// Merge and Close ask again before they run. The popup is the tasks mod with props.prMenu.

import { openOverlay } from "herdr";

export const PR_ACTIONS = {
  merge: { label: "Merge (merge commit)", icon: "git-compare", busy: "Merging", done: "Merged", confirm: true },
  draft: { label: "Convert to draft", icon: "square-pen", busy: "Converting", done: "Converted to draft" },
  ready: { label: "Mark ready for review", icon: "circle-check", busy: "Marking ready", done: "Ready for review" },
  close: { label: "Close pull request", icon: "x", busy: "Closing", done: "Closed", confirm: true },
};

export const prActions = (pr) => (pr.draft ? ["ready", "close"] : ["merge", "draft", "close"]);

export const ownMenu = (me, pr) => (pr.author && pr.author === me
  ? { url: pr.url, number: pr.number, repo: pr.repo, title: pr.title, draft: pr.draft } : null);

const WIDTH = 260;

// below: the window-relative bounds of the button that opened it. The menu hangs under the
// button, right edges lined up. A click event has no position, so the caller saves the bounds
// from the mouse-down before it.
export function openPrMenu(menu, below) {
  const at = below ? { x: Math.max(8, below.x + below.width - WIDTH), y: below.y + below.height + 4 } : undefined;
  openOverlay({ mod: "tasks", kind: "popup", width: WIDTH, height: 48 + 31 * prActions(menu).length, props: { prMenu: menu }, ...(at ? { at } : {}) });
}
