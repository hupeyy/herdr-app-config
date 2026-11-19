// Hibernates idle Claude panes and wakes them in place. The work is claude/hibernate.mjs; this
// invisible block runs its tick every 5 minutes and wakes a hibernated pane when it is selected.
// The on/off switch (hibernate.mjs on|off) is in the sidebar's Settings menu; while off nothing
// new sleeps, and sleeping panes still wake when selected.

import { View, div } from "gpui-kit";
import { spaces, panes, terminals, exec, appHome, notify } from "herdr";

const SCRIPT = () => `${appHome()}/claude/hibernate.mjs`;
const TICK_MS = 5 * 60 * 1000;

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
    if (this.running) return; // while switched off, the script returns at once
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

  // Nothing to show: the switch lives in the sidebar's Settings menu (chrome-dev). The block stays
  // in the layout at 0 px because its timers run the ticks and the wake on select.
  render() {
    return div().size_full();
  }
}
