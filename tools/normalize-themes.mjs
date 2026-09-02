// Rewrites every song.json "themes" through the controlled vocabulary in themes.json:
// legacy values map to a canonical value, to several, or are dropped. Idempotent — a
// second run is a no-op. Songs with no themes are left alone; the only themes this adds
// are Kids on the known children's choruses listed in themes.json.
// Usage: node tools/normalize-themes.mjs [--dry-run]
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { songDirs, readJson, writeJson } from "./lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const { themes: VOCAB, synonyms, kidsChoruses } = readJson(path.join(ROOT, "themes.json"));

const canonical = new Set(VOCAB);
const kids = new Set(kidsChoruses);
const unknown = new Map(); // legacy value → count, for values themes.json does not cover
const applied = new Map(); // "from → to" → count
let changed = 0, dropped = 0;

for (const { section, langDir, folder, dir } of songDirs(ROOT)) {
  const file = path.join(dir, "song.json");
  const song = readJson(file);
  const before = song.themes ?? null;
  const out = new Set();

  for (const raw of String(before ?? "").split(",").map(s => s.trim()).filter(Boolean)) {
    if (canonical.has(raw)) { out.add(raw); continue; }
    if (!(raw in synonyms)) { unknown.set(raw, (unknown.get(raw) ?? 0) + 1); out.add(raw); continue; }
    const to = synonyms[raw];
    const list = to === null ? [] : Array.isArray(to) ? to : [to];
    if (!list.length) dropped++;
    const key = `${raw} → ${list.length ? list.join(" + ") : "(dropped)"}`;
    applied.set(key, (applied.get(key) ?? 0) + 1);
    for (const t of list) out.add(t);
  }
  if (kids.has(song.title) && before) out.add("Kids");

  // a song that had no themes stays null — we do not invent themes
  const after = before === null || before === undefined ? before
    : out.size ? [...out].join(",")
    : null;
  if (after === before) continue;
  changed++;
  console.log(`songs/${langDir}/${section}/${folder}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  if (!dryRun) { song.themes = after; writeJson(file, song); }
}

for (const [k, n] of [...applied].sort((a, b) => b[1] - a[1])) console.log(`  ${n.toString().padStart(4)}  ${k}`);
for (const [k, n] of unknown) console.error(`ERROR ${n} song(s) carry "${k}", which themes.json neither lists nor maps`);
console.log(`${changed} song.json rewritten${dryRun ? " (dry run — nothing written)" : ""}, ${dropped} theme values dropped`);
if (unknown.size) process.exit(1);
