// Browser tabs for herdr: one shared headless Chrome and the small HTTP daemon that drives it.
//
// Herdr mods cannot embed a web view, so a browser tab (mods/browser) draws JPEG frames that this
// daemon writes from Chrome's screencast, and sends clicks and keys back. Agents use the same
// daemon through `hx browser ...`. Chrome's DevTools port (9333) is open too, so
// chrome-devtools-mcp --browser-url=http://127.0.0.1:9333 can attach to the same pages.
//
// Kept light: one Chrome for every tab, started on first use with background features off and few
// renderer processes; a frame stream runs only while a herdr tab shows it; Chrome and the daemon
// exit after IDLE_EXIT_MS with no pages, and pages whose herdr tab is gone are closed.

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = join(homedir(), ".config", "herdr-app");
export const DIR = join(HOME, "data", "browser");
// image() paths are relative to the herdr-app home.
const FRAMES_REL = "data/browser/frames";
const FRAMES = join(HOME, FRAMES_REL);
const SHOTS = join(DIR, "shots");
const PROFILE = join(process.env.LOCALAPPDATA ?? join(homedir(), ".cache"), "herdr-app", "browser-profile");
export const DAEMON_PORT = 9334;
export const CHROME_PORT = 9333;
const IDLE_EXIT_MS = 5 * 60000;
const VIEWER_GONE_MS = 2500; // no frame request for this long: stop that tab's screencast
const GC_EVERY_MS = 60000;
const DEFAULT_SIZE = { width: 1280, height: 800 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- client side (hx and the mod's helper) ----

export async function call(path, body) {
  const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `browser daemon: HTTP ${res.status}`);
  return data;
}

async function alive() {
  try { return (await fetch(`http://127.0.0.1:${DAEMON_PORT}/ping`, { signal: AbortSignal.timeout(800) })).ok; } catch { return false; }
}

// Starts the daemon detached unless one answers. Returns once it answers.
export async function ensureDaemon() {
  if (await alive()) return;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve"], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  for (let i = 0; i < 100; i++) { await sleep(100); if (await alive()) return; }
  throw new Error(`the browser daemon did not start; see ${join(DIR, "daemon.log")}`);
}

// ---- Chrome ----

function findChrome() {
  if (process.env.HERDR_BROWSER_CHROME) return process.env.HERDR_BROWSER_CHROME;
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean);
  const found = [
    ...roots.map((r) => join(r, "Google", "Chrome", "Application", "chrome.exe")),
    ...roots.map((r) => join(r, "Microsoft", "Edge", "Application", "msedge.exe")),
  ].find(existsSync);
  if (!found) throw new Error("no Chrome or Edge found (set HERDR_BROWSER_CHROME)");
  return found;
}

const CHROME_FLAGS = [
  "--headless=new", `--remote-debugging-port=${CHROME_PORT}`, `--user-data-dir=${PROFILE}`,
  "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-component-update",
  "--disable-background-networking", "--disable-sync", "--disable-default-apps", "--mute-audio",
  "--disable-breakpad", "--disable-domain-reliability", "--metrics-recording-only",
  // Fewer processes: software drawing inside the browser process (no GPU process), no spare
  // renderer, no per-site renderers, and pages share renderers once this many exist.
  "--disable-gpu", "--disable-gpu-compositing", "--in-process-gpu", "--disable-site-isolation-trials",
  "--renderer-process-limit=2",
  "--disable-features=Translate,OptimizationHints,MediaRouter,BackForwardCache,InterestFeedContentSuggestions,AutofillServerCommunication,SpareRendererForSitePerProcess,IsolateOrigins,site-per-process,PaintHolding",
  "--disk-cache-size=67108864", `--window-size=${DEFAULT_SIZE.width},${DEFAULT_SIZE.height}`,
  "about:blank",
];

