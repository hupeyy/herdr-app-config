// The Jira and GitHub marks (Simple Icons, CC0; files in mods/file-icons/brand). They are
// one-colour masks: Jira takes Atlassian blue, raised to 3:1 against the surface it sits on;
// GitHub takes the theme's text colour, as GitHub's own mark is black or white.

import { svg } from "gpui-kit";
import { contrast } from "./colors.js";

export const JIRA = "mods/file-icons/brand/jira.svg";
export const GITHUB = "mods/file-icons/brand/github.svg";
const JIRA_BLUE = "#2684FF";
const JIRA_DEEP = "#0052CC";

export function brandColor(t, which, bg = t.background) {
  if (which === "github") return t.foreground;
  return contrast(JIRA_BLUE, bg) >= 3 ? JIRA_BLUE : JIRA_DEEP;
}

export function brand(t, which, size = 13, bg) {
  return svg(which === "github" ? GITHUB : JIRA).size(size).flex_none().text_color(brandColor(t, which, bg));
}
