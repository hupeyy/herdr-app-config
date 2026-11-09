// Workspace dialogs. Four modes, from props:
//   (none)            New workspace: a root (folder, name, color, icon) and its first dev workspace
//   { editRoot: id }  Edit workspace: a root's name, folder, color, icon
//   { newDev: id }    New dev workspace in that root: name, folder, color, icon, what it starts with
//   { edit: spaceId } Edit dev workspace: name, Poké Ball, Pokémon
// A dev workspace is a herdr space. space.new returns no id, so a new one's color, icon and root
// wait in shared("space.pending"), which the root strip (space-tabs) applies once it appears.

import { View, div, svg, image } from "gpui-kit";
import { NAMES, nameOf, dexNo, iconBox } from "./pokemon-names.js";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { spaces, focused, run, theme, home, appHome, props, closeOverlay, shared, setShared, pickFolder, knownAgents, readTextFile, exec } from "herdr";

// The same tile colors the Spaces list used, stored by name.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const ICONS = ["folder", "terminal", "server", "layers", "git-branch", "monitor", "files", "clock", "archive", "square-pen", "settings", "search", "jira", "github"];
// "jira" and "github" are the brand marks (Simple Icons, CC0); the rest come from workspace-chrome.
const BRAND = { jira: "mods/file-icons/brand/jira.svg", github: "mods/file-icons/brand/github.svg" };
const ICON = (name) => BRAND[name] ?? `mods/workspace-chrome/${name}.svg`;
const basename = (path) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
const roots = () => shared("roots") ?? [];
// A dev workspace's Pokémon (space-panel draws it; icons downloaded there on first use).
const POKEMON = "space.pokemon";
const POKEMON_ICON = (n) => `data/pokemon-icons/${n}.png`;
// SpriteCollab Normal portraits (portraits.mjs), 40x40.
const PORTRAIT_DIR = "data/pokemon-portraits";
const PORTRAIT = (n) => `${PORTRAIT_DIR}/${n}.png`;
const PORTRAIT_PX = 40;
const POKE_SHOWN = 240;
// A dev workspace's Poké Ball. space-panel picks one at random and draws every design's frames;
// BALL_VERSION and BALLS must match its own.
const BALL_PICK = "space.balls";
// Update sprites: the refresh time this sets and the progress space-panel reports (its loadSprites).
const SPRITE_REFRESH = "sprites.refresh";
const SPRITE_PROGRESS = "sprites.progress";
const BALL_VERSION = "23";
// #2 is left out: it is the classic ball again.
const BALLS = ["classic", ...Array.from({ length: 26 }, (_, i) => `d${String(i + 1).padStart(2, "0")}`).filter((d) => d !== "d02")];
// The closed ball at 3x (pokeball-anim.ps1's pick.png), shown at its own size so it stays sharp:
// 36 px for the classic 12-pixel ball, 30 for the 10-pixel designs.
const BALL_PICK_IMG = (d) => `data/pokemon-icons/pokeball-v${BALL_VERSION}-${d}-pick.png`;
const ballImage = (d) => { const px = d === "classic" ? 36 : 30; return image(BALL_PICK_IMG(d)).w(px).h(px); };
const BALL_NAMES = {
  classic: "Poké Ball", d01: "Dive Ball", d03: "Great Ball", d04: "Ultra Ball", d05: "Master Ball", d06: "Safari Ball",
  d07: "Level Ball", d08: "Quick Ball", d09: "Luxury Ball", d10: "Lure Ball", d11: "Moon Ball", d12: "Friend Ball",
  d13: "Love Ball", d14: "Heavy Ball", d15: "Fast Ball", d16: "Dusk Ball", d17: "Heal Ball", d18: "Sport Ball",
  d19: "Premier Ball", d20: "Repeat Ball", d21: "Timer Ball", d22: "Nest Ball", d23: "Net Ball", d24: "Cherish Ball",
  d25: "Park Ball", d26: "Dream Ball",
};
const ballLabel = (d) => BALL_NAMES[d] ?? d;

