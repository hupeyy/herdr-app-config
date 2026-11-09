// Root workspaces as tabs across the top (dev, or any folder). Each root holds dev workspaces,
// which are herdr spaces; the sidebar (space-panel) shows the selected root's dev workspaces.
//
// This mod owns the grouping, so every mod reads one answer:
//   shared("roots")       [{ id, name, folder, color, icon }]
//   shared("space.root")  { spaceId: rootId }, explicit picks kept, the rest by folder
//   shared("root.last")   { rootId: spaceId }, the dev workspace a root shows when you pick it
// The window buttons live here too, so they stay in the top corner.

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, setShared, home, watchFolder, readTextFile, writeTextFile } from "herdr";

const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const PENDING_MS = 30000;
// The "jira" and "github" icon choices are brand marks (Simple Icons, CC0), not workspace-chrome icons.
const BRAND = { jira: "mods/file-icons/brand/jira.svg", github: "mods/file-icons/brand/github.svg" };
const norm = (path) => (path ?? "").replace(/[\\/]+$/, "").toLowerCase();

function roots() {
  const list = shared("roots");
  if (Array.isArray(list) && list.length) return list;
  // First run: one root for the dev folder, which every existing space joins.
  const seed = [{ id: "r-dev", name: "dev", folder: `${home()}\\Desktop\\dev`, color: "ansi6", icon: null }];
  setShared("roots", seed);
  return seed;
}

// The root a space belongs to: an explicit pick, else the root whose folder holds the space's
// folder or a terminal's folder (longest match), else the first root. Nothing is left orphaned.
function assign(list) {
  const explicit = shared("space.root") ?? {};
  const ids = new Set(list.map((r) => r.id));
  const all = panes();
  const next = {};
  for (const s of spaces()) {
    if (ids.has(explicit[s.id])) { next[s.id] = explicit[s.id]; continue; }
    const folders = [s.folder, ...all.filter((p) => s.tabs.some((x) => x.id === p.tab)).map((p) => p.cwd)].map(norm).filter(Boolean);
    const match = list
      .filter((r) => folders.some((f) => f === norm(r.folder) || f.startsWith(`${norm(r.folder)}\\`)))
      .sort((a, b) => b.folder.length - a.folder.length)[0];
    next[s.id] = (match ?? list[0]).id;
  }
  if (JSON.stringify(next) !== JSON.stringify(explicit)) setShared("space.root", next);
  return next;
}

// Dialogs cannot know the id space.new will give, so they leave color, icon and root in
// shared("space.pending"); the first space that was not there before takes them.
function applyPending() {
  const pending = shared("space.pending");
  if (!pending) return;
  const fresh = spaces().find((s) => !pending.before.includes(s.id));
  if (!fresh && Date.now() - pending.at < PENDING_MS) return;
  if (fresh) {
    if (pending.color) setShared("space.colors", { ...(shared("space.colors") ?? {}), [fresh.id]: pending.color });
    if (pending.icon) setShared("space.icons", { ...(shared("space.icons") ?? {}), [fresh.id]: pending.icon });
    if (pending.root) setShared("space.root", { ...(shared("space.root") ?? {}), [fresh.id]: pending.root });
  }
  setShared("space.pending", null);
}

// ---- hx bridge ----
// The hx CLI (~/.config/herdr-app/hx) changes workspaces (roots) through this mod, because only a
// mod can write shared state. hx writes data/hx/req-<id>.json; this applies it and answers in
// res-<id>.json. The answer is first written as a claim (create-only), so a second copy of this
// mod cannot apply the same request twice.
const HX_DIR = () => `${home()}/.config/herdr-app/data/hx`;
const HX_RETRY_MS = 3000;

