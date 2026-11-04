// status-usage, a clone of workspace-status with Claude plan usage in the left corner, like Orca:
// "Used ✳ ▬▬ 8% 3h · 41% 1d 13h · 0% Fable". It reads Claude Code's own sign-in token from
// ~/.claude/.credentials.json and asks api.anthropic.com/api/oauth/usage, as Orca does.
// The token stays in this view's memory; only the percentages go to shared("usage.claude").

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, home, readTextFile, shared, setShared } from "herdr";

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
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint()));
  }
}