export default class WorkspaceDialog extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.mode = p.editRoot ? "editRoot" : p.newDev ? "newDev" : p.edit ? "edit" : "newRoot";
    this.root = roots().find((r) => r.id === (p.editRoot ?? p.newDev)) ?? null;
    this.space = p.edit ? spaces().find((s) => s.id === p.edit) ?? null : null;
    this.handle = cx.focus_handle();

    const startFolder = this.mode === "newDev" ? this.root?.folder : this.mode === "editRoot" ? this.root?.folder : focused()?.cwd ?? `${home()}\\Desktop\\dev`;
    this.folder = InputState.new({ value: startFolder ?? "", placeholder: "C:\\path\\to\\folder" });
    this.name = InputState.new({ placeholder: this.mode === "newDev" ? "Name it (a ticket key, a task…)" : "Leave empty to name it after the folder" });
    this.task = TextareaState.new({ placeholder: "Optional first message for the agent", rows: 3 });
    for (const input of [this.folder, this.name]) {
      input.on("change", (_e, cx) => cx.notify());
      input.on("submit", (_e, cx) => this.submit(cx));
    }
    this.color = "ansi6";
    this.icon = null; // null: the name's first letter
    if (this.root && this.mode === "editRoot") {
      this.name.set_value(this.root.name);
      this.color = this.root.color ?? "ansi6";
      this.icon = this.root.icon ?? null;
    }
    if (this.space) {
      // An unnamed space shows herdr's folder name; keep the field empty so saving keeps that.
      if (this.space.named) this.name.set_value(this.space.name);
      this.color = (shared("space.colors") ?? {})[this.space.id] ?? "ansi6";
      this.icon = (shared("space.icons") ?? {})[this.space.id] ?? null;
      this.pokemon = (shared(POKEMON) ?? {})[this.space.id] ?? null;
      this.ball = (shared(BALL_PICK) ?? {})[this.space.id] ?? "classic";
      this.pokeSearch = InputState.new({ placeholder: "Search by name or number" });
      this.pokeSearch.on("change", (_e, cx) => cx.notify());
      // The picker shows SpriteCollab portraits once every one is on disk (portraits.mjs); until
      // then, the menu icons.
      this.portraits = false;
      cx.spawn(async (cx) => {
        if (!(await readTextFile(`${appHome()}/${PORTRAIT_DIR}/ready`).catch(() => null))) {
          await exec("node", [`${appHome()}/mods/space-new/portraits.mjs`]).catch(() => null);
        }
        this.portraits = Boolean(await readTextFile(`${appHome()}/${PORTRAIT_DIR}/ready`).catch(() => null));
        cx.notify();
      });
    }
    this.start = null; // null: a shell; else an agent from knownAgents()
    this.agents = [];
    this.recent = [];
    this.error = "";
    this.name.focus();
    cx.spawn(async (cx) => {
      try { this.agents = (await knownAgents()).filter((a) => a.installed); } catch {}
      try {
        const view = JSON.parse((await readTextFile(`${appHome()}/view.json`)) ?? "{}");
        const fromView = (view.recent ?? []).map((r) => r.folder).filter(Boolean);
        this.recent = [...new Set([...(this.root ? [this.root.folder] : []), ...fromView, ...roots().map((r) => r.folder), `${home()}\\Desktop\\dev`])].slice(0, 8);
      } catch {}
      cx.notify();
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  browse(cx) {
    cx.spawn(async (cx) => {
      const folder = await pickFolder({ prompt: "Use this folder" });
      if (folder) { this.folder.set_value(folder); this.error = ""; }
      cx.notify();
    });
  }

  async folderExists(folder) {
    const probe = await exec("cmd", ["/d", "/c", "cd", "/d", folder]).catch(() => ({ code: 1 }));
    return probe.code === 0;
  }

  newSpace(args, root) {
    setShared("space.pending", { before: spaces().map((s) => s.id), color: this.color, icon: this.icon, root, at: Date.now() });
    run("space.new", args);
  }

  submit(cx) {
    const name = this.name.value().trim();
    const folder = this.folder.value().trim();
    if (this.mode === "edit") {
      const s = this.space;
      if (s) {
        // "" gives the space herdr's own name again (after its folder).
        if (name !== (s.named ? s.name : "")) run("space.rename", { id: s.id, name });
        setShared(BALL_PICK, { ...(shared(BALL_PICK) ?? {}), [s.id]: this.ball });
        if (this.pokemon) setShared(POKEMON, { ...(shared(POKEMON) ?? {}), [s.id]: this.pokemon });
      }
      this.close();
      return;
    }
    if (!folder) { this.error = "Pick a folder."; cx.notify(); return; }
    cx.spawn(async (cx) => {
      // A missing folder would only show as a failed terminal; say it here instead.
      if (!(await this.folderExists(folder))) { this.error = `No such folder: ${folder}`; cx.notify(); return; }
      if (this.mode === "editRoot") {
        setShared("roots", roots().map((r) => (r.id === this.root.id ? { ...r, name: name || basename(folder), folder, color: this.color, icon: this.icon } : r)));
      } else if (this.mode === "newRoot") {
        const id = `r-${Date.now().toString(36)}`;
        setShared("roots", [...roots(), { id, name: name || basename(folder), folder, color: this.color, icon: this.icon }]);
        // A root shows through its dev workspaces, so it starts with one.
        this.newSpace({ folder, name: "main" }, id);
      } else {
        const args = { folder, ...(name ? { name, tab: name } : {}) };
        const task = this.task.value().trim();
        if (this.start) Object.assign(args, { argv: this.start.run, ...(task ? { task } : {}) });
        this.newSpace(args, this.root?.id ?? null);
      }
      this.close();
    });
  }

  // Edit mode: the dev workspace's Pokémon, a Random pick, and a searchable grid of every one.
  // The grid draws at most POKE_SHOWN matches; the search finds the rest.
  pokemonSection(t) {
    const q = this.pokeSearch.value().trim().toLowerCase();
    const matches = NAMES.map((label, i) => ({ id: i + 1, label }))
      .filter((x) => !q || x.label.toLowerCase().includes(q) || String(x.id) === q.replace(/^#?0*/, ""));
    const shown = matches.slice(0, POKE_SHOWN);
    // A portrait at its own 40 px (scaling pixel art blurs it), else the menu icon.
    const icon = (n, height) => {
      if (this.portraits) return image(PORTRAIT(n)).w(PORTRAIT_PX).h(PORTRAIT_PX).rounded(4);
      const b = iconBox(n, height);
      return image(POKEMON_ICON(n)).w(b.w).h(b.h);
    };
    const random = () => {
      const taken = new Set(Object.entries(shared(POKEMON) ?? {}).filter(([id]) => id !== this.space?.id).map(([, n]) => n));
      const free = NAMES.map((_, i) => i + 1).filter((n) => !taken.has(n) && n !== this.pokemon);
      this.pokemon = free[Math.floor(Math.random() * free.length)] ?? this.pokemon;
    };
    return v_flex().gap(8)
      .child(h_flex().gap(10).items_center()
        .when(Boolean(this.pokemon), (el) => el.child(icon(this.pokemon, 30)))
        .child(div().flex_1().text_color(t.foreground).child(this.pokemon ? `${dexNo(this.pokemon)} ${nameOf(this.pokemon)}` : "None yet"))
        .child(this.chip(t, "poke-random", "Random", false, random)))
      .child(h_flex().child(this.field(t, this.pokeSearch)))
      .child(div().id("poke-grid").h(this.portraits ? 230 : 180).overflow_y_scrollbar().rounded(7).border_1().border_color(t.border).p(4)
        .child(h_flex().flex_wrap().gap(2)
          .children(shown.map((x) => div().id(`poke-${x.id}`).w(this.portraits ? 48 : 46).h(this.portraits ? 48 : 36).flex().items_center().justify_center().rounded(6)
            .cursor_pointer().tooltip(`${dexNo(x.id)} ${x.label}`)
            .when(x.id === this.pokemon, (el) => el.bg(t.selected).border_1().border_color(t.accent))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.pokemon = x.id; cx.notify(); })
            .child(icon(x.id, 30)))))
        .when(matches.length > shown.length, (el) => el.child(div().pt(4).text_size(11).text_color(t.dim)
          .child(`Showing ${shown.length} of ${matches.length}: search to find the rest.`))));
  }

  // Edit mode: the dev workspace's Poké Ball, from every design's still frame (drawn 2x).
  ballSection(t) {
    return h_flex().flex_wrap().gap(4).role("list_box").accessibility_label("Poké Ball")
      .children(BALLS.map((d, i) => div().id(`ball-${d}`).w(44).h(44).flex().items_center()
      .justify_center().rounded(7).cursor_pointer().tooltip(ballLabel(d))
      .role("list_box_option").accessibility_label(ballLabel(d)).aria_selected(d === this.ball).set_position(i + 1, BALLS.length)
      .border_1().border_color(d === this.ball ? t.accent : t.border).bg(d === this.ball ? t.selected : t.surface)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.ball = d; cx.notify(); })
      .child(ballImage(d))));
  }

  // Update sprites: space-panel fetches every card's sprite again from SpriteCollab (new and
  // revised sprites; a gap that has since been drawn), and reports back in SPRITE_PROGRESS.
  spriteUpdate(t, button) {
    const since = shared(SPRITE_REFRESH) ?? 0;
    const p = shared(SPRITE_PROGRESS);
    const mine = Boolean(since) && p?.since === since;
    const running = Boolean(since) && (!mine || p.done < p.total);
    const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
    const status = !since ? "Fetches every card's Pokémon again, so new and revised SpriteCollab sprites show."
      : running ? `Updating from SpriteCollab… ${mine ? `${p.done} of ${p.total}` : ""}`
      : `Updated ${p.total} sprite${p.total === 1 ? "" : "s"} ${ago(since)}${p.failed ? ` · ${p.failed} could not be fetched, retrying in 5 min` : ""}`;
    return h_flex().gap(10).items_center()
      .child(running
        ? h_flex().h(32).px(14).items_center().rounded(8).text_size(12.5).border_1().border_color(t.input).bg(t.surface).text_color(t.dim).child("Update sprites")
        : button("update-sprites", "Update sprites", (cx) => { setShared(SPRITE_REFRESH, Date.now()); cx.notify(); }, false))
      .child(div().flex_1().min_w(0).text_size(11.5).text_color(p?.failed && !running ? t.blocked : t.dim).child(status));
  }

  section(t, label, child) {
    return v_flex().gap(6).child(div().text_size(11.5).font_medium().text_color(t.dim).child(label)).child(child);
  }

  field(t, input) {
    return h_flex().flex_1().h(32).px(10).items_center().rounded(7).border_1().border_color(t.input).bg(t.background)
      .child(Input.new(input).flex_1().h_full().text_size(12.5).text_color(t.foreground));
  }

  chip(t, id, label, on, onClick, extra) {
    return h_flex().id(id).h(28).px(10).gap(6).flex_none().items_center().rounded(7).text_size(12)
      .border_1().border_color(on ? t.accent : t.border).bg(on ? t.selected : t.surface)
      .text_color(on ? t.foreground : t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { onClick(cx); cx.notify(); })
      .when(Boolean(extra), (el) => el.child(extra))
      .child(label);
  }

  render(_cx) {
    const t = theme();
    const fill = MARK[this.color] ?? t[this.color];
    const typed = this.name.value().trim();
    const fallback = this.mode === "edit" ? (this.space && !this.space.named ? this.space.name : "") : basename(this.folder.value().trim());
    const label = typed || fallback || "Workspace";
    const titles = { newRoot: "New workspace", editRoot: "Edit workspace", newDev: `New dev workspace in ${this.root?.name ?? "this workspace"}`, edit: "Edit dev workspace" };
    const showFolder = this.mode !== "edit";
    const showStart = this.mode === "newDev";
    const tile = (size, icon) => h_flex().size(size).flex_none().rounded(Math.round(size / 3.6)).bg(fill).items_center().justify_center()
      .text_size(size * 0.55).font_bold().text_color("#ffffff")
      .child(icon ? svg(ICON(icon)).size(size * 0.6).text_color("#ffffff") : ([...label][0]?.toUpperCase() ?? "?"));
    const button = (id, text, onClick, primary) => h_flex().id(id).h(32).px(14).items_center().rounded(8).text_size(12.5)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.surface)
      .text_color(primary ? t.solid_foreground : t.foreground).cursor_pointer().hover((s) => s.opacity(0.88))
      .on_click((_e, cx) => onClick(cx)).child(text);

    return v_flex().id("workspace-dialog").track_focus(this.handle).size_full().min_h(0).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { this.close(); cx.stop_propagation(); }
      })
      .child(h_flex().px(20).pt(18).pb(12).gap(12).items_center().flex_none().border_b(1).border_color(t.border)
        .child(this.mode === "edit" ? ballImage(this.ball).accessibility_label(ballLabel(this.ball)) : tile(34, this.icon))
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(15).font_semibold().text_color(t.foreground).child(titles[this.mode]))
          .child(div().truncate().text_size(12).text_color(t.dim).child(label)))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(v_flex().id("workspace-dialog-body").flex_1().min_h(0).px(20).py(14).gap(16).overflow_y_scrollbar()
        .child(this.section(t, "Name", h_flex().child(this.field(t, this.name))))
        .when(showFolder, (el) => el.child(this.section(t, this.mode === "newDev" ? "Folder" : "Root folder", v_flex().gap(8)
          .child(h_flex().gap(8).child(this.field(t, this.folder)).child(button("browse", "Browse…", (cx) => this.browse(cx), false)))
          .when(this.recent.length > 0, (el) => el.child(h_flex().gap(6).flex_wrap().children(this.recent.map((f, i) =>
            this.chip(t, `recent-${i}`, basename(f), this.folder.value().trim() === f, () => { this.folder.set_value(f); this.error = ""; }).tooltip(f))))))))
        .when(this.mode === "edit", (el) => el.child(this.section(t, "Poké Ball", this.ballSection(t))))
        .when(this.mode !== "edit", (el) => el.child(this.section(t, "Color", h_flex().gap(8).children(Object.entries(MARK).map(([key, hex]) =>
          div().id(`color-${key}`).size(26).rounded(13).bg(hex).cursor_pointer()
            .border_2().border_color(this.color === key ? t.foreground : t.popover)
            .on_click((_e, cx) => { this.color = key; cx.notify(); })))))
        .child(this.section(t, "Icon", h_flex().gap(6).flex_wrap()
          .child(this.chip(t, "icon-letter", "Letter", this.icon === null, () => { this.icon = null; }))
          .children(ICONS.map((name) => div().id(`icon-${name}`).size(30).flex().items_center().justify_center().rounded(7)
            .border_1().border_color(this.icon === name ? t.accent : t.border).bg(this.icon === name ? t.selected : t.surface)
            .text_color(this.icon === name ? t.foreground : t.muted).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(name)
            .on_click((_e, cx) => { this.icon = name; cx.notify(); })
            .child(svg(ICON(name)).size(15)))))))
        .when(this.mode === "edit" && Boolean(this.pokeSearch), (el) => el.child(this.section(t, "Pokémon", v_flex().gap(10)
          .child(this.pokemonSection(t)).child(this.spriteUpdate(t, button)))))
        .when(showStart, (el) => el.child(this.section(t, "Start with", v_flex().gap(8)
          .child(h_flex().gap(6).flex_wrap()
            .child(this.chip(t, "start-shell", "Shell", this.start === null, () => { this.start = null; }, svg(ICON("terminal")).size(13)))
            .children(this.agents.map((a) => this.chip(t, `start-${a.key}`, a.name, this.start?.key === a.key, () => { this.start = a; }))))
          .when(Boolean(this.start), (el) => el.child(Textarea.new(this.task).w_full().text_size(12.5)))))))
      .child(h_flex().px(20).py(12).gap(8).items_center().flex_none().border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.blocked).child(this.error))
        .child(button("cancel", "Cancel", () => this.close(), false))
        .child(button("submit", this.mode.startsWith("edit") ? "Save" : "Create", (cx) => this.submit(cx), true)));
  }
}
