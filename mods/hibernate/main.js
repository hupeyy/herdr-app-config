// Hibernates idle Claude panes and wakes them in place. The work is claude/hibernate.mjs; this
// always-shown status chip runs its tick every 5 minutes, wakes a hibernated pane when it is
// selected, and shows how many panes sleep. A click hibernates idle panes now.

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, terminals, theme, exec, appHome, notify } from "herdr";

const SCRIPT = () => `${appHome()}/claude/hibernate.mjs`;
const TICK_MS = 5 * 60 * 1000;
const PER_PANE_GB = 1.2; // a Claude session plus its MCP servers (measured 2026-10-21)

const asleep = () => terminals().filter((x) => x.state === "live" && x.labels?.["claude.hibernated"]);

// The panes on screen: every pane of the active tab. The focused one is the one Alex selected.
function onScreen() {
  const tab = spaces().find((s) => s.active)?.tabs?.find((t) => t.active)?.id;
  const list = panes().filter((p) => p.tab === tab && p.terminal);
  return { all: list.map((p) => p.terminal), focused: list.find((p) => p.focused)?.terminal ?? null };
}

export default class Hibernate extends View {
  init(_props, cx) {
    this.running = false;
    this.last = null;
    this.seenFocus = undefined; // the first look only records, so a restart wakes nothing
    this.waking = new Set();
    cx.timer.every(TICK_MS, (cx) => this.tick(cx));
    cx.timer.every(1000, (cx) => this.watchFocus(cx));
  }

  tick(cx) {
    if (this.running) return;
    this.running = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("node", [SCRIPT(), "tick", "--keep", onScreen().all.join(",") || "-"], { timeout: 240000 });
        this.last = r.code === 0 ? JSON.parse(r.stdout) : { error: r.stderr.trim().slice(0, 200) };
      } catch (e) {
        this.last = { error: String(e.message ?? e) };
      }
      if (this.last?.failed?.length) notify({ title: "Hibernate: some panes did not exit", body: this.last.failed.join(", "), level: "warning" });
      this.running = false;
      cx.notify();
    });
  }

  watchFocus(cx) {
    const { focused } = onScreen();
    if (focused === this.seenFocus) return;
    const first = this.seenFocus === undefined;
    this.seenFocus = focused;
    if (first || !focused || this.waking.has(focused)) return;
    if (!terminals().find((x) => x.address === focused)?.labels?.["claude.hibernated"]) return;
    this.waking.add(focused);
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("node", [SCRIPT(), "wake", focused], { timeout: 120000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      const out = r.code === 0 ? JSON.parse(r.stdout) : null;
      if (!out?.awake) notify({ title: `Could not wake ${focused}`, body: out?.note ?? r.stderr?.trim().slice(0, 200) ?? "", level: "error" });
      this.waking.delete(focused);
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const n = asleep().length;
    const last = this.last;
    const tip = [
      n ? `${n} Claude pane${n === 1 ? "" : "s"} hibernated (about ${(n * PER_PANE_GB).toFixed(1)} GB freed). Select one to wake it.` : "No Claude pane is hibernated.",
      last?.error ? `Last run failed: ${last.error}` : last ? `Last run: ${last.hibernated.length} hibernated, ${last.freeGbAfter} GB free.` : "",
      "Click to hibernate idle panes now.",
    ].filter(Boolean).join("\n");
    return h_flex().id("hibernate").size_full().px(10).gap(6).items_center().justify_end()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(n ? t.muted : t.dim)
      .cursor_pointer().hover((s) => s.text_color(t.foreground))
      .tooltip(tip)
      .on_click((_e, cx) => this.tick(cx))
      .child(svg("mods/hibernate/moon.svg").size(12))
      .child(this.running ? "Hibernating…" : this.waking.size ? "Waking…" : `${n} asleep`);
  }
}