function hxApply(req) {
  const list = roots();
  const find = (id) => list.find((r) => r.id === id) ?? null;
  switch (req.op) {
    case "root.add": {
      if (!req.name || !req.folder) throw new Error("root.add needs name and folder");
      const id = `r-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      setShared("roots", [...list, { id, name: req.name, folder: req.folder, color: req.color ?? "ansi6", icon: null }]);
      return { id };
    }
    case "root.remove": {
      if (!find(req.id)) throw new Error(`no workspace ${req.id}`);
      if (list.length === 1) throw new Error("the last workspace cannot be removed");
      setShared("roots", list.filter((r) => r.id !== req.id));
      const rootOf = { ...(shared("space.root") ?? {}) };
      for (const [s, r] of Object.entries(rootOf)) if (r === req.id) delete rootOf[s];
      setShared("space.root", rootOf);
      return { id: req.id };
    }
    case "root.update": {
      if (!find(req.id)) throw new Error(`no workspace ${req.id}`);
      const patch = Object.fromEntries(["name", "folder", "color"].filter((k) => req[k] != null).map((k) => [k, req[k]]));
      setShared("roots", list.map((r) => (r.id === req.id ? { ...r, ...patch } : r)));
      return { id: req.id };
    }
    case "space.root": {
      if (!find(req.root)) throw new Error(`no workspace ${req.root}`);
      setShared("space.root", { ...(shared("space.root") ?? {}), [req.space]: req.root });
      return { space: req.space, root: req.root };
    }
    case "space.lock": {
      const locked = { ...(shared("space.locked") ?? {}) };
      if (req.on) locked[req.space] = true; else delete locked[req.space];
      setShared("space.locked", locked);
      return { space: req.space, locked: Boolean(req.on) };
    }
    default: throw new Error(`unknown op ${req.op}`);
  }
}

async function hxHandle(path) {
  const m = path.replace(/\\/g, "/").match(/\/req-([A-Za-z0-9_-]+)\.json$/);
  if (!m) return;
  // The watch also reports the request's deletion (hx removes it once answered): no file, no work.
  const text = await readTextFile(path).catch(() => null);
  if (!text) return;
  const res = `${HX_DIR()}/res-${m[1]}.json`;
  const claim = JSON.stringify({ claimed: Date.now() });
  try { await writeTextFile(res, claim, null); } catch { return; } // answered or claimed already
  let answer;
  try { answer = { ok: true, result: hxApply(JSON.parse(text)) }; }
  catch (e) { answer = { ok: false, error: String(e.message ?? e) }; }
  await writeTextFile(res, JSON.stringify(answer), claim).catch(() => null);
}

export default class RootTabs extends View {
  init(_props, cx) {
    // Until hx first makes data/hx, the watch rejects: try again a little later.
    cx.spawn(async (cx) => {
      for (;;) {
        let paths = null;
        try { paths = await watchFolder(HX_DIR()); } catch { await cx.sleep(HX_RETRY_MS); }
        for (const p of paths ?? []) await hxHandle(p);
      }
    });
  }

  tab(root, t, rootOf, active) {
    const fill = root.color?.startsWith("#") ? root.color : (MARK[root.color] ?? t[root.color] ?? MARK.ansi6);
    const mine = spaces().filter((s) => rootOf[s.id] === root.id);
    const status = mine.reduce((m, s) => ((RANK[s.status] ?? 0) > (RANK[m] ?? 0) ? s.status : m), null);
    const on = root.id === active;
    return h_flex().id(`rt-${root.id}`).h(30).pl(8).pr(10).gap(7).flex_none().items_center().rounded(8).max_w(240).text_size(12.5)
      .when(on, (el) => el.bg(t.selected).text_color(t.foreground))
      .when(!on, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover)))
      .tooltip(`${root.folder}  ·  right-click to edit`)
      .on_click(() => {
        const last = (shared("root.last") ?? {})[root.id];
        const target = mine.find((s) => s.id === last) ?? mine[0];
        if (target) run("space.select", { id: target.id });
        // A root without dev workspaces: make its first one.
        else openOverlay({ mod: "space-new", kind: "dialog", width: 560, height: 620, props: { newDev: root.id } });
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "space-new", kind: "dialog", width: 560, height: 470, props: { editRoot: root.id } });
      })
      .child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center()
        .text_size(10.5).font_bold().text_color("#ffffff")
        .child(root.icon ? svg(BRAND[root.icon] ?? `mods/workspace-chrome/${root.icon}.svg`).size(11).text_color("#ffffff") : ([...root.name][0]?.toUpperCase() ?? "?")))
      .child(div().min_w(0).truncate().child(root.name))
      .when(mine.length > 1, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(String(mine.length))))
      .when(status === "blocked" || status === "done", (el) => el.child(div().flex_none().text_color(t[status]).child("●")))
      .when(status === "working", (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900)));
  }

  render() {
    applyPending();
    const list = roots();
    const rootOf = assign(list);
    const activeSpace = spaces().find((s) => s.active);
    const active = activeSpace ? rootOf[activeSpace.id] : null;
    if (activeSpace && active && (shared("root.last") ?? {})[active] !== activeSpace.id) {
      setShared("root.last", { ...(shared("root.last") ?? {}), [active]: activeSpace.id });
    }
    const t = theme();
    const w = window();
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    return h_flex().id("root-tabs").size_full().min_w(0).px(8).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("root-tabs-scroll").min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar()
        .children(list.map((r) => this.tab(r, t, rootOf, active))))
      .child(button("root-new", svg("mods/workspace-chrome/plus.svg").size(14), () => run("mod.open", { name: "space-new" })).tooltip("New workspace (ctrl-shift-n)"))
      .child(div().flex_1())
      .when(w?.buttons, (el) => el
        .child(button("minimize", w.platform === "windows" ? svg("mods/tabs-tasks/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs-tasks/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs-tasks/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
