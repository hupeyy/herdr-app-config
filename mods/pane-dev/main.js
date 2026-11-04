// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pane" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.

// pane-dev, a clone of pane: a file tab (mod file-view) shows its file's icon, name and folder,
// read from shared("file.tabs"), in place of the mod's name.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, terminals, props, run, theme, home, shared } from "herdr";
import { fileIcon, isLight } from "./file-icons/icons.js";

// Claude started from a shell reports itself (OSC 7501) only while it works, so its pane shows
// the shell. The herdr-resume hook labels the terminal claude.session from start to exit.
const CLAUDE = { key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: false, tile: null, color: null, shell: false, agent: true };
function withClaude(p) {
  if (!p?.program?.shell || !p.terminal) return p;
  const term = terminals().find((x) => x.address === p.terminal);
  return term?.labels?.["claude.session"] ? { ...p, program: CLAUDE } : p;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class Pane extends View {
  init() { this.hovered = false; }

  me() {
    return withClaude(panes().find((p) => p.pane === props()?.pane));
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane-dev/${icon}.svg`).size(14));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const fileTab = p.mod === "file-view" ? (shared("file.tabs") ?? {})[p.pane] : null;
    const file = fileTab?.file ?? null;
    const name = file ? file.split("/").pop()
      : p.mod === "file-view" ? "Files"
      : ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const where = fileTab ? [fileTab.root, ...(file ?? "").split("/").slice(0, -1)].join("\\") : p.cwd;
    const pic = file ? image(fileIcon(file, isLight(t.background))).w(14).h(14).flex_none()
      : p.mod === "file-view" ? svg("mods/workspace-chrome/files.svg").size(14).flex_none().text_color(t.dim)
      : icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(where)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
