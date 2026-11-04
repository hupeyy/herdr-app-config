// One Claude subagent as a tab: what it was asked, what it is doing now, and each step it took,
// newest first. Opened from a session's child row in the sidebar (space-panel).
// props: { path, id, type, description }: path is the subagent's transcript, which Claude Code
// writes beside its session's (<session>/subagents/agent-<id>.jsonl). The tab follows it live.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { readTextFile, watchFolder, theme, props, shared, setShared, panes, focused } from "herdr";

// { paneId: agentId } for every open agent tab, so the sidebar focuses a tab instead of opening
// a second one. herdr keeps no mod props we can read back.
const TABS = "agent.tabs";
const SHOWN_STEPS = 150;
const RESULT_LINES = 8;
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;

const short = (text, max) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");

function resultText(block) {
  const c = block.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x.type === "text" ? x.text : "")).join("\n") : "";
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

// The transcript as { prompt, steps }: assistant text, and tool calls with their results.
export function parse(text) {
  let prompt = "";
  const steps = [];
  const byTool = new Map();
  for (const line of text.split("\n")) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const content = e.message?.content;
    if (e.type === "user") {
      if (typeof content === "string") { if (!prompt) prompt = content; continue; }
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type === "text" && !prompt) prompt = b.text;
        if (b.type === "tool_result") {
          const step = byTool.get(b.tool_use_id);
          if (step) { step.result = resultText(b); step.error = Boolean(b.is_error); }
        }
      }
    } else if (e.type === "assistant" && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === "text" && b.text?.trim()) steps.push({ kind: "text", text: b.text.trim(), at: e.timestamp });
        if (b.type === "tool_use") {
          const input = b.input ?? {};
          const target = input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.skill ?? "";
          const step = {
            kind: "tool", name: b.name, at: e.timestamp,
            title: short(input.description || target || input.command || "", 140),
            detail: input.command ?? (input.description ? target : ""),
            result: null, error: false,
          };
          byTool.set(b.id, step);
          steps.push(step);
        }
      }
    }
  }
  return { prompt, steps };
}

export default class AgentView extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.path = p.path ?? "";
    this.data = { prompt: "", steps: [] };
    this.finished = false;
    this.error = null;
    this.showPrompt = false;
    this.stale = true;
    this.closed = false;
    this.load(cx);
    // Appends come in bursts: a change marks the view stale and this reloads at most once a second.
    cx.timer.every(1000, (cx) => { if (this.stale) this.load(cx); });
    this.watch(cx);
  }

  load(cx) {
    this.stale = false;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(this.path);
        if (text === null) { this.error = "The transcript is gone (the session was cleaned up)."; cx.notify(); return; }
        this.data = parse(text);
        const meta = await readTextFile(this.path.replace(/\.jsonl$/, ".meta.json")).catch(() => null);
        try { this.finished = JSON.parse(meta ?? "{}").finished === true; } catch {}
        this.error = null;
      } catch (e) { this.error = String(e.message ?? e); }
      cx.notify();
    });
  }

  watch(cx) {
    const dir = this.path.replace(/[\\/][^\\/]+$/, "");
    cx.spawn(async () => {
      while (!this.closed && !this.finished) {
        try { await watchFolder(dir); } catch { return; }
        this.stale = true;
      }
    });
  }

  async close() { this.closed = true; }

  myPane() {
    if (this.pane) return this.pane;
    const claimed = shared(TABS) ?? {};
    const f = focused()?.pane;
    if (f && panes().some((p) => p.pane === f && p.mod === "agent-view") && !claimed[f]) this.pane = f;
    return this.pane;
  }

  record() {
    const pane = this.myPane();
    if (!pane) return;
    const live = new Set(panes().map((p) => p.pane));
    const next = Object.fromEntries(Object.entries(shared(TABS) ?? {}).filter(([id]) => live.has(id)));
    next[pane] = props()?.id ?? "";
    if (JSON.stringify(next) !== JSON.stringify(shared(TABS))) setShared(TABS, next);
  }

  step(t, s, i) {
    if (s.kind === "text") {
      return v_flex().gap(4).p(10).rounded(8).border_1().border_color(t.border).bg(t.surface)
        .child(div().text_size(11).text_color(t.dim).child(clock(s.at)))
        .child(div().text_size(12.5).text_color(t.foreground).child(TextView.markdown(`txt-${i}`, s.text).selectable(true)));
    }
    const lines = (s.result ?? "").split("\n");
    const result = lines.slice(0, RESULT_LINES).join("\n") + (lines.length > RESULT_LINES ? `\n… ${lines.length - RESULT_LINES} more lines` : "");
    return v_flex().gap(4).p(10).rounded(8).border_1().border_color(s.error ? t.blocked : t.border).bg(t.surface)
      .child(h_flex().gap(8).items_center().text_size(12)
        .child(s.result === null ? svg(ICON("spinner")).size(12).flex_none().text_color(t.working).spin(900)
          : svg(ICON(s.error ? "square" : "check")).size(12).flex_none().text_color(s.error ? t.blocked : t.done))
        .child(div().flex_none().font_semibold().text_color(t.foreground).child(s.name))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(s.title))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(clock(s.at))))
      .when(Boolean(s.detail), (el) => el.child(div().p(6).rounded(5).bg(t.background).font_family("monospace").text_size(11.5)
        .text_color(t.muted).child(String(s.detail).slice(0, 1200))))
      .when(Boolean(s.result), (el) => el.child(div().font_family("monospace").text_size(11).text_color(t.dim).child(result)));
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    this.record();
    const { prompt, steps } = this.data;
    const now = [...steps].reverse().find((s) => s.kind === "tool" || s.kind === "text");
    const status = this.finished ? ["Finished", t.done] : ["Running", t.working];
    return v_flex().id("agent-view").size_full().min_h(0).bg(t.background).text_size(13)
      .child(v_flex().px(16).pt(12).pb(10).gap(6).flex_none().border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(div().px(6).rounded(5).bg(t.raised).text_size(11).text_color(t.muted).child(p.type ?? "agent"))
          .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground).child(p.description || p.id || "Subagent"))
          .when(!this.finished, (el) => el.child(svg(ICON("spinner")).size(12).text_color(t.working).spin(900)))
          .child(div().text_size(12).text_color(status[1]).child(status[0])))
        .when(!this.finished && Boolean(now), (el) => el.child(div().truncate().text_size(12).text_color(t.muted)
          .child(`Now: ${now.kind === "tool" ? `${now.name} ${now.title}` : short(now.text, 160)}`)))
        .when(Boolean(prompt), (el) => el.child(div().id("prompt-toggle").text_size(12).text_color(t.dim).cursor_pointer()
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.showPrompt = !this.showPrompt; cx.notify(); })
          .child(this.showPrompt ? "Hide the task" : "Show the task it was given"))))
      .child(v_flex().id("agent-steps").flex_1().min_h(0).p(12).gap(8).overflow_y_scrollbar()
        .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
        .when(this.showPrompt && Boolean(prompt), (el) => el.child(v_flex().p(10).rounded(8).border_1().border_color(t.input).bg(t.surface)
          .child(div().text_size(11).text_color(t.dim).child("TASK"))
          .child(div().text_size(12.5).text_color(t.foreground).child(TextView.markdown("prompt", prompt).selectable(true)))))
        .when(!steps.length && !this.error, (el) => el.child(div().text_color(t.dim).child("No steps yet.")))
        .children(steps.slice(-SHOWN_STEPS).reverse().map((s, i) => this.step(t, s, i))));
  }
}
