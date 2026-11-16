// Images inside Jira and PR text. TextView draws no images, so a body is cut into markdown pieces
// and image blocks. fetch-image.mjs downloads each image (with the token its service needs) into
// data/tasks-images, and image() draws it from there.

import { div, image } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { exec, appHome } from "herdr";

const DIR = "data/tasks-images";
const HELPER = `${appHome()}/mods/tasks/fetch-image.mjs`;

// A markdown image, optionally wrapped in a link, or an <img> tag, optionally wrapped in <a>.
const IMAGE = /(?:\[\s*)?!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)(?:\]\([^)]*\))?|(?:<a\b[^>]*>\s*)?<img\b([^>]*)>(?:\s*<\/a>)?/gi;
const FENCE = /(```[\s\S]*?```)/;

const attr = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1] ?? null;
const unescape = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");

// The body as [{ md }] and [{ img: { url, alt, width } }] pieces, in order. Code fences stay text.
const pieces = new Map();
export function segments(text) {
  if (pieces.has(text)) return pieces.get(text);
  const out = [];
  for (const part of String(text ?? "").split(FENCE)) {
    if (part.startsWith("```")) { out.push({ md: part }); continue; }
    let last = 0;
    for (const m of part.matchAll(IMAGE)) {
      out.push({ md: part.slice(last, m.index) });
      const url = m[2] ?? unescape(attr(m[3], "src") ?? "");
      const width = Number(m[3] ? attr(m[3], "width") : 0) || null;
      if (url) out.push({ img: { url, alt: m[1] ?? attr(m[3] ?? "", "alt") ?? "", width } });
      last = m.index + m[0].length;
    }
    out.push({ md: part.slice(last) });
  }
  const merged = out.filter((p) => p.img || p.md.trim());
  if (pieces.size > 500) pieces.clear();
  pieces.set(text, merged);
  return merged;
}

// key -> { src, state: idle|loading|ready|error, path, w, h, error }
const cache = new Map();
const keyOf = (kind, url) => `${kind}:${url}`;

// Registers a body's images and returns their keys. html is GitHub's rendered body: its <img>
// sources are signed or proxied URLs that load without a browser session, so when it holds the
// same number of images they are downloaded in place of the raw ones.
export function trackImages(kind, text, html) {
  const imgs = segments(text).filter((p) => p.img).map((p) => p.img.url);
  const signed = html ? [...html.matchAll(/<img\b[^>]*?\bsrc="([^"]+)"/gi)].map((m) => unescape(m[1])) : [];
  return imgs.map((url, i) => {
    const key = keyOf(kind, url);
    if (!cache.has(key)) cache.set(key, { src: signed.length === imgs.length ? signed[i] : url, state: "idle" });
    return key;
  });
}

// Downloads every image not yet on disk; onEach runs as each one settles (to redraw).
export function downloadImages(keys, onEach) {
  return Promise.all([...new Set(keys)].map(async (key) => {
    const entry = cache.get(key);
    if (!entry || entry.state === "ready") return;
    entry.promise ??= (async () => {
      entry.state = "loading";
      const [kind, ...rest] = key.split(":");
      try {
        const r = await exec("node", [HELPER, kind, rest.join(":"), entry.src, `${appHome()}/${DIR}`], { timeout: 60000 });
        if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
        const info = JSON.parse(r.stdout);
        Object.assign(entry, { state: "ready", path: `${DIR}/${info.file}`, w: info.w, h: info.h });
      } catch (e) {
        Object.assign(entry, { state: "error", error: String(e.message ?? e).slice(0, 160) });
      }
      entry.promise = null; // an error retries on the next load
    })();
    await entry.promise;
    onEach?.();
  }));
}

const markdown = (id, text) => TextView.markdown(id, text || "").selectable(true);

function imageBlock(t, id, kind, img, maxWidth) {
  const entry = cache.get(keyOf(kind, img.url));
  const label = img.alt || img.url.split("/").pop().split("?")[0];
  if (entry?.state !== "ready") {
    const failed = entry?.state === "error";
    return h_flex().id(id).h(30).px(10).gap(6).items_center().rounded(6).border_1().border_color(t.border)
      .text_size(11.5).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
      .tooltip(failed ? `${entry.error}. Click to open it in the browser.` : img.url)
      .on_click((_e, cx) => cx.open_url(img.url))
      .child(div().truncate().child(`${failed ? "Image did not load" : "Loading image"}: ${label}`));
  }
  // An SVG reports no size: draw it at its tag width, else a badge-like strip.
  const natural = entry.w ?? img.width ?? 240;
  const w = Math.max(16, Math.round(Math.min(natural, img.width ?? natural, maxWidth)));
  const h = Math.round(entry.w && entry.h ? (w * entry.h) / entry.w : w / 4);
  return div().id(id).flex_none().w(w).h(h).rounded(4).overflow_hidden().cursor_pointer()
    .tooltip(`${label} · click to open`)
    .on_click((_e, cx) => cx.open_url(img.url))
    .child(image(entry.path).w(w).h(h));
}

// Markdown with its images drawn in place. maxWidth: the room the text column has.
export function richMarkdown(t, id, text, kind, maxWidth = 640) {
  const parts = segments(text);
  if (!parts.some((p) => p.img)) return markdown(id, text);
  return v_flex().gap(8).children(parts.map((p, i) => (p.img
    ? imageBlock(t, `${id}-img${i}`, kind, p.img, maxWidth)
    : markdown(`${id}-${i}`, p.md))));
}

// A row of images that are not in the text (Jira attachments nobody placed inline).
export function imageGallery(t, id, kind, imgs, maxWidth) {
  return v_flex().gap(8).children(imgs.map((img, i) => v_flex().gap(4)
    .child(div().text_size(11.5).text_color(t.dim).truncate().child(img.alt))
    .child(imageBlock(t, `${id}-${i}`, kind, img, maxWidth))));
}
