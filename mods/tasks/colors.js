// Readable colors on any theme, measured at render time from theme() values (WCAG 2 contrast).
// Themes in themes/*.json can set any status color, so nothing here assumes dark or light.

function parse(color) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color ?? "");
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

const hex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return 21; // An unparseable color is the theme's business; leave it as given.
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

function mix(a, b, share) {
  const x = parse(a), y = parse(b);
  return x && y ? hex(x.map((v, i) => v + (y[i] - v) * share)) : a;
}

// Text on a filled color (a pill): whichever theme text color reads best on it.
export function onFill(t, fill) {
  const options = [t.background, t.foreground, t.accent_foreground, t.solid_foreground].filter(Boolean);
  return options.reduce((best, c) => (contrast(c, fill) > contrast(best, fill) ? c : best), options[0]);
}

// A status color used as text on `bg`, pulled toward the foreground until it reaches 3:1
// (WCAG's minimum for bold or UI text), so a pale yellow stays readable on a white panel.
export function ink(t, name, bg) {
  const color = t[name] ?? t.muted;
  for (const share of [0, 0.25, 0.5, 0.75]) {
    const c = share ? mix(color, t.foreground, share) : color;
    if (contrast(c, bg) >= 3) return c;
  }
  return t.foreground;
}