async function chromeVersion() {
  try {
    const r = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`, { signal: AbortSignal.timeout(800) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

let launched = false;

async function startChrome() {
  let v = await chromeVersion();
  if (!v) {
    mkdirSync(PROFILE, { recursive: true });
    const child = spawn(findChrome(), CHROME_FLAGS, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    for (let i = 0; i < 100 && !v; i++) { await sleep(100); v = await chromeVersion(); }
    if (!v) throw new Error("headless Chrome did not open its DevTools port");
    launched = true;
  }
  return v.webSocketDebuggerUrl;
}

// ---- CDP over one browser socket, pages through flattened sessions ----

class Cdp {
  constructor(url) {
    this.next = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.ws = new WebSocket(url);
    this.ready = new Promise((ok, fail) => { this.ws.onopen = ok; this.ws.onerror = () => fail(new Error("CDP socket failed")); });
    this.ws.onmessage = (m) => this.onMessage(JSON.parse(m.data));
    this.ws.onclose = () => { this.closed = true; for (const p of this.pending.values()) p.fail(new Error("Chrome went away")); this.pending.clear(); };
  }
  onMessage(msg) {
    if (msg.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.fail(new Error(msg.error.message)) : p.ok(msg.result);
    } else for (const fn of this.listeners) fn(msg);
  }
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error("Chrome went away"));
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((ok, fail) => this.pending.set(id, { ok, fail }));
  }
}

// ---- the daemon ----

const tabs = new Map(); // targetId -> tab
let cdp = null;
let lastBusy = Date.now();
let herdrGone = 0;
const log = (...a) => { try { writeFileSync(join(DIR, "daemon.log"), `${new Date().toISOString()} ${a.join(" ")}\n`, { flag: "a" }); } catch {} };

async function connect() {
  if (cdp && !cdp.closed) return cdp;
  tabs.clear();
  const c = new Cdp(await startChrome());
  await c.ready;
  c.listeners.add(onEvent);
  // Title and URL changes arrive as Target.targetInfoChanged.
  await c.send("Target.setDiscoverTargets", { discover: true });
  cdp = c;
  // The blank page Chrome starts with holds a renderer of its own.
  if (launched) {
    launched = false;
    const { targetInfos } = await c.send("Target.getTargets");
    for (const t of targetInfos) if (t.type === "page" && t.url === "about:blank" && !tabs.has(t.targetId)) await c.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
  }
  return c;
}

function tabBySession(sessionId) {
  for (const t of tabs.values()) if (t.session === sessionId) return t;
  return null;
}

function onEvent(msg) {
  const tab = msg.sessionId ? tabBySession(msg.sessionId) : null;
  if (msg.method === "Target.targetInfoChanged") {
    const t = tabs.get(msg.params.targetInfo.targetId);
    if (t) { t.url = msg.params.targetInfo.url; t.title = msg.params.targetInfo.title; save(); }
  } else if (msg.method === "Target.targetDestroyed" || msg.method === "Target.detachedFromTarget") {
    const id = msg.params.targetId ?? [...tabs.values()].find((t) => t.session === msg.params.sessionId)?.id;
    if (id && tabs.has(id)) { dropFrames(id); tabs.delete(id); save(); }
  } else if (!tab) return;
  else if (msg.method === "Page.screencastFrame") onFrame(tab, msg.params);
  else if (msg.method === "Page.frameStartedLoading") tab.loading = true;
  else if (msg.method === "Page.frameStoppedLoading" || msg.method === "Page.loadEventFired") { tab.loading = false; wake(tab); }
}

function onFrame(tab, { data, sessionId }) {
  cdp.send("Page.screencastFrameAck", { sessionId }, tab.session).catch(() => {});
  tab.seq += 1;
  const name = `${tab.id.slice(0, 12)}-${tab.seq}.jpg`;
  try { writeFileSync(join(FRAMES, name), Buffer.from(data, "base64")); } catch (e) { log("frame write", e.message); return; }
  tab.frame = `${FRAMES_REL}/${name}`;
  // Keep the last six: the tab draws the one before under the newest while that loads.
  const old = `${tab.id.slice(0, 12)}-${tab.seq - 6}.jpg`;
  rmSync(join(FRAMES, old), { force: true });
  wake(tab);
}

function wake(tab) {
  const waiters = tab.waiters.splice(0);
  for (const w of waiters) w();
}

function dropFrames(id) {
  const prefix = id.slice(0, 12);
  try { for (const f of readdirSync(FRAMES)) if (f.startsWith(prefix)) rmSync(join(FRAMES, f), { force: true }); } catch {}
}

function save() {
  const list = [...tabs.values()].map(({ id, url, title, owner }) => ({ id, url, title, owner }));
  try { writeFileSync(join(DIR, "tabs.json"), JSON.stringify(list, null, 2)); } catch {}
}

async function attach(id, url) {
  const c = await connect();
  const { sessionId } = await c.send("Target.attachToTarget", { targetId: id, flatten: true });
  const tab = { id, session: sessionId, url, title: "", loading: false, seq: 0, frame: null, waiters: [], size: null, casting: false, viewedAt: 0, owner: null };
  tabs.set(id, tab);
  await Promise.all([c.send("Page.enable", {}, sessionId), c.send("Runtime.enable", {}, sessionId)]);
  await setSize(tab, DEFAULT_SIZE);
  save();
  return tab;
}

async function open(url) {
  const c = await connect();
  const { targetId } = await c.send("Target.createTarget", { url: url || "about:blank" });
  return attach(targetId, url);
}

// A tab by id, or reopen its last URL when Chrome restarted since (the id is then new).
async function find(id, reopenUrl) {
  await connect();
  if (tabs.has(id)) return tabs.get(id);
  const { targetInfos } = await cdp.send("Target.getTargets");
  if (targetInfos.some((t) => t.targetId === id && t.type === "page")) return attach(id, targetInfos.find((t) => t.targetId === id).url);
  if (reopenUrl !== undefined) return open(reopenUrl);
  throw new Error(`no browser tab ${id}`);
}

async function setSize(tab, size) {
  const width = Math.max(200, Math.round(size.width)), height = Math.max(150, Math.round(size.height));
  if (tab.size?.width === width && tab.size?.height === height) return;
  tab.size = { width, height };
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, tab.session);
  if (tab.casting) await startCast(tab, true);
}

async function startCast(tab, restart) {
  if (tab.casting && !restart) return;
  if (restart) await cdp.send("Page.stopScreencast", {}, tab.session).catch(() => {});
  tab.casting = true;
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 72, maxWidth: tab.size.width, maxHeight: tab.size.height, everyNthFrame: 1 }, tab.session);
}

async function stopCast(tab) {
  if (!tab.casting) return;
  tab.casting = false;
  await cdp.send("Page.stopScreencast", {}, tab.session).catch(() => {});
}

const info = (t) => ({ id: t.id, url: t.url, title: t.title, loading: t.loading, seq: t.seq, frame: t.frame, size: t.size, owner: t.owner });

async function evaluate(tab, expression, { returnByValue = true } = {}) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue, userGesture: true }, tab.session);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

async function waitLoad(tab, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  await sleep(150);
  while (Date.now() < end) {
    const state = await evaluate(tab, "document.readyState").catch(() => "loading");
    if (state === "complete" || state === "interactive") return;
    await sleep(150);
  }
}

// ---- input ----

const KEYS = {
  enter: [13, "Enter", "\r"], tab: [9, "Tab"], backspace: [8, "Backspace"], escape: [27, "Escape"], delete: [46, "Delete"],
  space: [32, " ", " "], up: [38, "ArrowUp"], down: [40, "ArrowDown"], left: [37, "ArrowLeft"], right: [39, "ArrowRight"],
  home: [36, "Home"], end: [35, "End"], pageup: [33, "PageUp"], pagedown: [34, "PageDown"],
};

// modifiers: CDP bits (alt 1, ctrl 2, meta 4, shift 8).
async function pressKey(tab, key, modifiers = 0, text) {
  const k = KEYS[key.toLowerCase()];
  const single = key.length === 1 ? key : null;
  const code = k?.[0] ?? (single ? single.toUpperCase().charCodeAt(0) : 0);
  const name = k?.[1] ?? single ?? key;
  const typed = modifiers & ~8 ? undefined : text ?? k?.[2] ?? single ?? undefined;
  const base = { modifiers, windowsVirtualKeyCode: code, key: name, code: single && /[a-z]/i.test(single) ? `Key${single.toUpperCase()}` : name };
  await cdp.send("Input.dispatchKeyEvent", { type: typed ? "keyDown" : "rawKeyDown", ...base, ...(typed ? { text: typed } : {}) }, tab.session);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, tab.session);
}

async function mouse(tab, type, x, y, extra = {}) {
  await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "none", modifiers: 0, ...extra }, tab.session);
}

async function clickAt(tab, x, y, clickCount = 1) {
  await mouse(tab, "mouseMoved", x, y);
  await mouse(tab, "mousePressed", x, y, { button: "left", clickCount });
  await mouse(tab, "mouseReleased", x, y, { button: "left", clickCount });
}

function clipboardText() {
  try { return execFileSync("powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], { encoding: "utf8", windowsHide: true }).replace(/\r?\n$/, ""); } catch { return ""; }
}

// One event from a herdr browser tab.
async function input(tab, e) {
  if (e.type === "mouse") {
    const extra = e.action === "move" ? (e.buttons ? { button: "left", buttons: 1 } : {}) : { button: e.button ?? "left", clickCount: e.clicks ?? 1 };
    await mouse(tab, { down: "mousePressed", up: "mouseReleased", move: "mouseMoved" }[e.action], e.x, e.y, { ...extra, modifiers: e.modifiers ?? 0 });
  } else if (e.type === "wheel") {
    await mouse(tab, "mouseWheel", e.x, e.y, { deltaX: e.dx ?? 0, deltaY: e.dy ?? 0 });
  } else if (e.type === "key") {
    // ctrl-v pastes the system clipboard: headless Chrome has no clipboard of its own.
    if (e.modifiers === 2 && e.key.toLowerCase() === "v") {
      const text = clipboardText();
      if (text) await cdp.send("Input.insertText", { text }, tab.session);
    } else await pressKey(tab, e.key, e.modifiers ?? 0, e.text);
  } else if (e.type === "text") {
    await cdp.send("Input.insertText", { text: e.text }, tab.session);
  }
}

// ---- what an agent sees: numbered interactive elements ----

const SNAPSHOT_JS = `(() => {
  const sel = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=option],[contenteditable=""],[contenteditable=true],[onclick]';
  document.querySelectorAll('[data-hx-ref]').forEach((el) => el.removeAttribute('data-hx-ref'));
  const out = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || st.visibility === 'hidden' || st.display === 'none') continue;
    n += 1;
    el.setAttribute('data-hx-ref', String(n));
    const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.getAttribute('name') || el.href || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const role = el.getAttribute('role') || (el.tagName === 'A' ? 'link' : el.tagName === 'INPUT' ? 'input:' + (el.type || 'text') : el.tagName.toLowerCase());
    const where = r.bottom < 0 || r.top > innerHeight ? ' (offscreen)' : '';
    out.push('[' + n + '] ' + role + ' "' + name + '"' + (el.disabled ? ' disabled' : '') + where);
  }
  return { title: document.title, url: location.href, items: out };
})()`;

async function refCenter(tab, ref) {
  const sel = /^\d+$/.test(String(ref)) ? `[data-hx-ref="${ref}"]` : String(ref);
  const r = await evaluate(tab, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' }); const b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  if (!r) throw new Error(`nothing matches ${ref}${/^\d+$/.test(String(ref)) ? " (run hx browser snap first; refs reset on each snap)" : ""}`);
  return r;
}

// ---- herdr-side cleanup ----

function herdrTabIds() {
  try {
    const app = JSON.parse(execFileSync("herdr-app", ["ls"], { encoding: "utf8", windowsHide: true }));
    return new Set(app.spaces.flatMap((s) => s.tabs.map((t) => t.id)));
  } catch { return null; }
}

async function gc() {
  for (const t of tabs.values()) if (t.casting && Date.now() - t.viewedAt > VIEWER_GONE_MS) await stopCast(t);
  const live = tabs.size ? herdrTabIds() : null;
  // herdr-app closed: its tabs restore their pages on the next start, so Chrome can go.
  herdrGone = tabs.size && !live ? herdrGone + 1 : 0;
  if (herdrGone >= 5) { log("herdr-app gone: closing Chrome"); await cdp?.send("Browser.close").catch(() => {}); process.exit(0); }
  if (live) {
    for (const t of [...tabs.values()]) {
      // A page whose herdr tab closed; pages opened without a tab get ten minutes.
      const orphan = t.owner?.tab ? !live.has(t.owner.tab) : Date.now() - (t.openedAt ?? 0) > 10 * 60000;
      if (orphan) { log("closing orphan", t.id, t.url); await cdp.send("Target.closeTarget", { targetId: t.id }).catch(() => {}); tabs.delete(t.id); dropFrames(t.id); }
    }
    save();
  }
  if (tabs.size) lastBusy = Date.now();
  else if (Date.now() - lastBusy > IDLE_EXIT_MS) {
    log("idle: closing Chrome");
    await cdp?.send("Browser.close").catch(() => {});
    process.exit(0);
  }
}

// ---- HTTP ----

async function body(req) {
  let s = "";
  for await (const chunk of req) s += chunk;
  return s ? JSON.parse(s) : {};
}

const routes = {
  "GET /ping": async () => ({ ok: true, pid: process.pid, chrome: CHROME_PORT }),
  "GET /tabs": async () => ({ tabs: [...tabs.values()].map(info) }),
  "POST /open": async ({ url, owner }) => { const t = await open(url); t.openedAt = Date.now(); if (owner) t.owner = owner; save(); return info(t); },
  // A herdr tab (re)attaching after a restart: same page if Chrome kept it, else its URL again.
  "POST /attach": async ({ id, url, owner }) => {
    const t = id ? await find(id, url ?? "about:blank") : await open(url);
    t.openedAt ??= Date.now();
    if (owner) t.owner = owner;
    save();
    return info(t);
  },
  "POST /owner": async ({ id, owner }) => { const t = await find(id); t.owner = owner; save(); return info(t); },
  "POST /close": async ({ id }) => {
    await connect();
    await cdp.send("Target.closeTarget", { targetId: id }).catch(() => {});
    tabs.delete(id); dropFrames(id); save();
    return { closed: id };
  },
  // The herdr tab's long poll: returns as soon as a frame newer than `after` exists (or 10 s).
  // Calling it is what keeps the screencast on; `idle` polls do not.
  "POST /frame": async ({ id, after = 0, width, height }) => {
    const t = await find(id);
    t.viewedAt = Date.now();
    if (width && height) await setSize(t, { width, height });
    await startCast(t);
    if (t.seq <= after) await new Promise((ok) => { t.waiters.push(ok); setTimeout(ok, 10000); });
    t.viewedAt = Date.now();
    return info(t);
  },
  "POST /input": async ({ id, events }) => { const t = await find(id); for (const e of events ?? []) await input(t, e); return { ok: true }; },
  "POST /nav": async ({ id, url, action, wait = true }) => {
    const t = await find(id);
    if (url) await cdp.send("Page.navigate", { url: /^[a-z]+:/i.test(url) ? url : `https://${url}` }, t.session);
    else if (action === "back") await evaluate(t, "history.back()");
    else if (action === "forward") await evaluate(t, "history.forward()");
    else if (action === "reload") await cdp.send("Page.reload", {}, t.session);
    else if (action === "stop") await cdp.send("Page.stopLoading", {}, t.session);
    if (wait && action !== "stop") await waitLoad(t);
    return info(t);
  },
  "POST /shot": async ({ id, full }) => {
    const t = await find(id);
    mkdirSync(SHOTS, { recursive: true });
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: Boolean(full) }, t.session);
    const path = join(SHOTS, `${t.id.slice(0, 8)}-${Date.now()}.png`);
    writeFileSync(path, Buffer.from(data, "base64"));
    // Keep the newest 20 screenshots.
    const all = readdirSync(SHOTS).sort();
    for (const f of all.slice(0, Math.max(0, all.length - 20))) rmSync(join(SHOTS, f), { force: true });
    return { path, ...info(t) };
  },
  "POST /text": async ({ id, max = 20000 }) => {
    const t = await find(id);
    const text = await evaluate(t, "document.body ? document.body.innerText : ''");
    return { ...info(t), text: String(text ?? "").slice(0, max) };
  },
  "POST /snap": async ({ id }) => ({ ...(await evaluate(await find(id), SNAPSHOT_JS)) }),
  "POST /click": async ({ id, ref, x, y, double }) => {
    const t = await find(id);
    const at = ref !== undefined ? await refCenter(t, ref) : { x, y };
    await clickAt(t, at.x, at.y, double ? 2 : 1);
    if (double) await clickAt(t, at.x, at.y, 2);
    await sleep(120);
    return { clicked: at, ...info(t) };
  },
  "POST /type": async ({ id, ref, text, enter, clear }) => {
    const t = await find(id);
    if (ref !== undefined) { const at = await refCenter(t, ref); await clickAt(t, at.x, at.y); }
    if (clear) { await pressKey(t, "a", 2); await pressKey(t, "backspace"); }
    if (text) await cdp.send("Input.insertText", { text }, t.session);
    if (enter) await pressKey(t, "enter");
    return info(t);
  },
  "POST /key": async ({ id, key, modifiers = 0 }) => { const t = await find(id); await pressKey(t, key, modifiers); return info(t); },
  "POST /scroll": async ({ id, dy = 600, dx = 0 }) => {
    const t = await find(id);
    const s = t.size ?? DEFAULT_SIZE;
    await mouse(t, "mouseWheel", s.width / 2, s.height / 2, { deltaX: dx, deltaY: dy });
    return info(t);
  },
  "POST /eval": async ({ id, js }) => ({ value: await evaluate(await find(id), js) }),
  "POST /wait": async ({ id, selector, text, timeout = 15 }) => {
    const t = await find(id);
    const end = Date.now() + timeout * 1000;
    const test = selector ? `!!document.querySelector(${JSON.stringify(selector)})`
      : text ? `document.body && document.body.innerText.includes(${JSON.stringify(text)})` : "document.readyState === 'complete'";
    while (Date.now() < end) { if (await evaluate(t, test).catch(() => false)) return { found: true, ...info(t) }; await sleep(200); }
    throw new Error(`timed out after ${timeout}s waiting for ${selector ?? text ?? "load"}`);
  },
  "POST /quit": async () => { setTimeout(async () => { await cdp?.send("Browser.close").catch(() => {}); process.exit(0); }, 50); return { ok: true }; },
};

