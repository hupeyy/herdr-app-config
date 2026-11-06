// status-usage, a clone of workspace-status with Claude plan usage in the left corner, like Orca:
// "Used ✳ ▬▬ 8% 3h · 41% 1d 13h · 0% Fable". It reads Claude Code's own sign-in token from
// ~/.claude/.credentials.json and asks api.anthropic.com/api/oauth/usage, as Orca does.
// The token stays in this view's memory; only the percentages go to shared("usage.claude").

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, terminals, theme, run, window, keys, home, readTextFile, shared, setShared, exec, openOverlay } from "herdr";

// The Resource Manager chip, like Orca's "2.00 GB · >_ 1": the working set of every terminal's
// process tree plus Herdr's own, and the live terminal count. A click opens mod "resources".
// mods/resources/snapshot.mjs measures it (a mod cannot import from another mod's folder).
const RESOURCES_EVERY_MS = 20000;
const RESOURCES_CACHE = "resources.snapshot"; // { snap, prev }: the last two measurements

// Auto-summary: when Herdr notifies that an agent finished (status turns "done") or the agent ran
// /clear, re-summarise that one agent with mods/space-summary/summarize.mjs. Lives here because this chip is always
// mounted and the summary panel is not. Pending agents wait SETTLE_MS for the turn count to land.
const SUMMARY_FILE = () => `${home()}/.cache/herdr-app/space-summary.json`;
const SUMMARIZE = () => `${home()}/.config/herdr-app/mods/space-summary/summarize.mjs`;
const SETTLE_MS = 3000;
const RUN_STALE_MS = 3 * 60 * 1000; // as in space-summary: an older "running" mark is from a dead run
const seen = (x) => ({ status: x.status, session: x.labels?.["claude.session"] ?? null });

const URL = "https://api.anthropic.com/api/oauth/usage";
const CACHE = "usage.claude";
const EVERY_MS = 5 * 60 * 1000;
const BACKOFF_MS = 10 * 60 * 1000;

const ms = (v) => { const t = v ? new Date(v).getTime() : NaN; return Number.isFinite(t) ? t : null; };

