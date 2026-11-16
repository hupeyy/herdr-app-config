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
const RECORDINGS = join(DIR, "recordings");
const PROFILE = join(process.env.LOCALAPPDATA ?? join(homedir(), ".cache"), "herdr-app", "browser-profile");
export const DAEMON_PORT = 9334;
export const CHROME_PORT = 9333;
const IDLE_EXIT_MS = 5 * 60000;
const VIEWER_GONE_MS = 2500; // no frame request for this long: stop that tab's screencast
const GC_EVERY_MS = 60000;
const DEFAULT_SIZE = { width: 1280, height: 800 };
const LOG_LIMIT = 300; // console lines, page errors and failed requests kept per page
const NET_LIMIT = 200; // request rows kept per page
const RECORD_MAX_FRAMES = 1500; // a GIF past this gets too big to open
// Request types whose failure means the page is broken (images and fonts are noise).
const WATCHED = new Set(["XHR", "Fetch", "Document"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Frame pacing after Orca's remote browser (stablyai/orca browser-screencast-*): every 2nd compositor
// frame, at most one frame per FRAME_MIN_MS with the newest kept, identical frames skipped. herdr's
// image() has no decode event, so files stay on disk for FRAME_KEEP_MS and the tab stacks the last few:
// a frame still loading always has an older, decoded one under it.
const FRAME_QUALITY = 80;
const FRAME_MIN_MS = 50;
const FRAME_KEEP_MS = 3000;

// Pages render at the display's scale (1.5 at 150%), so herdr shows frames at full sharpness instead
// of stretching 1x ones. HX_BROWSER_SCALE overrides it. Read once per daemon run.
let scale = null;
function displayScale() {
  if (scale) return scale;
  scale = Number(process.env.HX_BROWSER_SCALE) || 0;
  if (!scale && process.platform === "win32") {
    try {
      const ps = "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class D { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); [DllImport(\"user32.dll\")] public static extern uint GetDpiForSystem(); }'; [D]::SetProcessDPIAware() | Out-Null; [D]::GetDpiForSystem()";
      scale = Number(execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8", windowsHide: true, timeout: 10000 }).trim()) / 96;
    } catch (e) { log("display scale", e.message); }
  }
  scale = Math.min(3, Math.max(1, scale || 1));
  log("display scale", scale);
  return scale;
}

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
    const child = spawn(findChrome(), [`--force-device-scale-factor=${displayScale()}`, ...CHROME_FLAGS], { detached: true, stdio: "ignore", windowsHide: true });
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
  else if (msg.method.startsWith("Network.")) onNetwork(tab, msg);
  else if (msg.method === "Runtime.consoleAPICalled") {
    const p = msg.params;
    if (p.timestamp >= tab.attachedAt) addLog(tab, p.type === "warning" ? "warn" : p.type, "console", argsText(p.args));
  } else if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails ?? {};
    if (msg.params.timestamp >= tab.attachedAt) addLog(tab, "error", "page", d.exception?.description ?? d.text ?? "uncaught exception");
  } else if (msg.method === "Log.entryAdded") {
    const e = msg.params.entry ?? {};
    // Failed requests come from onNetwork, which also leaves out images and favicons.
    if (e.timestamp >= tab.attachedAt && e.source !== "network") addLog(tab, e.level === "warning" ? "warn" : e.level, e.source ?? "log", `${e.text ?? ""}${e.url ? `  ${e.url}` : ""}`);
  } else if (msg.method === "Inspector.targetCrashed") addLog(tab, "error", "page", "the page crashed");
  else if (msg.method === "Page.frameStartedLoading") tab.loading = true;
  else if (msg.method === "Page.frameStoppedLoading" || msg.method === "Page.loadEventFired") { tab.loading = false; wake(tab); }
}

// ---- console, page errors and requests (after herdr-browser by StructuPath, MIT) ----

// Console arguments as one line: strings as they are, other values by their preview.
function argsText(args = []) {
  return args.map((a) => (a.type === "string" ? a.value : a.value !== undefined ? JSON.stringify(a.value)
    : a.description ?? a.preview?.description ?? a.type)).join(" ").slice(0, 2000);
}

function addLog(tab, level, source, text) {
  tab.logSeq += 1;
  tab.logs.push({ n: tab.logSeq, at: Date.now(), level, source, text });
  if (tab.logs.length > LOG_LIMIT) tab.logs.shift();
  if (level === "error") tab.errors += 1;
  wake(tab);
}

// One row per request; a failed XHR, fetch or document (4xx, 5xx, no response) also goes to the log.
function onNetwork(tab, { method, params: p }) {
  if (method === "Network.requestWillBeSent") {
    const row = { id: p.requestId, at: Date.now(), method: p.request?.method ?? "", type: p.type ?? "", url: p.request?.url ?? "", status: null };
    tab.net.push(row);
    tab.netById.set(p.requestId, row);
    if (tab.net.length > NET_LIMIT) tab.netById.delete(tab.net.shift().id);
    return;
  }
  const row = tab.netById.get(p.requestId);
  if (!row) return;
  if (method === "Network.responseReceived") row.status = p.response?.status ?? null;
  else if (method === "Network.loadingFailed") row.status = p.canceled ? "canceled" : p.errorText || "failed";
  else return;
  const failed = typeof row.status === "number" ? row.status >= 400 : row.status !== "canceled";
  if (failed && WATCHED.has(row.type)) addLog(tab, "error", "network", `${row.status} ${row.method} ${row.url}`);
}

function onFrame(tab, { data, sessionId }) {
  cdp.send("Page.screencastFrameAck", { sessionId }, tab.session).catch(() => {});
  // Chrome resends an unchanged picture while the page animates off screen: same bytes, nothing to draw.
  if (data === tab.lastData) return;
  tab.lastData = data;
  const wait = FRAME_MIN_MS - (Date.now() - (tab.frameAt ?? 0));
  if (wait <= 0) { writeFrame(tab, data); return; }
  // Too soon: hold the newest and write it when the gap is over (a still page may send no more).
  tab.heldFrame = data;
  tab.heldTimer ??= setTimeout(() => {
    tab.heldTimer = null;
    const held = tab.heldFrame;
    tab.heldFrame = null;
    if (held && tabs.get(tab.id) === tab) writeFrame(tab, held);
  }, wait);
}

function writeFrame(tab, data) {
  tab.frameAt = Date.now();
  tab.seq += 1;
  const name = `${tab.id.slice(0, 12)}-${tab.seq}.jpg`;
  const bytes = Buffer.from(data, "base64");
  try { writeFileSync(join(FRAMES, name), bytes); } catch (e) { log("frame write", e.message); return; }
  if (tab.recording) recordFrame(tab, bytes);
  tab.frame = `${FRAMES_REL}/${name}`;
  (tab.written ??= []).push({ name, at: tab.frameAt });
  // herdr may still be loading a recent file: delete only old ones, and always keep the last six.
  while (tab.written.length > 6 && tab.frameAt - tab.written[0].at > FRAME_KEEP_MS) rmSync(join(FRAMES, tab.written.shift().name), { force: true });
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
  const tab = { id, session: sessionId, url, title: "", loading: false, seq: 0, frame: null, waiters: [], size: null, casting: false, viewedAt: 0, owner: null,
    // Chrome replays older console lines when Runtime and Log are enabled: those are skipped.
    attachedAt: Date.now(), logs: [], logSeq: 0, errors: 0, net: [], netById: new Map(), recording: null, lastSnap: null };
  tabs.set(id, tab);
  await Promise.all([c.send("Page.enable", {}, sessionId), c.send("Runtime.enable", {}, sessionId),
    c.send("Network.enable", {}, sessionId), c.send("Log.enable", {}, sessionId)]);
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
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: displayScale(), mobile: false }, tab.session);
  if (tab.casting) await startCast(tab, true);
}

