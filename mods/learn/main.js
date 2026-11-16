// Learn: the learn-swe question inbox. Sessions add questions with ~/.claude/learning/learn.mjs;
// this pane lists them, takes the answer, shows the grade and the model answer.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, TextView } from "gpui-base";
import { exec, home, theme, watchFolder, setShared, checking, notify } from "herdr";
import { characterCard, radar, xpDelta } from "./rpg.js";

const SCRIPT = () => `${home()}/.claude/learning/learn.mjs`;
const INBOX = () => `${home()}/.claude/learning/inbox`;
const VERDICT = { right: ["Right", "done"], partial: ["Partly right", "blocked"], wrong: ["Wrong", "ansi1"] };
const md = (id, text) => TextView.markdown(id, text || "").selectable(true);

function age(iso) {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  return days <= 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
}

export default class Learn extends View {
  init(_props, cx) {
    this.questions = [];
    this.filter = "open";
    this.openId = null;
    this.pick = null;
    this.busy = false;
    this.error = "";
    this.stats = null;
    try { this.showSkills = localStorage.getItem("skills") !== "0"; } catch { this.showSkills = true; }
    this.text = TextareaState.new({ placeholder: "Your answer, in your own words", rows: 5 });
    this.reload(cx);
    // `herdr-app check` renders once, before any load finishes: give it stats so the RPG view is drawn.
    if (checking()) {
      this.stats = { xp: 1335, level: 3, rank: "Junior Engineer", maxLevel: 10, levelXp: 600, nextXp: 1350, concepts: 286, answered: 0, right: 0,
        axes: ["Architecture", "Testing", "Security", "Data & Perf", "Reliability", "DevOps", "Frontend", "Backend"].map((name, i) => ({ name, score: 10 + i * 9 })) };
      return;
    }
    cx.spawn(async (cx) => {
      await this.load(); // creates the inbox folder before the first watch
      for (;;) {
        // A rejected watch would spin; the ↻ button still reloads.
        if ((await watchFolder(INBOX()).catch(() => null)) === null) return;
        await this.load();
        cx.notify();
      }
    });
  }

  async load() {
    try {
      const r = await exec("node", [SCRIPT(), "list", "--json"]);
      this.questions = r.code === 0 ? JSON.parse(r.stdout) : this.questions;
      this.error = r.code === 0 ? "" : r.stderr.trim();
    } catch (e) { this.error = String(e); }
    try {
      const s = await exec("node", [SCRIPT(), "stats"]);
      if (s.code === 0) this.stats = JSON.parse(s.stdout);
    } catch {}
    setShared("learn.open", this.questions.filter((q) => q.status === "open").length);
  }

  reload(cx) { cx.spawn(async (cx) => { await this.load(); cx.notify(); }); }

  open(id) { this.openId = id; this.pick = null; this.text.set_value(""); this.error = ""; }

  submit(q, cx) {
    const input = q.kind === "choose" ? { option: this.pick } : { text: this.text.value().trim() };
    if (q.kind === "choose" ? this.pick === null : !input.text) return;
    this.busy = true; this.error = "";
    cx.spawn(async (cx) => {
      // Free-text answers are graded by claude -p, which can take a minute.
      const r = await exec("node", [SCRIPT(), "answer", q.id, JSON.stringify(input)], { timeout: 240000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) this.error = r.stderr.trim();
      await this.reloadAndAnnounce();
      this.busy = false; cx.notify();
    });
  }

  selfGrade(q, verdict, cx) {
    cx.spawn(async (cx) => {
      await exec("node", [SCRIPT(), "grade", q.id, verdict]).catch(() => null);
      await this.reloadAndAnnounce(); cx.notify();
    });
  }

  // Level changes get a toast: up after a right answer, down after a wrong one.
  async reloadAndAnnounce() {
    const before = this.stats?.level;
    await this.load();
    const after = this.stats?.level;
    if (!before || !after || before === after) return;
    notify(after > before
      ? { title: `Level up! Lv ${after}`, body: this.stats.rank, level: "success" }
      : { title: `Level down: Lv ${after}`, body: "Wrong answers cost XP. Review the ones you missed.", level: "warning" });
  }

  chip(t, id, label, on, action) {
    return div().id(id).px(8).h(22).flex().items_center().rounded(6).text_size(11.5)
      .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { action(); cx.notify(); }).child(label);
  }