function left(resetsAt) {
  if (!resetsAt) return "";
  const m = Math.max(0, Math.round((resetsAt - Date.now()) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

// The response's `limits` list, else its older five_hour / seven_day fields.
function parse(data) {
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  const find = (kind, model) => limits.find((l) => l?.kind === kind && Number.isFinite(l.percent)
    && (!model || l.scope?.model?.display_name?.toLowerCase() === model));
  const win = (l, raw) => (l ? { pct: l.percent, resets: ms(l.resets_at), severity: l.severity ?? "normal" }
    : Number.isFinite(raw?.utilization) ? { pct: raw.utilization, resets: ms(raw.resets_at), severity: "normal" } : null);
  return {
    session: win(find("session"), data?.five_hour),
    weekly: win(find("weekly_all"), data?.seven_day),
    fable: win(find("weekly_scoped", "fable"), null),
  };
}

export default class StatusUsage extends View {
  init(_props, cx) {
    this.nextAt = 0;
    this.tick(cx);
    cx.timer.every(60000, (cx) => { this.tick(cx); cx.notify(); });
    const cached = shared(RESOURCES_CACHE)?.snap;
    this.memory = cached ? { ws: cached.total.ws, ptys: Object.keys(cached.roots).length } : null;
    this.measure(cx);
    cx.timer.every(RESOURCES_EVERY_MS, (cx) => this.measure(cx));
    this.last = new Map(terminals().map((x) => [x.address, seen(x)]));
    this.pending = new Map(); // address -> { at, newSession }
    cx.timer.every(1500, (cx) => this.watchAgents(cx));
  }

  // Edge-triggered, so a restart does not re-summarise every agent that was already done.
  // A change into "done" is Herdr's "finished" notification; a new claude.session label is /clear or /resume.
  watchAgents(cx) {
    const live = terminals().filter((x) => x.state === "live");
    for (const x of live) {
      const before = this.last.get(x.address), now = seen(x);
      if (!before || !now.session) continue;
      if (before.session && now.session !== before.session) this.pending.set(x.address, { at: Date.now(), newSession: true });
      else if (now.status === "done" && before.status !== "done") this.pending.set(x.address, { at: Date.now(), newSession: false });
    }
    this.last = new Map(live.map((x) => [x.address, seen(x)]));
    const due = [...this.pending].filter(([, p]) => Date.now() - p.at >= SETTLE_MS).map(([a, p]) => ({ address: a, newSession: p.newSession }));
    if (due.length && !this.summarizing) this.summarizeAgents(cx, due);
  }

  summarizeAgents(cx, due) {
    this.summarizing = true;
    cx.spawn(async (cx) => {
      try {
        const cache = JSON.parse((await readTextFile(SUMMARY_FILE())) || "{}");
        if (cache.running && Date.now() - cache.running < RUN_STALE_MS) return; // a panel Summarize owns the file; retry next tick
        const live = terminals().filter((x) => x.state === "live" && x.labels?.["claude.session"]);
        const info = new Map(agents().map((a) => [a.address, a]));
        const byAddress = new Map(due.map((d) => [d.address, d]));
        const stale = live.filter((x) => byAddress.has(x.address)).map((x) => ({
          id: x.address, session: x.labels["claude.session"], turn: x.turn ?? null, title: x.title || info.get(x.address)?.title || "",
          space: info.get(x.address)?.space_name ?? "", tab: info.get(x.address)?.tab_name ?? "", newSession: byAddress.get(x.address).newSession,
        }));
        for (const d of due) this.pending.delete(d.address);
        if (!stale.length) return;
        await exec("node", [SUMMARIZE(), JSON.stringify({ live: live.map((x) => x.address), stale })]);
        const next = JSON.parse((await readTextFile(SUMMARY_FILE())) || "{}");
        setShared("space.summary", { at: next.at ?? null, items: next.items ?? {} });
        cx.notify();
      } catch {} finally { this.summarizing = false; }
    });
  }

  measure(cx) {
    if (this.measuring) return;
    this.measuring = true;
    const roots = terminals().filter((x) => x.state === "live" && x.pid).map((x) => ({ a: x.address, p: x.pid }));
    cx.spawn(async (cx) => {
      try {
        const r = await exec("node", [`${home()}/.config/herdr-app/mods/resources/snapshot.mjs`, JSON.stringify(roots)]);
        if (r.code === 0) {
          const snap = JSON.parse(r.stdout);
          this.memory = { ws: snap.total.ws, ptys: roots.length };
          // The Resource Manager opens on this cache instead of measuring again.
          setShared(RESOURCES_CACHE, { snap, prev: shared(RESOURCES_CACHE)?.snap ?? null });
          cx.notify();
        }
      } catch {} finally { this.measuring = false; }
    });
  }

  resources(t) {
    const m = this.memory;
    const size = !m ? "…" : m.ws >= 2 ** 30 ? `${(m.ws / 2 ** 30).toFixed(2)} GB` : `${Math.round(m.ws / 2 ** 20)} MB`;
    return h_flex().id("resources-chip").h(20).px(7).gap(6).items_center().rounded(5).border_1().border_color(t.border)
      .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Resource Manager")
      // The panel sits on the chip, like Orca's: its bottom 6 px above the chip, right edges lined
      // up. A popup opens down from the pointer and sizes to its content, so the panel is placed
      // by its top left and told its height (props.height) to fill. A click event carries no
      // position; the mouse-down before it carries the chip's bounds (window-relative).
      .on_mouse_down("left", (e) => { this.chipBounds = e.bounds ?? null; })
      .on_click(() => {
        const b = this.chipBounds;
        const height = b ? Math.min(640, Math.max(240, b.y - 14)) : 640;
        const at = b ? { x: Math.max(8, b.x + b.width - 430), y: Math.max(8, b.y - 6 - height) } : undefined;
        openOverlay({ mod: "resources", kind: "popup", width: 430, height, props: { height }, ...(at ? { at } : {}) });
      })
      .child(svg("mods/workspace-chrome/monitor.svg").size(12))
      .child(`${size} · >_ ${m?.ptys ?? "…"}`);
  }

  // Opens mod "space-summary". The count is live: agents blocked on a prompt, plus agents whose
  // last summary says they wait on Alex (refreshed per agent when it finishes, or by Summarize).
  summary(t) {
    const items = shared("space.summary")?.items ?? {};
    const needs = terminals().filter((x) => x.state === "live" && (x.status === "blocked"
      || (items[x.address]?.verdict === "you" && items[x.address]?.session === x.labels?.["claude.session"]))).length;
    return h_flex().id("summary-chip").h(20).px(7).gap(6).items_center().rounded(5).border_1().border_color(t.border)
      .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Workspace summary")
      .on_click(() => openOverlay({ mod: "space-summary", kind: "dialog", width: 0.86, height: 0.8 }))
      .child(svg("mods/workspace-chrome/layers.svg").size(12))
      .child("Summary")
      .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`· ${needs} need${needs === 1 ? "s" : ""} you`)));
  }

  tick(cx) {
    const cached = shared(CACHE);
    if (Date.now() < this.nextAt || (cached?.at && Date.now() - cached.at < EVERY_MS && !cached.error)) return;
    this.nextAt = Date.now() + EVERY_MS;
    cx.spawn(async (cx) => {
      let next;
      try {
        const raw = await readTextFile(`${home()}\\.claude\\.credentials.json`);
        const token = raw ? JSON.parse(raw)?.claudeAiOauth?.accessToken : null;
        if (!token) next = { at: Date.now(), error: "Not signed in" };
        else {
          const res = await fetch(URL, { headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0" } });
          if (res.status === 401 || res.status === 403) next = { at: Date.now(), error: "Sign-in expired" };
          else if (res.status === 429) { this.nextAt = Date.now() + BACKOFF_MS; next = { ...(shared(CACHE) ?? {}), at: Date.now() }; }
          else if (!res.ok) next = { ...(shared(CACHE) ?? {}), at: Date.now(), error: `Usage: HTTP ${res.status}` };
          else next = { at: Date.now(), ...parse(await res.json()), error: null };
        }
      } catch {
        next = { ...(shared(CACHE) ?? {}), at: Date.now(), error: "Usage unavailable" };
      }
      setShared(CACHE, next);
      cx.notify();
    });
  }

  usage(t) {
    const u = shared(CACHE);
    const color = (w) => (w?.severity === "critical" || w?.pct >= 95 ? t.blocked : w?.severity === "warning" || w?.pct >= 80 ? t.working : t.accent);
    const icon = image("icons/claude.svg").w(13).h(13).flex_none();
    const head = h_flex().gap(6).items_center().child(div().text_color(t.dim).child("Used")).child(icon);
    if (!u) return head.child(div().text_color(t.dim).child("…"));
    if (u.error && !u.session && !u.weekly) return head.child(div().text_color(t.dim).child(u.error));
    const s = u.session, w = u.weekly, f = u.fable;
    const bar = h_flex().w(46).h(5).flex_none().rounded(3).bg(t.border).overflow_hidden()
      .child(div().h_full().w(Math.round(46 * Math.min(100, s?.pct ?? 0) / 100)).bg(color(s)));
    const part = (win, label) => div().text_color(win?.pct >= 80 ? color(win) : t.muted).child(`${Math.round(win.pct)}% ${label}`);
    const tip = [
      s && `Session (5h): ${Math.round(s.pct)}%, resets in ${left(s.resets) || "5h"}`,
      w && `Week: ${Math.round(w.pct)}%, resets in ${left(w.resets)}`,
      f && `Fable this week: ${Math.round(f.pct)}%`,
      u.error && `Last refresh failed: ${u.error}`,
    ].filter(Boolean).join("\n");
    return h_flex().id("usage").gap(7).items_center().tooltip(tip)
      .child(head).child(bar)
      .when(Boolean(s), (el) => el.child(part(s, left(s.resets) || "5h")))
      .when(Boolean(w), (el) => el.child(div().text_color(t.dim).child("·")).child(part(w, left(w.resets))))
      .when(Boolean(f), (el) => el.child(div().text_color(t.dim).child("·")).child(part(f, "Fable")));
  }

  // The palette key as actually bound, not a hardcoded one.
  hint() {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render() {
    const t = theme();
    const space = spaces().find((s) => s.active);
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(this.usage(t))
      .child(div().w(1).h(14).bg(t.border))
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), (el) => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .child(this.summary(t))
      .child(this.resources(t))
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint()));
  }
}