async function serve() {
  mkdirSync(FRAMES, { recursive: true });
  // Frames from an earlier run are stale.
  for (const f of readdirSync(FRAMES)) rmSync(join(FRAMES, f), { force: true });
  const server = createServer(async (req, res) => {
    const route = routes[`${req.method} ${req.url.split("?")[0]}`];
    res.setHeader("Content-Type", "application/json");
    if (!route) { res.statusCode = 404; return res.end(JSON.stringify({ error: `no route ${req.method} ${req.url}` })); }
    try {
      lastBusy = Date.now();
      res.end(JSON.stringify(await route(await body(req))));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  server.on("error", (e) => { log("server", e.message); process.exit(e.code === "EADDRINUSE" ? 0 : 1); });
  server.listen(DAEMON_PORT, "127.0.0.1", () => log("listening", DAEMON_PORT));
  setInterval(() => gc().catch((e) => log("gc", e.message)), GC_EVERY_MS);
  setInterval(() => { for (const t of tabs.values()) if (t.casting && Date.now() - t.viewedAt > VIEWER_GONE_MS) stopCast(t); }, 1000);
}

if (process.argv[2] === "serve" && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(DIR, { recursive: true });
  process.on("uncaughtException", (e) => log("uncaught", e.stack ?? e.message));
  serve();
}
