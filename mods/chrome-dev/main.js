import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout, exec, appHome, openOverlay, closeOverlay, notify } from "herdr";

// A copy of the shipped workspace-chrome (Herdr rewrites shipped mods), whose Settings opens a menu:
// our own switches, then Herdr's Settings window, which mods cannot add rows to.
const HIBERNATE = () => `${appHome()}/claude/hibernate.mjs`;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

export default class WorkspaceChrome extends View {
  button(id, label, action) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }
  init(_props, cx) {
    if (!props()?.settingsMenu) return;
    this.sleepOff = null;
    cx.spawn(async (cx) => {
      const r = await exec("node", [HIBERNATE(), "status"]).catch(() => null);
      if (r?.code === 0) this.sleepOff = JSON.parse(r.stdout).off;
      cx.notify();
    });
  }

  toggleSleep(cx) {
    if (this.sleepOff === null) return;
    const next = this.sleepOff ? "on" : "off";
    cx.spawn(async (cx) => {
      const r = await exec("node", [HIBERNATE(), next]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code === 0) this.sleepOff = JSON.parse(r.stdout).off;
      else notify({ title: `Could not turn sleep ${next}`, body: (r.stderr ?? "").trim().slice(0, 200), level: "error" });
      cx.notify();
    });
  }

  settingsMenu(t) {
    const on = this.sleepOff === false;
    const knob = div().w(28).h(16).flex_none().rounded_full().p(2).flex().items_center()
      .bg(on ? t.accent : t.raised).when(on, (el) => el.justify_end())
      .child(div().size(12).rounded_full().bg(t.foreground));
    const item = (id) => h_flex().id(id).h(30).px(8).gap(9).items_center().rounded(6).cursor_pointer()
      .text_color(t.foreground).hover((s) => s.bg(t.hover));
    return v_flex().size_full().p(4).gap(2).bg(t.surface).text_size(13)
      .child(item("sleep").tooltip("Idle Claude panes exit after 30 min (5 min under 3 GB free) and resume when you select them.")
        .on_click((_e, cx) => this.toggleSleep(cx))
        .child(div().flex_1().child("Sleep idle Claude panes"))
        .child(this.sleepOff === null ? div().text_color(t.dim).child("…") : knob))
      .child(div().h(1).mx(4).bg(t.border))
      .child(item("all").on_click(() => { closeOverlay(props().overlay); run("app.settings"); })
        .child(svg("mods/chrome-dev/settings.svg").size(14).text_color(t.muted)).child("All settings…"));
  }

  render() {
    const t = theme();
    if (props()?.settingsMenu) return this.settingsMenu(t);
    const collapsed = narrow();
    if (props()?.footer) {
      const row = (id, icon, label, dim, action) => h_flex().id(id).h(28).px(8).gap(9).items_center().rounded(8)
        .when(collapsed, el => el.relative().w(32).px(0).justify_center().tooltip(label))
        .text_color(dim ? t.dim : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
        .on_click(action).child(svg(`mods/chrome-dev/${icon}.svg`).size(14))
        .when(!collapsed, el => el.child(label));
      const ready = div().size(6).rounded_full().bg(t.accent);
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).pt(4).pb(8).text_size(13)
        .when(collapsed, el => el.px(0).items_center())
        .child(row("settings", "settings", "Settings", false, () => openOverlay({ mod: "chrome-dev", kind: "popup", width: 250, height: 76, props: { settingsMenu: true } }))
          .when(Boolean(updates().app.ready), el => el.child(collapsed ? ready.absolute().top(5).right(6) : ready)))
        .child(row("machine", "plus", "Add machine", true, () => run("mod.open", { name: "machine-add" })));
    }
    return h_flex().size_full().bg(t.chrome).pl(collapsed ? 6 : 14).pr(10).gap(4).items_center().text_size(13.5)
      .when(window()?.platform === "macos" && !window()?.fullscreen && !collapsed, el => el.pl(76))
      .when(!collapsed, el => el.child(h_flex().flex_1().gap(8).items_center().child(image("frame/welcome/herdr.png").size(20).rounded(5)).child(div().font_semibold().text_color(t.foreground).child("Herdr"))))
      .when(!collapsed, el => el.child(this.button("search", svg("mods/chrome-dev/search.svg").size(15), () => run("mod.open", { name: "picker" }))))
      // On the macOS rail the traffic lights fill the row; the agents list's » unfolds it.
      .when(!(collapsed && window()?.platform === "macos"), el => el.child(this.button("sidebar-toggle", svg("mods/chrome-dev/sidebar.svg").size(15), toggleSidebar)));
  }
}
