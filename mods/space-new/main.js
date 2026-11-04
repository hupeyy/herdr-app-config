// Workspace dialogs. Four modes, from props:
//   (none)            New workspace: a root (folder, name, color, icon) and its first dev workspace
//   { editRoot: id }  Edit workspace: a root's name, folder, color, icon
//   { newDev: id }    New dev workspace in that root: name, folder, color, icon, what it starts with
//   { edit: spaceId } Edit dev workspace: name, color, icon
// A dev workspace is a herdr space. space.new returns no id, so a new one's color, icon and root
// wait in shared("space.pending"), which the root strip (space-tabs) applies once it appears.

import { View, div, svg } from "gpui-kit";
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
        setShared("space.colors", { ...(shared("space.colors") ?? {}), [s.id]: this.color });
        const icons = { ...(shared("space.icons") ?? {}) };
        if (this.icon) icons[s.id] = this.icon; else delete icons[s.id];
        setShared("space.icons", icons);
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
        .child(tile(34, this.icon))
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
        .child(this.section(t, "Color", h_flex().gap(8).children(Object.entries(MARK).map(([key, hex]) =>
          div().id(`color-${key}`).size(26).rounded(13).bg(hex).cursor_pointer()
            .border_2().border_color(this.color === key ? t.foreground : t.popover)
            .on_click((_e, cx) => { this.color = key; cx.notify(); })))))
        .child(this.section(t, "Icon", h_flex().gap(6).flex_wrap()
          .child(this.chip(t, "icon-letter", "Letter", this.icon === null, () => { this.icon = null; }))
          .children(ICONS.map((name) => div().id(`icon-${name}`).size(30).flex().items_center().justify_center().rounded(7)
            .border_1().border_color(this.icon === name ? t.accent : t.border).bg(this.icon === name ? t.selected : t.surface)
            .text_color(this.icon === name ? t.foreground : t.muted).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(name)
            .on_click((_e, cx) => { this.icon = name; cx.notify(); })
            .child(svg(ICON(name)).size(15))))))
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
