// Disk use of the git worktrees the dev workspaces work in (the Resource Manager's Space card).
// A worktree with node_modules holds 100k+ files, past herdr's 30 s exec limit, so the scan runs
// detached and writes its progress to ~/.cache/herdr-app/disk.json, which the panel reads.
//   node disk.mjs start '["C:\\...\\worktrees\\RP_M3\\m3-api-lockdown", ...]'   starts a scan
//   -> disk.json { at, running, done, total, folders: { path: { bytes, files, top: [{ name, bytes }], at } } }
// Symlinks and junctions are not followed: a worktree that borrows node_modules through a junction
// would otherwise count the base checkout's files.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { opendir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const DIR = join(homedir(), ".cache", "herdr-app");
const OUT = join(DIR, "disk.json");
const TOP = 6; // biggest top-level entries kept per worktree, for Review

const read = () => { try { return JSON.parse(readFileSync(OUT, "utf8")); } catch { return { folders: {} }; } };
function write(state) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${OUT}.tmp`, JSON.stringify(state));
  renameSync(`${OUT}.tmp`, OUT);
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Bytes and files under one folder, without following links.
async function sizeOf(path) {
  let bytes = 0, files = 0;
  const stack = [path];
  while (stack.length) {
    const dir = stack.pop();
    let handle;
    try { handle = await opendir(dir); } catch { continue; }
    for await (const entry of handle) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { stack.push(full); continue; }
      try { bytes += (await lstat(full)).size; files += 1; } catch {}
    }
  }
  return { bytes, files };
}

async function scan(folders) {
  const state = read();
  Object.assign(state, { at: Date.now(), running: true, pid: process.pid, done: 0, total: folders.length });
  write(state);
  for (const folder of folders) {
    const top = [];
    let bytes = 0, files = 0;
    try {
      for await (const entry of await opendir(folder)) {
        if (entry.isSymbolicLink()) continue;
        const full = join(folder, entry.name);
        const part = entry.isDirectory() ? await sizeOf(full) : { bytes: (await lstat(full).catch(() => ({ size: 0 }))).size, files: 1 };
        bytes += part.bytes; files += part.files;
        top.push({ name: entry.name, bytes: part.bytes });
      }
    } catch {}
    top.sort((a, b) => b.bytes - a.bytes);
    state.folders[folder] = { bytes, files, top: top.slice(0, TOP), at: Date.now() };
    state.done += 1;
    write(state);
  }
  // Worktrees deleted since an earlier scan drop out.
  for (const path of Object.keys(state.folders)) if (!existsSync(path)) delete state.folders[path];
  Object.assign(state, { running: false, pid: null, at: Date.now() });
  write(state);
}

const [mode, arg] = process.argv.slice(2);
if (mode === "start") {
  const state = read();
  if (state.running && state.pid && alive(state.pid)) process.stdout.write(JSON.stringify({ started: false, running: true }));
  else {
    const child = spawn(process.execPath, [process.argv[1], "run", arg ?? "[]"], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    process.stdout.write(JSON.stringify({ started: true }));
  }
} else if (mode === "run") {
  await scan(JSON.parse(arg ?? "[]"));
}
