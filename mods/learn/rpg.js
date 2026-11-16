// RPG view for the learn pane: level card with a level-progress bar, and a skill radar.
// Numbers come from `learn.mjs stats`; keep ANSWER_XP in step with learn.mjs.
import { div, PathBuilder, Background } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";

const ANSWER_XP = { right: 30, partial: 10, wrong: -20 };

export function xpDelta(t, verdict) {
  const xp = ANSWER_XP[verdict];
  return div().px(6).py(1).rounded(4).text_size(11.5).font_semibold().bg(t.raised)
    .text_color(xp > 0 ? t.done : t.ansi1).child(`${xp > 0 ? "+" : ""}${xp} XP`);
}

export function characterCard(t, s, open, toggle) {
  const max = s.nextXp === null;
  const pct = max ? 100 : Math.max(0, Math.min(100, (100 * (s.xp - s.levelXp)) / (s.nextXp - s.levelXp)));
  const pips = Array.from({ length: s.maxLevel }, (_, i) => div().flex_1().h(4).rounded(2)
    .bg(i < s.level ? t.accent : t.raised));
  return v_flex().mx(8).mb(8).p(10).gap(8).rounded(10).bg(t.surface).border(1).border_color(t.border)
    .child(h_flex().gap(10).items_center()
      .child(v_flex().size(40).flex_none().items_center().justify_center().rounded(8).bg(t.accent)
        .child(div().text_size(9).text_color(t.accent_foreground).child("LV"))
        .child(div().text_size(17).font_semibold().text_color(t.accent_foreground).child(String(s.level))))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child(s.rank))
        .child(div().text_size(11).text_color(t.dim)
          .child(max ? `MAX LEVEL · ${s.xp} XP` : `${s.xp - s.levelXp} / ${s.nextXp - s.levelXp} XP to Lv ${s.level + 1}`)))
      .child(div().id("skills-toggle").px(8).h(22).flex().items_center().rounded(6).text_size(11.5)
        .bg(open ? t.selected : t.chrome).text_color(open ? t.foreground : t.muted).hover((x) => x.bg(t.hover))
        .on_click((_e, cx) => { toggle(); cx.notify(); }).child("Skills")))
    // Progress inside the current level.
    .child(div().w_full().h(10).rounded(5).bg(t.raised).overflow_hidden()
      .child(div().h_full().rounded(5).w(`${pct}%`).bg(max ? t.done : t.accent)))
    // The road to Senior: one pip per level.
    .child(h_flex().gap(3).children(pips))
    .child(h_flex().justify_between().text_size(10.5).text_color(t.dim).child("Junior").child("Senior"))
    .child(div().text_size(10.5).text_color(t.dim).child(`${s.right} right · ${s.answered} answered · ${s.concepts} concepts`));
}

// Labels sit outside the shape, so the radius leaves LABEL_W / 2 + a gap on each side.
const LABEL_W = 78;

function geometry(width) {
  const W = Math.max(200, Math.min(340, width - 16));
  const R = W / 2 - LABEL_W / 2 - 20;
  const H = 2 * (R + 40);
  return { W, H, R, CX: W / 2, CY: H / 2 };
}

function point(g, i, n, r) {
  const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
  return [g.CX + r * Math.cos(a), g.CY + r * Math.sin(a)];
}

function polygon(builder, pts) {
  pts.forEach(([x, y], i) => (i ? builder.line_to(x, y) : builder.move_to(x, y)));
  return builder.close().build();
}

const layer = (path, color) => window.paint_path(path, color).absolute().top(0).left(0).size_full();

export function radar(t, axes, width) {
  const g = geometry(width), { W, H, R } = g;
  const n = axes.length;
  const layers = [];
  for (const ring of [0.25, 0.5, 0.75, 1]) {
    layers.push(layer(polygon(PathBuilder.stroke(1), axes.map((_, i) => point(g, i, n, R * ring))), t.border));
  }
  for (let i = 0; i < n; i++) {
    const [x, y] = point(g, i, n, R);
    layers.push(layer(PathBuilder.stroke(1).move_to(g.CX, g.CY).line_to(x, y).build(), t.border));
  }
  const shape = axes.map((a, i) => point(g, i, n, R * Math.max(0.04, a.score / 100)));
  layers.push(layer(polygon(PathBuilder.fill(), shape), Background.solid(t.accent).opacity(0.3)));
  layers.push(layer(polygon(PathBuilder.stroke(2), shape), t.accent));
  const labels = axes.map((a, i) => {
    const [x, y] = point(g, i, n, R + 18);
    return v_flex().absolute().left(x - LABEL_W / 2).top(y - 14).w(LABEL_W).items_center()
      .child(div().text_size(10.5).text_color(t.foreground).truncate().child(a.name))
      .child(div().text_size(10.5).font_semibold().text_color(t.accent).child(String(a.score)));
  });
  return h_flex().justify_center().pb(6)
    .child(div().relative().w(W).h(H).children([...layers, ...labels]));
}
