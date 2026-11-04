// Resource Manager, like Orca's: what each dev workspace's terminals cost (CPU, working set,
// private memory), with Herdr's own processes as their own group, and a PTYs tab that lists every
// live terminal (hidden ones too) with a kill button. Opened as a popup from the status bar chip
// (status-usage). A terminal's cost is its whole process tree: shell, agent, dev servers.
// snapshot.mjs takes the numbers; two snapshots give CPU %.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, terminals, exec, home, theme, closeOverlay, props, shared, setShared, run, readTextFile } from "herdr";

const EVERY_MS = 3000; // while the panel is open
const CACHE = "resources.snapshot"; // { snap, prev }, shared with the status bar chip
const STALE_MS = 20000;
const SORT = "resources.sort"; // { key: "name" | "cpu" | "ws", desc }
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const SCRIPT = () => `${home()}/.config/herdr-app/mods/resources/snapshot.mjs`;

export const gb = (bytes) => (bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(2)} GB` : `${(bytes / 2 ** 20).toFixed(1)} MB`);
const pct = (x) => `${x.toFixed(1)}%`;
const TICKET_KEYS = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]+-\d+/gi;
const IDLE_MS = 2 * 60 * 60 * 1000; // idle longer than this is a reason to clean up
const age = (ms) => { const h = Math.floor(ms / 3600000); return h >= 24 ? `${Math.floor(h / 24)}d` : h >= 1 ? `${h}h` : `${Math.floor(ms / 60000)}m`; };

// The live terminals as snapshot.mjs roots.
export const rootsOf = (list) => list.filter((x) => x.state === "live" && x.pid).map((x) => ({ a: x.address, p: x.pid }));

export async function snapshot(list) {
  const r = await exec("node", [SCRIPT(), JSON.stringify(rootsOf(list))]);
  if (r.code !== 0) throw new Error(r.stderr.trim().slice(0, 200) || `snapshot exited ${r.code}`);
  return JSON.parse(r.stdout);
}

export default class Resources extends View {
  init(_props, cx) {
    this.tab = "resources";
    this.open = new Map(); // group id -> expanded
    this.snap = null;
    this.prev = null;
    this.error = null;
    this.busy = false;
    this.confirm = null; // terminal address whose kill button was pressed once
    this.view = "main"; // or "cleanup"
    this.picked = new Set(); // dev workspaces ticked in the clean-up list
    this.closeArmed = false;
    // Open on the cache the status bar chip keeps (status-usage measures every 20 s); measure at
    // once only when it is missing or older than that.
    const cached = shared(CACHE);
    if (cached?.snap) { this.snap = cached.snap; this.prev = cached.prev; }
    if (!cached?.snap || Date.now() - cached.snap.at > STALE_MS) this.refresh(cx);
    cx.timer.every(EVERY_MS, (cx) => this.refresh(cx));
    this.disk = null; // disk.mjs results (~/.cache/herdr-app/disk.json)
    this.diskOpen = new Set(); // worktrees expanded in Review
    this.loadDisk(cx);
    // A scan writes its progress as it goes: follow it while one runs.
    cx.timer.every(1500, (cx) => { if (this.disk?.running || this.diskStarting) this.loadDisk(cx); });
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const next = await snapshot(terminals());
        this.prev = this.snap;
        this.snap = next;
        this.error = null;
        setShared(CACHE, { snap: next, prev: this.prev });
      } catch (e) { this.error = String(e.message ?? e); }
      this.busy = false;
      cx.notify();
    });
  }

  // CPU % of one sum since the previous snapshot, across all cores.
  cpu(key, sum) {
    const before = key === "herdr" ? this.prev?.herdr : this.prev?.roots?.[key];
    if (!before || !this.prev) return 0;
    const span = (this.snap.at - this.prev.at) * 10000 * this.snap.cores;
    return span > 0 ? Math.max(0, ((sum.cpu - before.cpu) / span) * 100) : 0;
  }

  // Dev workspaces with their sessions, then Herdr. A Claude session (labelled by the herdr-resume
  // hook) is named by its own title without the spinner glyph; others by their tab's name.
  groups() {
    const s = this.snap;
    const allPanes = panes();
    const live = terminals().filter((x) => s.roots[x.address]);
    const tabName = new Map(spaces().flatMap((sp) => sp.tabs.map((tab) => [tab.id, tab.name])));
    const row = (x) => {
      const sum = s.roots[x.address];
      const pane = allPanes.find((p) => p.terminal === x.address);
      const claude = Boolean(x.labels?.["claude.session"]);
      const title = String(x.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
      const name = (claude && title) || (pane && tabName.get(pane.tab)) || title || x.name || x.address;
      return { id: x.address, name, claude, hidden: !pane, sum, cpu: this.cpu(x.address, sum) };
    };
    const groups = spaces().map((sp) => {
      const items = live.filter((x) => x.labels?.["herdr.space"] === sp.id).map(row);
      return { id: sp.id, name: sp.name, items };
    }).filter((g) => g.items.length);
    const known = new Set(groups.flatMap((g) => g.items.map((i) => i.id)));
    const other = live.filter((x) => !known.has(x.address)).map(row);
    if (other.length) groups.push({ id: "other", name: "Other terminals", items: other });
    for (const g of groups) {
      g.sum = g.items.reduce((acc, i) => ({ ws: acc.ws + i.sum.ws, priv: acc.priv + i.sum.priv }), { ws: 0, priv: 0 });
      g.cpu = g.items.reduce((acc, i) => acc + i.cpu, 0);
    }
    for (const g of groups) g.items = this.sorted(g.items);
    // Herdr's own row stays last, whatever the sort.
    return [...this.sorted(groups), { id: "herdr", name: "HERDR", items: [], sum: s.herdr, cpu: this.cpu("herdr", s.herdr) }];
  }

  // Rows by the clicked column (shared "resources.sort", so a reopened panel keeps it).
  sortBy() {
    return shared(SORT) ?? { key: "ws", desc: true };
  }

  sorted(rows) {
    const { key, desc } = this.sortBy();
    const value = (r) => (key === "name" ? String(r.name ?? "").toLowerCase() : key === "cpu" ? r.cpu ?? 0 : r.sum?.ws ?? 0);
    return [...rows].sort((a, b) => {
      const x = value(a), y = value(b);
      const order = typeof x === "string" ? x.localeCompare(y) : x - y;
      return desc ? -order : order;
    });
  }

  // A column header: click to sort by it, again to reverse. Names start A to Z, numbers high first.
  header(t, key, label, width, align) {
    const { key: on, desc } = this.sortBy();
    const active = on === key;
    return h_flex().id(`sort-${key}`).gap(3).items_center().cursor_pointer()
      .when(width != null, (el) => el.w(width).flex_none()).when(width == null, (el) => el.flex_1())
      .when(align === "right", (el) => el.justify_end())
      .text_color(active ? t.foreground : t.dim).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { setShared(SORT, { key, desc: active ? !desc : key !== "name" }); cx.notify(); })
      .child(label)
      .when(active, (el) => el.child(div().text_size(10).child(desc ? "↓" : "↑")));
  }

  bar(t, value) {
    return div().w(48).h(3).flex_none().rounded(2).bg(t.border).overflow_hidden()
      .child(div().h_full().w(Math.round(48 * Math.min(100, value) / 100)).bg(value > 50 ? t.blocked : value > 15 ? t.working : t.accent));
  }

  numbers(t, cpu, ws, bold) {
    return h_flex().flex_none().gap(10).items_center()
      .child(div().w(46).text_right().text_color(t.muted).child(pct(cpu)))
      .child(div().w(70).text_right().text_color(bold ? t.foreground : t.muted).when(bold, (el) => el.font_semibold()).child(gb(ws)));
  }

  resources(t) {
    const groups = this.groups();
    return v_flex().id("res-rows").flex_1().min_h(140).overflow_y_scrollbar()
      .children(groups.flatMap((g) => {
        const open = this.open.get(g.id) ?? true; // sessions show at once, as in Orca
        const head = h_flex().id(`g-${g.id}`).h(34).px(12).gap(8).items_center().border_t(1).border_color(t.border)
          .cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.open.set(g.id, !open); cx.notify(); })
          .child(g.items.length ? svg(ICON(open ? "chevron-down" : "chevron-right")).size(11).flex_none().text_color(t.dim) : div().w(11).flex_none())
          .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(g.name))
          .child(this.bar(t, g.cpu))
          .child(this.numbers(t, g.cpu, g.sum.ws, true));
        if (!open) return [head];
        return [head, ...g.items.map((i) => h_flex().h(28).pl(30).pr(12).gap(8).items_center()
          .child(div().size(6).flex_none().rounded(3).bg(i.hidden ? t.dim : t.done))
          .child(i.claude ? image("icons/claude.svg").w(12).h(12).flex_none() : svg(ICON("terminal")).size(12).flex_none().text_color(t.dim))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).tooltip(i.hidden ? `${i.id}, no pane (hidden)` : i.id).child(i.name))
          .child(this.numbers(t, i.cpu, i.sum.ws, false)))];
      }));
  }

  // Dev workspaces that look finished, with why: their ticket is Done, they have been idle for a
  // while, or nothing in them reports activity. The one you are in, locked ones (space-panel's
  // lock) and ones with a working or blocked agent cannot be picked.
  candidates() {
    const s = this.snap;
    const now = Date.now();
    const locked = shared("space.locked") ?? {};
    const tickets = shared("tasks.snapshot")?.tickets ?? [];
    const work = Object.values(shared("space.work")?.sessions ?? {});
    const stateOf = (x) => (typeof x.status === "string" ? x.status : x.status?.state) ?? null;
    return spaces().map((sp) => {
      const mine = terminals().filter((x) => x.state === "live" && x.labels?.["herdr.space"] === sp.id);
      const ws = mine.reduce((acc, x) => acc + (s?.roots[x.address]?.ws ?? 0), 0);
      const busy = mine.some((x) => ["working", "blocked"].includes(stateOf(x)));
      const last = Math.max(0, ...mine.map((x) => x.status_ms ?? 0));
      const keys = new Set([sp.name, ...sp.tabs.map((x) => x.name)].flatMap((x) => String(x ?? "").match(TICKET_KEYS) ?? []).map((k) => k.toUpperCase()));
      for (const w of work.filter((w) => w.space === sp.id)) for (const k of w.tickets) keys.add(k);
      const done = [...keys].filter((k) => tickets.find((x) => x.key === k)?.category === "done");
      const reasons = [
        ...done.map((k) => `${k} Done`),
        last ? (now - last > IDLE_MS ? `idle ${age(now - last)}` : null) : "no agent activity",
      ].filter(Boolean);
      const blocked = sp.active ? "you are here" : locked[sp.id] ? "locked" : busy ? "agent working" : null;
      return { id: sp.id, name: sp.name, ws, reasons, blocked, terminals: mine.length };
    }).sort((a, b) => Boolean(a.blocked) - Boolean(b.blocked) || b.reasons.length - a.reasons.length);
  }

  cleanup(t) {
    const list = this.candidates();
    const picked = list.filter((c) => !c.blocked && this.picked.has(c.id));
    const close = (_e, cx) => {
      if (!picked.length) return;
      if (!this.closeArmed) { this.closeArmed = true; cx.notify(); return; }
      for (const c of picked) run("space.close", { id: c.id, confirmed: true });
      this.picked.clear();
      this.closeArmed = false;
      this.refresh(cx);
    };
    return v_flex().flex_1().min_h(0)
      .child(div().px(12).py(8).text_size(12).text_color(t.muted)
        .child("Close dev workspaces you are done with. Their terminals and agents end."))
      .child(v_flex().id("cleanup-rows").flex_1().min_h(140).overflow_y_scrollbar()
        .children(list.map((c) => {
          const on = !c.blocked && this.picked.has(c.id);
          return h_flex().id(`clean-${c.id}`).min_h(44).px(12).py(6).gap(10).items_center().border_t(1).border_color(t.border)
            .when(!c.blocked, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => {
              if (on) this.picked.delete(c.id); else this.picked.add(c.id);
              this.closeArmed = false;
              cx.notify();
            }))
            .child(h_flex().size(14).flex_none().items_center().justify_center().rounded(3).border_1()
              .border_color(on ? t.accent : t.input).bg(on ? t.accent : t.popover)
              .when(on, (el) => el.child(svg(ICON("check")).size(10).text_color("#ffffff"))))
            .child(v_flex().flex_1().min_w(0)
              .child(div().truncate().text_color(c.blocked ? t.dim : t.foreground).font_semibold().child(c.name))
              .child(div().truncate().text_size(11).text_color(c.blocked ? t.dim : t.muted)
                .child(c.blocked ? `Kept: ${c.blocked}` : c.reasons.join(" · ") || "active recently")))
            .child(div().flex_none().text_color(t.muted).child(`${gb(c.ws)} · >_ ${c.terminals}`));
        })))
      .child(h_flex().p(12).gap(8).flex_none().border_t(1).border_color(t.border)
        .child(h_flex().id("pick-suggested").h(30).px(10).items_center().rounded(7).border_1().border_color(t.input)
          .cursor_pointer().hover((s) => s.bg(t.hover)).text_color(t.foreground)
          .tooltip("Tick every dev workspace whose ticket is Done or that has been idle")
          .on_click((_e, cx) => {
            for (const c of list) if (!c.blocked && c.reasons.length) this.picked.add(c.id);
            this.closeArmed = false;
            cx.notify();
          })
          .child("Select suggested"))
        .child(div().flex_1())
        .child(h_flex().id("close-picked").h(30).px(12).items_center().rounded(7)
          .bg(picked.length ? t.blocked : t.raised).text_color(picked.length ? "#ffffff" : t.dim)
          .when(picked.length > 0, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)))
          .on_click(close)
          .child(this.closeArmed ? `Click again to close ${picked.length}`
            : `Close ${picked.length} dev workspace${picked.length === 1 ? "" : "s"}`)));
  }

  // ---- Space: disk use of the worktrees the dev workspaces work in ----
  // A dev workspace's worktrees come from its Claude sessions' transcripts (space-panel's
  // scan-work.mjs, shared "space.work"): every session runs in the shared dev folder, so the
  // worktrees it works in are what belongs to it. disk.mjs sizes them in the background.

  worktreesBySpace() {
    const names = new Map(spaces().map((sp) => [sp.id, sp.name]));
    const by = new Map();
    for (const w of Object.values(shared("space.work")?.sessions ?? {})) {
      if (!names.has(w.space)) continue;
      const set = by.get(w.space) ?? new Set();
      for (const p of w.worktrees ?? []) set.add(p);
      by.set(w.space, set);
    }
    return [...by].filter(([, set]) => set.size).map(([id, set]) => ({ id, name: names.get(id), paths: [...set] }));
  }

  loadDisk(cx) {
    cx.spawn(async (cx) => {
      const text = await readTextFile(`${home()}/.cache/herdr-app/disk.json`).catch(() => null);
      try { this.disk = text ? JSON.parse(text) : null; } catch {}
      if (this.disk?.running) this.diskStarting = false;
      cx.notify();
    });
  }

  scanDisk(cx) {
    const paths = [...new Set(this.worktreesBySpace().flatMap((g) => g.paths))];
    if (!paths.length || this.disk?.running) return;
    this.diskStarting = true;
    cx.notify();
    exec("node", [`${home()}/.config/herdr-app/mods/resources/disk.mjs`, "start", JSON.stringify(paths)])
      .then(() => this.loadDisk(cx), () => { this.diskStarting = false; cx.notify(); });
  }

  spaceCard(t) {
    const d = this.disk;
    const paths = [...new Set(this.worktreesBySpace().flatMap((g) => g.paths))];
    const sized = paths.map((p) => d?.folders?.[p]).filter(Boolean);
    const running = d?.running || this.diskStarting;
    const status = running ? `Scanning ${d?.done ?? 0} of ${d?.total ?? paths.length} worktrees…`
      : !paths.length ? "No worktrees found in the dev workspaces yet"
      : !sized.length ? "Worktree disk usage is not scanned"
      : `${gb(sized.reduce((a, f) => a + f.bytes, 0))} in ${sized.length} worktree${sized.length === 1 ? "" : "s"} · scanned ${age(Date.now() - d.at)} ago`;
    const button = (id, label, enabled, onClick, icon) => h_flex().id(id).h(30).px(10).gap(6).items_center().rounded(7).flex_none()
      .border_1().border_color(t.input).text_color(enabled ? t.foreground : t.dim)
      .when(enabled, (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)).on_click(onClick))
      .when(Boolean(icon), (el) => el.child(running && icon === "spinner" ? svg(ICON("spinner")).size(12).spin(900) : svg(ICON(icon)).size(12)))
      .child(label);
    return h_flex().gap(10).items_center()
      .child(svg(ICON("archive")).size(16).flex_none().text_color(t.muted))
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().gap(6).items_center()
          .child(div().font_semibold().text_color(t.foreground).child("Space"))
          .child(div().px(5).rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted).child("Beta")))
        .child(div().truncate().text_size(11.5).text_color(t.muted).child(status)))
      .child(button("disk-scan", "Scan", paths.length > 0 && !running, (_e, cx) => this.scanDisk(cx), running ? "spinner" : "search"))
      .child(button("disk-review", "Review", sized.length > 0, (_e, cx) => { this.view = "disk"; cx.notify(); }));
  }

  diskReview(t) {
    const d = this.disk ?? { folders: {} };
    const groups = this.worktreesBySpace().map((g) => {
      const items = g.paths.map((p) => ({ path: p, ...(d.folders[p] ?? { bytes: 0, files: 0, top: [] }) })).sort((a, b) => b.bytes - a.bytes);
      return { ...g, items, bytes: items.reduce((a, i) => a + i.bytes, 0) };
    }).sort((a, b) => b.bytes - a.bytes);
    const short = (p) => p.split(/[\\/]/).slice(-2).join("/");
    return v_flex().id("disk-rows").flex_1().min_h(140).overflow_y_scrollbar()
      .child(div().px(12).py(8).text_size(12).text_color(t.muted)
        .child("The git worktrees each dev workspace's sessions work in. Linked folders (a borrowed node_modules) are not counted."))
      .children(groups.flatMap((g) => [
        h_flex().h(32).px(12).gap(8).items_center().border_t(1).border_color(t.border)
          .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(g.name))
          .child(div().flex_none().font_semibold().text_color(t.foreground).child(gb(g.bytes))),
        ...g.items.flatMap((i) => {
          const open = this.diskOpen.has(i.path);
          const row = h_flex().id(`wt-${g.id}-${i.path}`).h(30).pl(20).pr(12).gap(8).items_center().cursor_pointer().hover((st) => st.bg(t.hover))
            .on_click((_e, cx) => { if (open) this.diskOpen.delete(i.path); else this.diskOpen.add(i.path); cx.notify(); })
            .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(10).flex_none().text_color(t.dim))
            .child(svg(ICON("git-branch")).size(12).flex_none().text_color(t.muted))
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).tooltip(i.path).child(short(i.path)))
            .child(div().flex_none().text_size(11).text_color(t.dim).child(i.at ? `${i.files.toLocaleString()} files` : "not scanned"))
            .child(div().w(70).flex_none().text_right().text_color(t.muted).child(i.at ? gb(i.bytes) : "—"))
            .child(div().id(`wt-open-${i.path}`).px(6).flex_none().rounded(5).text_size(11.5).text_color(t.dim).cursor_pointer()
              .hover((st) => st.bg(t.raised).text_color(t.foreground)).tooltip("Open in Explorer")
              .on_click((_e, cx) => { cx.stop_propagation(); exec("explorer", [i.path]); })
              .child("Open"));
          if (!open) return [row];
          return [row, ...(i.top ?? []).map((x) => h_flex().h(24).pl(58).pr(12).gap(8).items_center().text_size(11.5)
            .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(x.name))
            .child(div().w(70).flex_none().text_right().text_color(t.dim).child(gb(x.bytes))))];
        }),
      ]));
  }

  ptys(t, cx) {
    const s = this.snap;
    const allPanes = panes();
    const where = new Map(spaces().flatMap((sp) => sp.tabs.map((tab) => [tab.id, `${sp.name} / ${tab.name}`])));
    const rows = terminals().filter((x) => x.state === "live")
      .map((x) => ({ x, name: x.title || x.argv?.[0] || x.address, sum: s.roots[x.address], cpu: s.roots[x.address] ? this.cpu(x.address, s.roots[x.address]) : 0 }));
    const list = this.sorted(rows).map((r) => r.x);
    return v_flex().id("pty-rows").flex_1().min_h(140).overflow_y_scrollbar()
      .children(list.map((x) => {
        const pane = allPanes.find((p) => p.terminal === x.address);
        const sum = s.roots[x.address];
        const armed = this.confirm === x.address;
        return h_flex().id(`pty-${x.address}`).h(40).px(12).gap(8).items_center().border_t(1).border_color(t.border)
          .child(div().w(38).flex_none().font_family("monospace").text_size(11.5).text_color(t.dim).child(x.address))
          .child(v_flex().flex_1().min_w(0)
            .child(div().truncate().text_color(t.foreground).child(x.title || x.argv?.[0] || x.address))
            .child(div().truncate().text_size(11).text_color(t.dim).child(`${pane ? where.get(pane.tab) ?? "" : "hidden, no pane"} · pid ${x.pid}`)))
          .child(div().w(66).flex_none().text_right().text_color(t.muted).child(sum ? gb(sum.ws) : ""))
          .child(div().id(`kill-${x.address}`).px(6).py(2).flex_none().rounded(5).cursor_pointer()
            .text_size(11.5).text_color(armed ? "#ffffff" : t.dim).when(armed, (el) => el.bg(t.blocked))
            .hover((st) => st.bg(armed ? t.blocked : t.hover).text_color(armed ? "#ffffff" : t.blocked))
            .tooltip(armed ? "Click again to end this terminal's program" : "End this terminal")
            .on_click((_e, cx) => {
              if (!armed) { this.confirm = x.address; cx.notify(); return; }
              this.confirm = null;
              exec("hc", ["kill", x.address]).then(() => this.refresh(cx));
            })
            .child(armed ? "Kill?" : "Kill"));
      }));
  }

  render(cx) {
    const t = theme();
    const s = this.snap;
    const tabButton = (id, label, icon) => h_flex().id(`tab-${id}`).h(30).px(6).gap(6).items_center().cursor_pointer()
      .border_b(2).border_color(this.tab === id ? t.foreground : t.popover)
      .text_color(this.tab === id ? t.foreground : t.muted).hover((st) => st.text_color(t.foreground))
      .on_click((_e, cx) => { this.tab = id; this.confirm = null; cx.notify(); })
      .child(svg(ICON(icon)).size(12)).child(label);
    const cpuAll = s ? Object.entries(s.roots).reduce((acc, [k, v]) => acc + this.cpu(k, v), this.cpu("herdr", s.herdr)) : 0;
    // A popup sizes to its content: the chip passes the height it planned for, and this fills it.
    const height = props()?.height;
    return v_flex().id("resource-manager").size_full().min_h(0).when(Boolean(height), (el) => el.h(height)).bg(t.popover).text_size(12.5)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props()?.overlay); cx.stop_propagation(); } })
      .child(h_flex().h(42).px(12).gap(8).flex_none().items_center().border_b(1).border_color(t.border)
        .child(svg(ICON("monitor")).size(14).text_color(t.muted))
        .child(div().flex_1().font_semibold().text_color(t.foreground).child("Resource Manager"))
        .child(h_flex().id("refresh").px(8).h(26).gap(6).items_center().rounded(6).cursor_pointer().text_color(t.foreground)
          .hover((st) => st.bg(t.hover)).on_click((_e, cx) => this.refresh(cx))
          .child("Refresh")
          .child(this.busy ? svg(ICON("spinner")).size(12).text_color(t.muted).spin(900) : div().size(12))))
      .when(this.view !== "main", (el) => el
        .child(h_flex().id("view-back").h(34).px(12).gap(6).flex_none().items_center().border_b(1).border_color(t.border)
          .cursor_pointer().text_color(t.foreground).hover((st) => st.bg(t.hover))
          .on_click((_e, cx) => { this.view = "main"; this.closeArmed = false; cx.notify(); })
          .child(svg(ICON("chevron-left")).size(12))
          .child(div().font_semibold().child(this.view === "disk" ? "Space: worktree disk use" : "Clean up workspaces")))
        .child(this.view === "disk" ? this.diskReview(t) : this.cleanup(t)))
      .when(this.view === "main", (el) => el
      .child(h_flex().px(12).pt(6).gap(14).flex_none().border_b(1).border_color(t.border)
        .child(tabButton("resources", "Resources", "layers"))
        .child(tabButton("ptys", "PTYs", "terminal")))
      .when(Boolean(this.error), (el) => el.child(div().px(12).py(8).text_color(t.blocked).child(this.error)))
      .when(!s && !this.error, (el) => el.child(div().px(12).py(12).text_color(t.dim).child("Measuring…")))
      .when(Boolean(s), (el) => el
        .child(h_flex().px(12).py(10).gap(8).flex_none().items_center().text_color(t.foreground).font_semibold()
          .child(pct(cpuAll)).child(div().text_color(t.dim).child("·"))
          .child(`${gb(s.total.ws)} Σ WS`).child(div().text_color(t.dim).child("·"))
          .child(`${gb(s.total.priv)} Σ Private`))
        .child(h_flex().h(26).px(12).gap(8).flex_none().items_center().text_size(11.5).text_color(t.dim)
          .child(this.header(t, "name", this.tab === "ptys" ? "Terminal" : "Name", null, "left"))
          .when(this.tab === "resources", (el) => el.child(this.header(t, "cpu", "CPU", 46, "right")).child(this.header(t, "ws", "WS", 70, "right")))
          .when(this.tab === "ptys", (el) => el.child(this.header(t, "ws", "WS", 66, "right")).child(div().w(36))))
        .child(this.tab === "ptys" ? this.ptys(t, cx) : this.resources(t)))
      .child(v_flex().p(12).gap(10).flex_none().border_t(1).border_color(t.border)
        .child(this.spaceCard(t))
        .child(h_flex().id("open-cleanup").h(36).px(12).items_center().rounded(8).border_1().border_color(t.border)
          .cursor_pointer().hover((st) => st.bg(t.hover)).text_color(t.foreground)
          .on_click((_e, cx) => { this.view = "cleanup"; this.picked.clear(); this.closeArmed = false; cx.notify(); })
          .child(div().flex_1().text_center().font_semibold().child("Clean up workspaces"))
          .child(svg(ICON("chevron-right")).size(12).text_color(t.muted)))));
  }
}