  tag(t, text, color) {
    return div().px(6).py(1).rounded(4).text_size(10.5).bg(t.raised).text_color(color ?? t.muted).child(text);
  }

  section(t, title, body) {
    return v_flex().gap(4)
      .child(div().text_size(10.5).font_semibold().text_color(t.dim).child(title.toUpperCase()))
      .child(body);
  }

  list(t) {
    const shown = this.questions.filter((q) => this.filter === "all" || q.status === this.filter
      || (this.filter === "review" && q.response && q.response.verdict !== "right"));
    const open = this.questions.filter((q) => q.status === "open").length;
    // One scroll for the whole pane: with the radar open, a list-only scroll had no room left.
    return v_flex().id("learn-list").size_full().min_h(0).overflow_y_scrollbar()
      .child(h_flex().px(12).pt(10).pb(8).gap(6).items_center()
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Learn"))
        .child(this.tag(t, `${open} waiting`, open ? t.accent : t.muted))
        .child(div().flex_1())
        .child(div().id("reload").text_color(t.dim).hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => this.reload(cx)).child("↻")))
      .when(Boolean(this.stats), (el) => el.child(characterCard(t, this.stats, this.showSkills, () => {
        this.showSkills = !this.showSkills;
        try { localStorage.setItem("skills", this.showSkills ? "1" : "0"); } catch {}
      })))
      .when(Boolean(this.stats) && this.showSkills, (el) => el.child(radar(t, this.stats.axes, this.width ?? 280)))
      .child(h_flex().px(12).pb(8).gap(4)
        .child(this.chip(t, "f-open", "Waiting", this.filter === "open", () => { this.filter = "open"; }))
        .child(this.chip(t, "f-review", "To review", this.filter === "review", () => { this.filter = "review"; }))
        .child(this.chip(t, "f-answered", "Answered", this.filter === "answered", () => { this.filter = "answered"; }))
        .child(this.chip(t, "f-all", "All", this.filter === "all", () => { this.filter = "all"; })))
      .when(Boolean(this.error), (el) => el.child(div().px(12).pb(6).text_size(11.5).text_color(t.ansi1).child(this.error)))
      .child(v_flex().id("q-list").flex_none().px(8).pb(8).gap(4)
        .when(shown.length === 0, (el) => el.child(div().p(12).text_size(12).text_color(t.dim)
          .child(this.filter === "open" ? "No questions waiting. Sessions add them as you work." : "Nothing here yet.")))
        .children(shown.map((q) => {
          const v = q.response?.verdict;
          return v_flex().id(`q-${q.id}`).p(8).gap(4).rounded(8).bg(t.surface).border(1).border_color(t.border)
            .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.open(q.id); cx.notify(); })
            .child(div().text_size(12.5).text_color(t.foreground).child(q.title))
            .child(h_flex().gap(4).flex_wrap()
              .child(this.tag(t, q.concept))
              .child(this.tag(t, q.level ?? "senior"))
              .when(Boolean(v), (el) => el.child(this.tag(t, VERDICT[v][0], t[VERDICT[v][1]])))
              .child(div().text_size(10.5).text_color(t.dim).child([q.source?.repo, age(q.created)].filter(Boolean).join(" · "))));
        })));
  }

  detail(t, q) {
    const answered = q.status === "answered", r = q.response ?? {};
    const body = v_flex().id("q-body").flex_1().min_h(0).px(14).pb(14).gap(12).overflow_y_scrollbar()
      .child(div().text_size(14).font_semibold().text_color(t.foreground).child(q.title))
      .child(h_flex().gap(4).flex_wrap().child(this.tag(t, q.concept)).child(this.tag(t, q.area)).child(this.tag(t, q.level ?? "senior"))
        .when(Boolean(q.source?.ticket), (el) => el.child(this.tag(t, q.source.ticket))))
      .child(this.section(t, "Context", div().text_size(12.5).text_color(t.foreground).child(md(`ctx-${q.id}`, q.context))))
      .child(this.section(t, "Question", div().text_size(12.5).text_color(t.foreground).child(md(`qq-${q.id}`, q.question))));

    if (q.kind === "choose") {
      body.child(v_flex().gap(6).children(q.options.map((o, i) => {
        const mine = answered ? r.option === i : this.pick === i, correct = answered && q.answer.correct === i;
        return v_flex().id(`opt-${i}`).p(8).gap(2).rounded(8).border(1)
          .border_color(correct ? t.done : mine ? t.accent : t.border).bg(mine ? t.selected : t.surface)
          .when(!answered, (el) => el.hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.pick = i; cx.notify(); }))
          .child(div().text_size(12.5).text_color(t.foreground).child(`${String.fromCharCode(65 + i)}. ${o.label}`))
          .when(Boolean(o.detail), (el) => el.child(div().text_size(11.5).text_color(t.muted).child(o.detail)));
      })));
    } else if (!answered) {
      body.child(Textarea.new(this.text).w_full().text_size(12.5));
    } else {
      body.child(this.section(t, "Your answer", div().text_size(12.5).text_color(t.muted).child(md(`mine-${q.id}`, r.text))));
    }

    if (!answered) {
      body.child(h_flex().gap(8).items_center()
        .child(div().id("submit").px(12).h(28).flex().items_center().rounded(6).text_size(12.5)
          .bg(t.solid).text_color(t.solid_foreground).when(!this.busy, (el) => el.on_click((_e, cx) => this.submit(q, cx)))
          .child(this.busy ? (q.kind === "choose" ? "Checking…" : "Grading…") : "Submit"))
        .when(this.busy && q.kind !== "choose", (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(14).text_color(t.working).spin(900))));
    } else {
      const v = r.verdict;
      body.child(v
        ? h_flex().gap(8).items_center()
          .child(div().text_size(13).font_semibold().text_color(t[VERDICT[v][1]]).child(VERDICT[v][0]))
          .child(xpDelta(t, v))
        : v_flex().gap(6).child(div().text_size(12).text_color(t.muted).child("The model grade failed. Compare with the answer below and grade yourself:"))
          .child(h_flex().gap(4).children(Object.entries(VERDICT).map(([key, [label]]) =>
            this.chip(t, `g-${key}`, label, false, () => {}).on_click((_e, cx) => this.selfGrade(q, key, cx))))));
      if (r.feedback) body.child(this.section(t, "Feedback", div().text_size(12.5).text_color(t.foreground).child(md(`fb-${q.id}`, r.feedback))));
      if (q.kind !== "choose") body.child(this.section(t, "Model answer", div().text_size(12.5).text_color(t.foreground).child(md(`ans-${q.id}`, q.answer.correct))));
      body.child(this.section(t, "Why", div().text_size(12.5).text_color(t.foreground).child(md(`why-${q.id}`, q.answer.explanation))));
      if (q.answer.seniorLens) body.child(this.section(t, "Senior lens", div().text_size(12.5).text_color(t.foreground).child(md(`lens-${q.id}`, q.answer.seniorLens))));
      if (q.answer.readMore) body.child(this.section(t, "Read more", div().text_size(12).text_color(t.muted).child(q.answer.readMore)));
    }
    if (this.error) body.child(div().text_size(11.5).text_color(t.ansi1).child(this.error));

    return v_flex().size_full().min_h(0)
      .child(h_flex().px(10).pt(8).pb(6).items_center()
        .child(div().id("back").px(6).h(24).flex().items_center().rounded(6).text_size(12).text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { this.openId = null; cx.notify(); }).child("← Questions")))
      .child(body);
  }

  render() {
    const t = theme();
    const q = this.questions.find((x) => x.id === this.openId);
    return div().id("learn-root").size_full().bg(t.chrome)
      .on_size_change((size, cx) => { if (size.width !== this.width) { this.width = size.width; cx.notify(); } })
      .child(q ? this.detail(t, q) : this.list(t));
  }
}
