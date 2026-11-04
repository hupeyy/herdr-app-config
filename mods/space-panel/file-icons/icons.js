// VS Code's Material Icon Theme for file and folder names, resolved the way VS Code does it:
// exact file name, then the longest extension ("spec.ts" before "ts"), then the language, then the default.
// Other mods import this file and draw the path with image(), which keeps the icon's colours.

import DATA from "./data.js";

// Extensions VS Code maps to a language rather than to an icon of their own.
const LANG_OF = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescriptreact", js: "javascript", mjs: "javascript",
  cjs: "javascript", jsx: "javascriptreact", py: "python", cs: "csharp", json: "json", jsonc: "jsonc", md: "markdown",
  html: "html", htm: "html", css: "css", scss: "scss", less: "less", yml: "yaml", yaml: "yaml", xml: "xml",
  sh: "shellscript", bash: "shellscript", ps1: "powershell", psm1: "powershell", sql: "sql", java: "java", go: "go",
  rs: "rust", c: "c", h: "c", cpp: "cpp", hpp: "cpp", rb: "ruby", php: "php", vue: "vue", svelte: "svelte",
  toml: "toml", kt: "kotlin", swift: "swift", dart: "dart", lua: "lua", r: "r", bat: "bat", cmd: "bat",
};

const path = (icon) => `mods/file-icons/icons/${icon}.svg`;

// A light theme gets the icons' light variants, which keep their contrast on a pale background.
export function isLight(background) {
  const hex = (background ?? "").replace("#", "");
  if (hex.length < 6) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
}

function pick(table, lightTable, key, light) {
  return (light && lightTable?.[key]) || table[key];
}

export function fileIcon(name, light = false) {
  const lower = (name ?? "").split(/[\\/]/).pop().toLowerCase();
  const L = DATA.light;
  const exact = pick(DATA.names, L.fileNames, lower, light);
  if (exact) return path(exact);
  const parts = lower.split(".");
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join(".");
    const hit = pick(DATA.ext, L.fileExtensions, ext, light);
    if (hit) return path(hit);
  }
  const lang = LANG_OF[parts.length > 1 ? parts[parts.length - 1] : ""];
  const byLang = lang && pick(DATA.langs, L.languageIds, lang, light);
  return path(byLang || DATA.file);
}

export function folderIcon(name, open = false, light = false) {
  const lower = (name ?? "").split(/[\\/]/).pop().toLowerCase();
  const L = DATA.light;
  const hit = open ? pick(DATA.foldersOpen, L.folderNamesExpanded, lower, light) : pick(DATA.folders, L.folderNames, lower, light);
  return path(hit || (open ? DATA.folderOpen : DATA.folder));
}
