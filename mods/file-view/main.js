// A file browser and editor as its own tab in a space, apart from any agent's terminal.
// props: { root, file? }. With a file (opened from the Files panel, files-dev) it shows only the
// editor and loads the folder tree only when the tree button asks for it; without one it browses.
// The open file follows the disk: a change reloads it, unless you have unsaved edits.
// A file with git changes opens on its diff against HEAD; the header switches File / Changes.
// Saving refuses to overwrite a file that changed on disk since it was opened.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { exec, readTextFile, writeTextFile, watchFolder, theme, settings, props, notify, shared, setShared, panes, focused } from "herdr";
import { fileIcon, folderIcon, isLight } from "./file-icons/icons.js";

// { paneId: { root, file, mark } } for every open file tab. herdr keeps no mod props we can read
// back, so the pane header (pane-dev), the cards (space-panel) and a drag read it here.
const TABS = "file.tabs";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html", cs: "csharp", ps1: "powershell" };
const RECENT = "space.files";
const MAX_DIFF_LINES = 4000;
const join = (root, rel) => `${root.replace(/[\\/]+$/, "")}\\${rel.replaceAll("/", "\\")}`;
const norm = (p) => p.replaceAll("/", "\\").toLowerCase();

// VS Code's git colours: modified yellow, added or untracked green, deleted or conflicted red.
const markColor = (t, mark) => (mark === "M" ? t.ansi3 : mark === "A" ? t.ansi2 : mark ? t.ansi1 : null);

async function directory(path) {
  const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=$_.PSIsContainer } }) | ConvertTo-Json -Compress } '" + path.replaceAll("'", "''") + "'"]);
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const result = JSON.parse(r.stdout || "[]");
  return (Array.isArray(result) ? result : [result]).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
}

const git = (cwd, args) => exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], { cwd }).catch(() => null);