async function startCast(tab, restart) {
  if (tab.casting && !restart) return;
  if (restart) await cdp.send("Page.stopScreencast", {}, tab.session).catch(() => {});
  tab.casting = true;
  const k = displayScale();
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: FRAME_QUALITY, maxWidth: Math.round(tab.size.width * k), maxHeight: Math.round(tab.size.height * k), everyNthFrame: 2 }, tab.session);
}

async function stopCast(tab) {
  if (!tab.casting) return;
  tab.casting = false;
  await cdp.send("Page.stopScreencast", {}, tab.session).catch(() => {});
}

const info = (t) => ({ id: t.id, url: t.url, title: t.title, loading: t.loading, seq: t.seq, frame: t.frame, size: t.size, owner: t.owner,
  logSeq: t.logSeq, errors: t.errors, recording: t.recording ? { at: t.recording.at, frames: t.recording.frames.length } : null });

// ---- recording: the screencast's frames, joined into a GIF by ImageMagick on stop ----

function recordFrame(tab, bytes) {
  const rec = tab.recording;
  if (rec.frames.length >= RECORD_MAX_FRAMES) return;
  const file = `${String(rec.frames.length).padStart(5, "0")}.jpg`;
  try { writeFileSync(join(rec.dir, file), bytes); rec.frames.push({ file, at: Date.now() }); } catch (e) { log("record frame", e.message); }
}

