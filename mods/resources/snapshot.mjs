// One snapshot of what each herdr terminal costs: the terminal's process and everything under it
// (shell, agent, dev servers), plus Herdr's own processes. Used by the Resource Manager (this mod)
// and the status bar chip (status-usage); a mod cannot import from another mod's folder.
//   node snapshot.mjs '[{"a":"t2","p":10904}, ...]'
//   -> { at, cores, roots: { t2: { ws, priv, cpu, count } }, herdr: {...}, total: { ws, priv } }
// ws = working set bytes, priv = private bytes, cpu = CPU time so far in 100 ns units (the caller
// turns two snapshots into a percentage).

import { execFileSync } from "node:child_process";
import { cpus } from "node:os";

const HERDR = new Set(["herdr-app.exe", "herdr-core.exe", "hc.exe"]);
const PS = [
  "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false);",
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount,KernelModeTime,UserModeTime |",
  "ForEach-Object { [pscustomobject]@{ i = [int]$_.ProcessId; p = [int]$_.ParentProcessId; n = [string]$_.Name;",
  "w = [int64]$_.WorkingSetSize; v = [int64]$_.PrivatePageCount; c = [int64]$_.KernelModeTime + [int64]$_.UserModeTime } } |",
  "ConvertTo-Json -Compress",
].join(" ");

const roots = JSON.parse(process.argv[2] || "[]");
const procs = JSON.parse(execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", PS], { encoding: "utf8", maxBuffer: 16 << 20 }));
const byId = new Map(procs.map((x) => [x.i, x]));
const kids = new Map();
for (const x of procs) if (x.p !== x.i) kids.set(x.p, [...(kids.get(x.p) ?? []), x]);

const zero = () => ({ ws: 0, priv: 0, cpu: 0, count: 0 });
const add = (sum, x) => { sum.ws += x.w; sum.priv += x.v; sum.cpu += x.c; sum.count += 1; };

// Each terminal's tree. A process is counted once, under the first terminal that reaches it.
const counted = new Set();
const out = { at: Date.now(), cores: cpus().length, roots: {}, herdr: zero(), total: { ws: 0, priv: 0 } };
for (const { a, p } of roots) {
  const sum = zero();
  const stack = byId.has(p) ? [byId.get(p)] : [];
  while (stack.length) {
    const x = stack.pop();
    if (counted.has(x.i)) continue;
    counted.add(x.i);
    add(sum, x);
    stack.push(...(kids.get(x.i) ?? []));
  }
  out.roots[a] = sum;
}
for (const x of procs) if (HERDR.has(x.n.toLowerCase()) && !counted.has(x.i)) { counted.add(x.i); add(out.herdr, x); }
for (const s of [...Object.values(out.roots), out.herdr]) { out.total.ws += s.ws; out.total.priv += s.priv; }
process.stdout.write(JSON.stringify(out));
