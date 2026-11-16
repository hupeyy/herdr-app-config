// A browser tab. Herdr has no web view, so this draws the frames a shared headless Chrome
// streams through hx/browser.mjs (the daemon) and sends clicks, scrolling and keys back.
// Agents drive the same page with `hx browser ...`. props: { id?, url? }; the page this pane
// shows is kept in shared "browser.tabs" { paneId: { id, url, title } } so it survives restarts.
// The console panel, observe-only mode and recording follow herdr-browser (StructuPath, MIT).

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, theme, panes, spaces, shared, setShared, run, exec, home, notify } from "herdr";

const DAEMON = "http://127.0.0.1:9334";
const TABS = "browser.tabs";
const HX = `${home()}/.config/herdr-app/hx/hx.mjs`;
const CONSOLE_LINES = 200; // kept in the panel
const FRAMES_UNDER = 3; // older frames drawn under the newest (the daemon keeps 3 s of files)
const LEVEL = { error: ["✖", "blocked"], warn: ["⚠", "working"] };

async function call(path, body) {
  const res = await fetch(`${DAEMON}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

// Tab mods get no pane in their props, so each copy claims one of the browser panes: the one
// "browser.tabs" maps to its page id, else one no copy holds yet. Module code is shared by copies.
const claimed = new Map(); // pane -> copy

function claimPane(copy, id) {
  const free = panes().filter((p) => p.mod === "browser" && (!claimed.has(p.pane) || claimed.get(p.pane) === copy));
  const map = shared(TABS) ?? {};
  const pick = (id && free.find((p) => map[p.pane]?.id === id)) ?? free.find((p) => !map[p.pane]) ?? free[free.length - 1];
  if (pick) claimed.set(pick.pane, copy);
  return pick?.pane ?? null;
}

// CDP modifier bits: alt 1, ctrl 2, meta 4, shift 8.
const bits = (m) => (m?.alt ? 1 : 0) | (m?.control ? 2 : 0) | (m?.platform ? 4 : 0) | (m?.shift ? 8 : 0);

export default class Browser extends View {
  init(_props, cx) {
    this.pane = claimPane(this, props()?.id);
    const saved = (shared(TABS) ?? {})[this.pane];
    this.id = saved?.id ?? props()?.id ?? null;
    this.url = saved?.url ?? props()?.url ?? "about:blank";
    this.title = saved?.title ?? "";
    this.seq = 0;
    this.frame = null;
    this.queue = [];
    // Observe only: clicks and keys stay out of the page, so watching an agent cannot disturb it.
    this.observe = false;
    this.consoleOpen = false;
    this.logs = [];
    this.logSeq = 0;
    this.errors = 0;
    this.recording = null;
    this.handle = cx.focus_handle();
    this.address = InputState.new({ placeholder: "Search or enter an address", value: this.url === "about:blank" ? "" : this.url });
    this.address.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.address.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.address.on("submit", (_e, cx) => { this.go(this.address.value().trim(), cx); this.handle.focus(); });
    // The stream runs while this tab is shown; the timer restarts it after a pause or an error.
    cx.timer.every(1000, (cx) => { if (!this.looping && !this.closed) this.loop(cx); });
    this.loop(cx);
  }

  async close() { this.closed = true; if (claimed.get(this.pane) === this) claimed.delete(this.pane); }

  // Shown: this pane's tab is the active tab of the active dev workspace.
  visible() {
    const me = panes().find((p) => p.pane === this.pane);
    if (!me) return false;
    return Boolean(spaces().find((s) => s.active)?.tabs?.find((t) => t.id === me.tab)?.active);
  }

  owner() {
    const me = panes().find((p) => p.pane === this.pane);
    return me ? { pane: this.pane, tab: me.tab, space: spaces().find((s) => s.tabs?.some((t) => t.id === me.tab))?.id ?? null } : null;
  }

  remember() {
    if (!this.pane) return;
    const all = { ...(shared(TABS) ?? {}) };
    // Drop panes that are gone.
    const live = new Set(panes().map((p) => p.pane));
    for (const k of Object.keys(all)) if (!live.has(k)) delete all[k];
    all[this.pane] = { id: this.id, url: this.url, title: this.title };
    setShared(TABS, all);
  }

  async daemon() {
    try { if ((await fetch(`${DAEMON}/ping`)).ok) return; } catch {}
    const r = await exec("node", [HX, "browser", "start"], { timeout: 20000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || "hx browser start failed");
  }

  apply(f, cx) {
    const moved = f.id !== this.id || f.url !== this.url || f.title !== this.title;
    this.id = f.id; this.seq = f.seq; this.loading = f.loading; this.error = null;
    this.errors = f.errors ?? 0;
    this.recording = f.recording ?? null;
    if (this.consoleOpen && (f.logSeq ?? 0) > this.logSeq) this.readConsole(cx);
    // image() draws nothing while it loads and has no load event, so the last frames stay stacked
    // under the newest (oldest at the bottom): one of them is always decoded.
    if (f.frame && f.frame !== this.frame) { this.under = [...(this.under ?? []), this.frame].filter(Boolean).slice(-FRAMES_UNDER); this.frame = f.frame; }
    if (f.url !== this.url) { this.url = f.url; if (!this.typing) this.address.set_value(f.url === "about:blank" ? "" : f.url); }
    if (f.title !== this.title) { this.renameTab(this.title, f.title); this.title = f.title; }
    if (moved) this.remember();
    cx.notify();
  }

  // The tab takes the page title, unless someone renamed it.
  renameTab(before, after) {
    const me = panes().find((p) => p.pane === this.pane);
    const tab = spaces().flatMap((s) => s.tabs ?? []).find((t) => t.id === me?.tab);
    if (!tab || !after) return;
    const auto = (s) => (s ?? "").slice(0, 32);
    if (["Browser", auto(before), ""].includes(tab.name) || /^tb\w+$/.test(tab.name)) run("tab.rename", { id: tab.id, name: auto(after) });
  }

  loop(cx) {
    this.looping = true;
    cx.spawn(async (cx) => {
      try {
        // The pane can show up in panes() after this copy starts.
        if (!this.pane) this.pane = claimPane(this, this.id);
        await this.daemon();
        if (!this.attached) {
          this.apply(await call("/attach", { id: this.id, url: this.url, owner: this.owner() }), cx);
          this.attached = true;
        }
        while (!this.closed && this.visible() && this.view) {
          this.apply(await call("/frame", { id: this.id, after: this.seq, width: this.view.width, height: this.view.height }), cx);
        }
      } catch (e) {
        this.error = e.message;
        // A page lost with Chrome is reopened at its last address on the next attach.
        if (/no browser tab/.test(e.message)) this.attached = false;
        cx.notify();
      }
      this.looping = false;
    });
  }

  readConsole(cx, clear = false) {
    if (!this.id || this.readingConsole) return;
    this.readingConsole = true;
    cx.spawn(async (cx) => {
      try {
        const r = await call("/console", { id: this.id, after: clear ? 0 : this.logSeq, clear });
        this.logs = clear ? [] : [...this.logs, ...r.lines].slice(-CONSOLE_LINES);
        this.logSeq = r.logSeq;
        this.errors = r.errors;
      } catch (e) { this.error = e.message; }
      this.readingConsole = false;
      cx.notify();
    });
  }

  toggleConsole(cx) {
    this.consoleOpen = !this.consoleOpen;
    if (this.consoleOpen) { this.logs = []; this.logSeq = 0; this.readConsole(cx); }
    cx.notify();
  }

  record(cx) {
    if (!this.id) return;
    const action = this.recording ? "stop" : "start";
    cx.spawn(async (cx) => {
      try {
        const r = await call("/record", { id: this.id, action });
        this.recording = r.recording ?? null;
        if (action === "stop") notify({ title: "Recording saved", body: `${r.path} (${r.seconds}s)`, level: "success" });
      } catch (e) { notify({ title: `Recording ${action === "stop" ? "not saved" : "did not start"}`, body: e.message, level: "error" }); }
      cx.notify();
    });
  }

  // Events go out in order, one request at a time; a run of mouse moves keeps only the last.
  send(event, cx) {
    if (!this.id || this.observe) return;
    const last = this.queue[this.queue.length - 1];
    if (event.action === "move" && last?.action === "move") this.queue[this.queue.length - 1] = event;
    else this.queue.push(event);
    if (this.sending) return;
    this.sending = true;
    cx.spawn(async () => {
      while (this.queue.length) {
        const events = this.queue.splice(0);
        try { await call("/input", { id: this.id, events }); } catch (e) { this.error = e.message; }
      }
      this.sending = false;
    });
  }

  go(text, cx) {
    if (!text || !this.id) return;
    const url = /^[a-z]+:\/\//i.test(text) || text.startsWith("about:") ? text
      : /^[^\s]+\.[^\s]+$|^localhost(:\d+)?(\/|$)/.test(text) ? `${text.startsWith("localhost") ? "http" : "https"}://${text}`
      : `https://www.google.com/search?q=${encodeURIComponent(text)}`;
    cx.spawn(async (cx) => { try { this.apply(await call("/nav", { id: this.id, url, wait: false }), cx); } catch (e) { this.error = e.message; cx.notify(); } });
  }

  nav(action, cx) {
    if (!this.id) return;
    cx.spawn(async (cx) => { try { this.apply(await call("/nav", { id: this.id, action, wait: false }), cx); } catch (e) { this.error = e.message; cx.notify(); } });
  }

  point(e) {
    const p = e.local_position ?? { x: 0, y: 0 };
    return { x: Math.round(p.x), y: Math.round(p.y) };
  }

  onKey(e, cx) {
    if (this.typing || this.observe) return;
    const m = e.modifiers ?? {};
    // ctrl-shift chords stay with herdr (its own bindings), and so does ctrl-l (focus the address).
    if (m.control && m.shift) return;
    if (m.control && e.key === "l") { this.address.focus(); cx.stop_propagation(); return; }
    const printable = e.key_char && !m.control && !m.alt && !m.platform;
    this.send({ type: "key", key: e.key, text: printable ? e.key_char : undefined, modifiers: bits(m) }, cx);
    cx.stop_propagation();
  }

  render(cx) {
    const t = theme();
    const button = (id, icon, tip, action, enabled = true) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(enabled ? t.muted : t.dim).opacity(enabled ? 1 : 0.5).tooltip(tip)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => action(cx)))
      .child(typeof icon === "string" && icon.endsWith(".svg") ? svg(icon).size(14) : div().text_size(14).child(icon));
    const toolbar = h_flex().h(36).px(6).gap(2).flex_none().items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(button("back", "←", "Back", (cx) => this.nav("back", cx)))
      .child(button("forward", "→", "Forward", (cx) => this.nav("forward", cx)))
      .child(button("reload", this.loading ? "✕" : "↻", this.loading ? "Stop" : "Reload", (cx) => this.nav(this.loading ? "stop" : "reload", cx)))
      .child(h_flex().flex_1().min_w(0).h(26).mx(4).px(10).items_center().rounded(13).bg(t.background).border(1)
        .border_color(this.typing ? t.accent : t.border)
        .child(Input.new(this.address).flex_1().h_full().text_size(12.5).text_color(t.foreground)))
      .child(button("observe", "👁", this.observe ? "Observe only: clicks and keys stay out of the page. Click to interact." : "Observe only (watch without touching the page)",
        (cx) => { this.observe = !this.observe; cx.notify(); }).when(this.observe, (el) => el.bg(t.selected).text_color(t.accent)))
      .child(button("record", "●", this.recording ? "Stop recording and save a GIF" : "Record this page (saves a GIF)", (cx) => this.record(cx))
        .when(Boolean(this.recording), (el) => el.text_color(t.blocked ?? "#e5534b").bg(t.selected)))
      .child(div().relative().child(button("console", "≡", this.errors ? `Console: ${this.errors} error${this.errors === 1 ? "" : "s"}` : "Console", (cx) => this.toggleConsole(cx))
        .when(this.consoleOpen, (el) => el.bg(t.selected).text_color(t.foreground)))
        .when(this.errors > 0, (el) => el.child(div().absolute().top(1).right(0).min_w(13).h(13).px(3).rounded(7).flex().items_center().justify_center()
          .bg(t.blocked ?? "#e5534b").text_color("#ffffff").text_size(9).font_medium().child(this.errors > 99 ? "99+" : String(this.errors)))))
      .child(button("external", "↗", "Open in your browser", (cx) => this.url && cx.open_url(this.url), /^https?:/.test(this.url ?? "")));
    const viewport = div().id("viewport").flex_1().min_h(0).relative().overflow_hidden().bg("#ffffff")
      .on_size_change((size, cx) => {
        const next = { width: Math.round(size.width), height: Math.round(size.height) };
        if (next.width === this.view?.width && next.height === this.view?.height) return;
        this.view = next;
        cx.notify();
      })
      .on_mouse_down("left", (e, cx) => { this.handle.focus(); this.dragging = true; this.send({ type: "mouse", action: "down", ...this.point(e), clicks: e.click_count, modifiers: bits(e.modifiers) }, cx); })
      .on_mouse_up("left", (e, cx) => { this.dragging = false; this.send({ type: "mouse", action: "up", ...this.point(e), clicks: e.click_count, modifiers: bits(e.modifiers) }, cx); })
      .on_mouse_down("right", (e, cx) => { this.handle.focus(); this.send({ type: "mouse", action: "down", button: "right", ...this.point(e) }, cx); })
      .on_mouse_up("right", (e, cx) => this.send({ type: "mouse", action: "up", button: "right", ...this.point(e) }, cx))
      .on_mouse_move((e, cx) => this.send({ type: "mouse", action: "move", ...this.point(e), buttons: this.dragging ? 1 : 0 }, cx))
      // GPUI's delta is positive when scrolling up; Chrome's is positive scrolling down.
      .on_scroll_wheel((e, cx) => this.send({ type: "wheel", ...this.point(e), dx: -(e.delta?.x ?? 0), dy: -(e.delta?.y ?? 0) }, cx))
      .children((this.under ?? []).map((path) => image(path).absolute().top(0).left(0).size_full()))
      .when(Boolean(this.frame), (el) => el.child(image(this.frame).absolute().top(0).left(0).size_full()))
      .when(!this.frame, (el) => el.child(div().size_full().flex().items_center().justify_center().bg(t.background).text_color(t.dim)
        .child(this.error ? `Browser: ${this.error}` : "Starting the browser…")))
      .when(Boolean(this.loading), (el) => el.child(div().absolute().top(0).left(0).h(2).w_full().bg(t.accent).opacity(0.8)));
    return v_flex().id("browser").size_full().min_h(0).bg(t.background).track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(toolbar)
      .when(Boolean(this.error && this.frame), (el) => el.child(div().px(10).py(4).flex_none().text_size(11.5).bg(t.chrome).text_color(t.blocked ?? t.muted).child(this.error)))
      .child(viewport)
      .when(this.consoleOpen, (el) => el.child(this.consolePanel(t)));
  }

  consolePanel(t) {
    const tone = (level) => t[LEVEL[level]?.[1]] ?? t.foreground;
    return v_flex().id("console").h(170).flex_none().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.5)
      .child(h_flex().h(26).px(10).gap(10).flex_none().items_center().border_b(1).border_color(t.border)
        .child(div().font_medium().text_color(t.muted).child("Console"))
        .child(div().flex_1().text_color(this.errors ? tone("error") : t.dim).child(this.errors ? `${this.errors} error${this.errors === 1 ? "" : "s"}` : "no errors"))
        .child(div().id("console-clear").text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => this.readConsole(cx, true)).child("Clear"))
        .child(div().id("console-close").text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => this.toggleConsole(cx)).child("✕")))
      .child(v_flex().id("console-lines").flex_1().min_h(0).px(10).py(4).overflow_y_scrollbar()
        .when(!this.logs.length, (el) => el.child(div().text_color(t.dim).child("Console output, page errors and failed requests show here.")))
        .children(this.logs.map((l) => h_flex().id(`log-${l.n}`).gap(6).items_start().py(1)
          .child(div().w(12).flex_none().text_color(tone(l.level)).child(LEVEL[l.level]?.[0] ?? ""))
          .when(l.source !== "console", (el) => el.child(div().flex_none().text_color(t.dim).child(`[${l.source}]`)))
          .child(div().flex_1().min_w(0).text_color(LEVEL[l.level] ? tone(l.level) : t.foreground).child(l.text)))));
  }
}