// porcelain XY -> one VS Code letter.
const letter = (xy) => (xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M");

// Git marks for everything under root, keyed by root-relative path with "/" (and its folders).
async function statusUnder(root) {
  const top = await git(root, ["rev-parse", "--show-toplevel"]);
  if (top?.code !== 0) return {};
  const status = await git(root, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--", "."]);
  if (status?.code !== 0) return {};
  const base = norm(top.stdout.trim());
  const here = norm(root.replace(/[\\/]+$/, ""));
  const marks = {};
  for (const entry of status.stdout.split("\0").filter(Boolean)) {
    const abs = `${base}\\${norm(entry.slice(3))}`;
    if (!abs.startsWith(`${here}\\`)) continue;
    const rel = abs.slice(here.length + 1).replaceAll("\\", "/");
    const m = letter(entry.slice(0, 2));
    marks[rel] = m;
    // A folder takes its children's mark, as VS Code dots a folder holding changes.
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) marks[parts.slice(0, i).join("/")] ??= m;
  }
  return marks;
}

// The file's mark and its diff against HEAD ("" when unchanged or untracked).
async function fileChanges(root, rel) {
  const abs = join(root, rel);
  const st = await git(root, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--", abs]);
  if (st?.code !== 0) return { mark: null, diff: "" };
  const entry = st.stdout.split("\0").find(Boolean);
  if (!entry) return { mark: null, diff: "" };
  const mark = letter(entry.slice(0, 2));
  if (mark === "A" && entry.startsWith("??")) return { mark, diff: "" };
  const d = await git(root, ["diff", "HEAD", "--no-color", "--no-ext-diff", "-U3", "--", abs]);
  return { mark, diff: d?.code === 0 ? d.stdout : "" };
}

// Unified diff -> rows with old/new line numbers.
function diffRows(diff) {
  const rows = [];
  let a = 0, b = 0;
  for (const line of diff.split("\n")) {
    if (rows.length >= MAX_DIFF_LINES) { rows.push({ kind: "more", text: "… diff cut here" }); break; }
    if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (m) { a = Number(m[1]); b = Number(m[2]); }
      rows.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+") && !line.startsWith("+++")) rows.push({ kind: "add", b: b++, text: line.slice(1) });
    else if (line.startsWith("-") && !line.startsWith("---")) rows.push({ kind: "del", a: a++, text: line.slice(1) });
    else if (line.startsWith(" ")) rows.push({ kind: "ctx", a: a++, b: b++, text: line.slice(1) });
  }
  return rows;
}

function remember(root, rel) {
  const all = { ...(shared(RECENT) ?? {}) };
  all[root] = [rel, ...(all[root] ?? []).filter((x) => x !== rel)].slice(0, 8);
  setShared(RECENT, all);
}

export default class FileView extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.root = props()?.root ?? "";
    this.entries = new Map(); // rel folder ("" = root) -> entries; loaded only when the tree shows
    this.open = new Set([""]);
    this.marks = {};
    this.tree = !props()?.file;
    this.pane = props()?.pane ?? null;
    this.mode = "file"; // "file" | "diff"
    this.diff = [];
    this.mark = null;
    this.stale = false; // the file changed on disk while you had unsaved edits
    if (this.tree) this.showTree(cx);
    if (props()?.file) this.show(props().file, cx);
    this.watch(cx);
  }

  async close() { this.closed = true; }

  showTree(cx) {
    this.load("", cx);
    cx.spawn(async (cx) => { this.marks = await statusUnder(this.root); cx.notify(); });
  }

  load(rel, cx) {
    if (this.entries.has(rel)) return;
    this.entries.set(rel, null);
    cx.spawn(async (cx) => {
      try { this.entries.set(rel, await directory(rel ? join(this.root, rel) : this.root)); }
      catch (e) { this.entries.set(rel, []); this.error = String(e.message ?? e); }
      cx.notify();
    });
  }

  editor(text, rel) {
    const t = theme(), ext = rel.includes(".") ? rel.split(".").pop().toLowerCase() : "txt";
    this.code?.release();
    this.code = EditorState.new({ language: LANG[ext] ?? ext, value: text, font_family: settings().font_family, font_size: 12.5,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
    this.code.on("change", (_e, cx) => cx.notify());
  }

  // Opens a file: its text, then its git changes. A changed file opens on the diff.
  show(rel, cx) {
    this.code?.release(); this.code = null; this.file = rel; this.original = null; this.fileError = null;
    this.stale = false; this.diff = []; this.mark = null; this.mode = "file";
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(join(this.root, rel));
        if (this.file !== rel) return;
        if (text === null) { this.fileError = "This file is no longer there."; return; }
        if (text.includes("\0")) { this.fileError = "Binary file: no text view."; return; }
        this.original = text;
        this.editor(text, rel);
        remember(this.root, rel);
      } catch { if (this.file === rel) this.fileError = "Cannot open this file (too large or unreadable)."; }
      finally { cx.notify(); }
      await this.refreshChanges(rel, cx, true);
    });
  }

  async refreshChanges(rel, cx, opening) {
    const { mark, diff } = await fileChanges(this.root, rel);
    if (this.file !== rel) return;
    this.mark = mark;
    this.diff = diff ? diffRows(diff) : [];
    if (opening && this.diff.length) this.mode = "diff";
    if (!this.diff.length && this.mode === "diff") this.mode = "file";
    cx.notify();
  }

  // Follows the disk for the open file's folder. Only a change to the open file reloads it; the
  // tree's git marks refresh on any change, if the tree is showing.
  watch(cx) {
    cx.spawn(async (cx) => {
      while (!this.closed) {
        const dir = this.file ? join(this.root, this.file).replace(/\\[^\\]+$/, "") : this.root;
        let batch;
        try { batch = await watchFolder(dir); } catch { return; }
        if (this.closed) return;
        const rel = this.file;
        if (rel) {
          const target = norm(join(this.root, rel));
          if (batch.some((p) => norm(p) === target || norm(p) === norm(dir))) await this.reloadFromDisk(rel, cx);
        }
        if (this.tree) this.marks = await statusUnder(this.root);
        cx.notify();
      }
    });
  }

  async reloadFromDisk(rel, cx) {
    const text = await readTextFile(join(this.root, rel)).catch(() => null);
    if (this.file !== rel || text === null || text === this.original) return;
    if (this.dirty()) { this.stale = true; this.pendingText = text; }
    else { this.original = text; this.code ? this.code.set_value(text) : this.editor(text, rel); }
    await this.refreshChanges(rel, cx, false);
  }

  takeDisk(cx) {
    if (this.pendingText == null) return;
    this.original = this.pendingText; this.pendingText = null; this.stale = false;
    this.code?.set_value(this.original);
    cx.notify();
  }

  myPane() {
    if (this.pane) return this.pane;
    const claimed = shared(TABS) ?? {};
    const f = focused()?.pane;
    if (f && panes().some((p) => p.pane === f && p.mod === "file-view") && !claimed[f]) this.pane = f;
    return this.pane;
  }

  record() {
    const pane = this.myPane();
    if (!pane) return;
    const live = new Set(panes().map((p) => p.pane));
    const next = Object.fromEntries(Object.entries(shared(TABS) ?? {}).filter(([id]) => live.has(id)));
    next[pane] = { root: this.root, file: this.file ?? null, mark: this.mark ?? null };
    if (JSON.stringify(next) !== JSON.stringify(shared(TABS))) setShared(TABS, next);
  }

  dirty() {
    return Boolean(this.code) && this.original !== null && this.code.value() !== this.original;
  }

  save(cx) {
    if (!this.dirty()) return;
    const rel = this.file, text = this.code.value();
    cx.spawn(async (cx) => {
      try {
        await writeTextFile(join(this.root, rel), text, this.original);
        this.original = text; this.stale = false; this.pendingText = null;
        notify({ title: `Saved ${rel.split("/").pop()}`, level: "success", timeout: 2000 });
        await this.refreshChanges(rel, cx, false);
      } catch (e) {
        notify({ title: `Not saved: ${rel.split("/").pop()}`, body: `It changed on disk since you opened it, or it cannot be written. ${e.message ?? e}`, level: "error" });
      }
      cx.notify();
    });
  }

  rows(t, rel, depth, out) {
    const light = isLight(t.background);
    for (const e of this.entries.get(rel) ?? []) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      const expanded = this.open.has(path);
      const mark = this.marks[path];
      const tint = markColor(t, mark);
      out.push(h_flex().id(`fv-${path}`).h(24).flex_none().pl(8 + depth * 14).pr(8).gap(6).items_center().rounded(6).text_size(12.5)
        .cursor_pointer().when(this.file === path, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (e.dir) { expanded ? this.open.delete(path) : (this.open.add(path), this.load(path, cx)); cx.notify(); }
          else if (this.file !== path) this.show(path, cx);
        })
        .child(e.dir ? svg(`mods/files/${expanded ? "chevron-down" : "chevron-right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(image(e.dir ? folderIcon(e.name, expanded, light) : fileIcon(e.name, light)).w(15).h(15).flex_none())
        .child(div().flex_1().min_w(0).truncate().text_color(tint ?? (e.dir ? t.foreground : t.muted)).child(e.name))
        .when(Boolean(mark), (el) => el.child(e.dir ? div().size(6).flex_none().rounded(3).bg(tint)
          : div().flex_none().text_size(11).font_semibold().text_color(tint).child(mark))));
      if (e.dir && expanded) this.rows(t, path, depth + 1, out);
    }
    return out;
  }

  diffView(t) {
    const font = settings().font_family;
    const bg = { add: t.ansi2 + "24", del: t.ansi1 + "24", hunk: t.surface };
    const num = (n) => div().w(40).flex_none().text_right().pr(6).text_color(t.dim).child(n == null ? "" : String(n));
    return v_flex().id("fv-diff").size_full().min_h(0).overflow_y_scrollbar().py(4).font_family(font).text_size(12)
      .children(this.diff.map((r, i) => h_flex().id(`d-${i}`).flex_none().min_h(19).items_center().when(Boolean(bg[r.kind]), (el) => el.bg(bg[r.kind]))
        .when(r.kind === "hunk" || r.kind === "more", (el) => el.px(10).text_color(t.dim).child(r.text))
        .when(r.kind !== "hunk" && r.kind !== "more", (el) => el
          .child(num(r.a)).child(num(r.b))
          .child(div().w(16).flex_none().text_color(r.kind === "add" ? t.ansi2 : r.kind === "del" ? t.ansi1 : t.dim).child(r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_color(t.foreground).child(r.text || " ")))));
  }

  render(cx) {
    const t = theme();
    const dirty = this.dirty();
    this.record();
    const tint = markColor(t, this.mark);
    const adds = this.diff.filter((r) => r.kind === "add").length, dels = this.diff.filter((r) => r.kind === "del").length;
    const seg = (id, label, on, action) => div().id(id).px(9).h(22).flex().items_center().rounded(5).cursor_pointer()
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { action(); cx.notify(); }).child(label);
    return h_flex().id("file-view").track_focus(this.handle).size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.keystroke === "cmd-s" || e.keystroke === "ctrl-s") { this.save(cx); cx.stop_propagation(); }
      })
      .when(this.tree, (el) => el.child(v_flex().id("fv-tree").w(260).flex_none().h_full().min_h(0).border_r(1).border_color(t.border)
        .child(div().px(12).h(34).flex_none().flex().items_center().truncate().text_size(11.5).font_medium().text_color(t.dim).child(this.root))
        .child(v_flex().id("fv-rows").flex_1().min_h(0).px(4).pb(6).overflow_y_scrollbar().children(this.rows(t, "", 0, [])))))
      .child(v_flex().flex_1().min_w(0).h_full().min_h(0)
        .child(h_flex().px(12).h(34).flex_none().gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
          .child(div().id("fv-tree-toggle").p(3).rounded(5).flex_none().text_color(t.dim).cursor_pointer()
            .tooltip(this.tree ? "Hide folder" : "Show folder").hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { this.tree = !this.tree; if (this.tree) this.showTree(cx); cx.notify(); })
            .child(svg("mods/workspace-chrome/panel-left.svg").size(13)))
          .when(Boolean(this.file), (el) => el.child(image(fileIcon(this.file, isLight(t.background))).w(14).h(14).flex_none()))
          .child(div().flex_1().min_w(0).truncate().text_color(tint ?? (this.file ? t.foreground : t.dim)).child(this.file ?? "Pick a file"))
          .when(Boolean(this.mark), (el) => el.child(div().flex_none().font_semibold().text_color(tint).tooltip("Git status").child(this.mark)))
          .when(this.diff.length > 0, (el) => el.child(h_flex().gap(2).p(2).rounded(7).border_1().border_color(t.border)
            .child(seg("fv-mode-file", "File", this.mode === "file", () => { this.mode = "file"; }))
            .child(seg("fv-mode-diff", `Changes +${adds} −${dels}`, this.mode === "diff", () => { this.mode = "diff"; }))))
          .when(dirty, (el) => el.child(div().text_color(t.dim).child("unsaved"))
            .child(div().id("fv-save").px(10).h(24).flex().items_center().rounded(6).bg(t.solid).text_color(t.solid_foreground)
              .cursor_pointer().on_click((_e, cx) => this.save(cx)).child("Save  ctrl-s"))))
        .when(this.stale, (el) => el.child(h_flex().px(12).h(30).flex_none().gap(8).items_center().bg(t.working + "22").text_size(12)
          .child(div().flex_1().text_color(t.foreground).child("This file changed on disk. Your unsaved edits are kept."))
          .child(div().id("fv-take").px(9).h(22).flex().items_center().rounded(5).border_1().border_color(t.input).cursor_pointer()
            .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.takeDisk(cx)).child("Load the disk version"))))
        .child(div().flex_1().min_h(0)
          .when(this.mode === "diff" && this.diff.length > 0, (el) => el.child(this.diffView(t)))
          .when(this.mode !== "diff" && Boolean(this.code), (el) => el.child(Editor.new(this.code).size_full()))
          .when(this.mode !== "diff" && !this.code, (el) => el.child(div().p(14).text_size(12.5).text_color(t.dim).child(this.fileError ?? (this.file ? "Loading…" : "Choose a file on the left."))))));
  }
}
