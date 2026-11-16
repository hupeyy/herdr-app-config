// Downloads one image for the detail views and prints {file, w, h} as JSON.
// Usage: node fetch-image.mjs <jira|github> <cache-key> <url> <out-dir>
// The token is read here, not passed on the command line, and is sent only to its own service's
// host: a PR body can link an image on any server, and that server must not see the token.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_BYTES = 20 * 1024 * 1024;
const [kind, key, url, outDir] = process.argv.slice(2);
if (!kind || !key || !url || !outDir) { console.error("usage: fetch-image.mjs <jira|github> <key> <url> <out-dir>"); process.exit(2); }

const name = createHash("sha1").update(`${kind}:${key}`).digest("hex").slice(0, 20);

function jiraAuth() {
  const text = readFileSync(join(homedir(), ".config/jiratui/config.yaml"), "utf8");
  const c = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at > 0) c[line.slice(0, at).trim()] = line.slice(at + 1).trim().replace(/^["']|["']$/g, "");
  }
  return { origin: new URL(c.jira_api_base_url).origin, header: `Basic ${Buffer.from(`${c.jira_api_username}:${c.jira_api_token}`).toString("base64")}` };
}

// A repo file shown as an image (blob/<ref>/<path>?raw=true, or raw.githubusercontent.com) is
// private in a private repo: read it through the contents API, which takes the token.
function githubRequest(target) {
  const u = new URL(target);
  let m = u.hostname === "github.com" && /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^/]+)\/(.+)$/.exec(u.pathname);
  if (!m && u.hostname === "raw.githubusercontent.com") m = /^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(u.pathname);
  const token = () => execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  if (m) {
    const [, owner, repo, ref, path] = m;
    return {
      url: `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(decodeURIComponent(ref))}`,
      headers: { Authorization: `bearer ${token()}`, Accept: "application/vnd.github.raw", "User-Agent": "herdr-tasks" },
    };
  }
  if (u.hostname === "api.github.com") return { url: target, headers: { Authorization: `bearer ${token()}`, "User-Agent": "herdr-tasks" } };
  return { url: target, headers: { "User-Agent": "herdr-tasks" } };
}

function request() {
  if (kind === "jira") {
    const auth = jiraAuth();
    // Jira answers with a redirect to its media host; fetch drops Authorization on that cross-origin hop.
    return new URL(url).origin === auth.origin ? { url, headers: { Authorization: auth.header } } : { url, headers: {} };
  }
  return githubRequest(url);
}

// Pixel size from the file header: PNG, GIF, JPEG and WebP. SVG has none (null).
function sizeOf(b) {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { ext: "png", w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length > 10 && b.toString("ascii", 0, 3) === "GIF") return { ext: "gif", w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b.length > 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const chunk = b.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { ext: "webp", w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (chunk === "VP8L") { const n = b.readUInt32LE(21); return { ext: "webp", w: 1 + (n & 0x3fff), h: 1 + ((n >> 14) & 0x3fff) }; }
    return { ext: "webp", w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { ext: "jpg", w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
    return { ext: "jpg", w: null, h: null };
  }
  if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(b.toString("utf8", 0, 400))) return { ext: "svg", w: null, h: null };
  return null;
}

mkdirSync(outDir, { recursive: true });
const done = readdirSync(outDir).find((f) => f.startsWith(`${name}.`) && !f.endsWith(".json"));
if (done && existsSync(join(outDir, `${name}.json`))) {
  process.stdout.write(readFileSync(join(outDir, `${name}.json`), "utf8"));
  process.exit(0);
}

const req = request();
const response = await fetch(req.url, { headers: req.headers, redirect: "follow", signal: AbortSignal.timeout(30000) });
if (!response.ok) { console.error(`HTTP ${response.status}`); process.exit(1); }
const bytes = Buffer.from(await response.arrayBuffer());
if (bytes.length > MAX_BYTES) { console.error(`too large: ${bytes.length} bytes`); process.exit(1); }
const size = sizeOf(bytes);
if (!size) { console.error(`not an image (${response.headers.get("content-type") ?? "no type"})`); process.exit(1); }

const file = `${name}.${size.ext}`;
writeFileSync(join(outDir, file), bytes);
const info = JSON.stringify({ file, w: size.w, h: size.h });
writeFileSync(join(outDir, `${name}.json`), info);
process.stdout.write(info);