async function startRecording(tab) {
  if (tab.recording) return tab.recording;
  const dir = join(RECORDINGS, `${tab.id.slice(0, 8)}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  tab.recording = { dir, at: Date.now(), frames: [] };
  await startCast(tab); // the screencast must run even when no herdr tab shows the page
  return tab.recording;
}

// GIF delays are in 1/100 s; the last frame holds for a second.
async function stopRecording(tab) {
  const rec = tab.recording;
  if (!rec) throw new Error("this page is not recording");
  tab.recording = null;
  if (!rec.frames.length) { rmSync(rec.dir, { recursive: true, force: true }); throw new Error("no frames were recorded (nothing changed on the page)"); }
  const args = [];
  rec.frames.forEach((f, i) => {
    const next = rec.frames[i + 1]?.at ?? f.at + 1000;
    args.push("-delay", String(Math.max(2, Math.round((next - f.at) / 10))), f.file);
  });
  const out = `${rec.dir}.gif`;
  await new Promise((ok, fail) => {
    const p = spawn("magick", [...args, "-layers", "Optimize", out], { cwd: rec.dir, windowsHide: true });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", (e) => fail(new Error(`ImageMagick (magick) is needed to save a recording: ${e.message}`)));
    p.on("close", (code) => (code === 0 ? ok() : fail(new Error(`magick exited ${code}: ${err.trim().slice(0, 300)}`))));
  });
  rmSync(rec.dir, { recursive: true, force: true });
  return { path: out, frames: rec.frames.length, seconds: Math.round((Date.now() - rec.at) / 1000) };
}

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

// A symbol's Windows key code: the key it is typed on (US layout). Its character code is wrong:
// "." is 46, which is VK_DELETE, so Chrome deleted instead of typing; "'" is 39 (Right arrow).
const SYMBOL_KEYS = {
  186: ";:", 187: "=+", 188: ",<", 189: "-_", 190: ".>", 191: "/?", 192: "`~", 219: "[{", 220: "\\|", 221: "]}", 222: "'\"",
  48: ")", 49: "!", 50: "@", 51: "#", 52: "$", 53: "%", 54: "^", 55: "&", 56: "*", 57: "(",
};
const SYMBOL_VK = new Map(Object.entries(SYMBOL_KEYS).flatMap(([vk, chars]) => [...chars].map((c) => [c, Number(vk)])));

function keyCode(single) {
  if (/[a-z0-9]/i.test(single)) return single.toUpperCase().charCodeAt(0);
  return SYMBOL_VK.get(single) ?? 0;
}

// modifiers: CDP bits (alt 1, ctrl 2, meta 4, shift 8).
async function pressKey(tab, key, modifiers = 0, text) {
  const k = KEYS[key.toLowerCase()];
  const single = key.length === 1 ? key : null;
  const code = k?.[0] ?? (single ? keyCode(single) : 0);
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
  for (const t of tabs.values()) if (t.casting && !t.recording && Date.now() - t.viewedAt > VIEWER_GONE_MS) await stopCast(t);
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
  // diff: what changed since this page's last snap. Refs are renumbered each snap, so lines are
  // compared without their [n].
  "POST /snap": async ({ id, diff }) => {
    const t = await find(id);
    const snap = await evaluate(t, SNAPSHOT_JS);
    const before = t.lastSnap;
    t.lastSnap = snap.items;
    if (!diff) return snap;
    const bare = (line) => line.replace(/^\[\d+\] /, "");
    const old = new Set((before ?? []).map(bare)), now = new Set(snap.items.map(bare));
    return { ...snap, first: !before, added: snap.items.filter((l) => !old.has(bare(l))), removed: (before ?? []).filter((l) => !now.has(bare(l))) };
  },
  // Console lines, page errors and failed requests after `after` (a log number), oldest first.
  "POST /console": async ({ id, after = 0, errors, clear }) => {
    const t = await find(id);
    if (clear) { t.logs = []; t.errors = 0; }
    const lines = t.logs.filter((l) => l.n > after && (!errors || l.level === "error"));
    return { ...info(t), lines };
  },
  "POST /net": async ({ id, failed }) => {
    const t = await find(id);
    const bad = (r) => (typeof r.status === "number" ? r.status >= 400 : r.status !== null && r.status !== "canceled");
    return { ...info(t), requests: t.net.filter((r) => !failed || bad(r)).map(({ id: _id, ...r }) => r) };
  },
  "POST /record": async ({ id, action }) => {
    const t = await find(id);
    if (action === "start") { const r = await startRecording(t); return { ...info(t), dir: r.dir }; }
    if (action === "stop") return { ...info(t), ...(await stopRecording(t)) };
    return info(t);
  },
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
  setInterval(() => { for (const t of tabs.values()) if (t.casting && !t.recording && Date.now() - t.viewedAt > VIEWER_GONE_MS) stopCast(t); }, 1000);
}

if (process.argv[2] === "serve" && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(DIR, { recursive: true });
  process.on("uncaughtException", (e) => log("uncaught", e.stack ?? e.message));
  serve();
}
