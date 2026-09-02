import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { songDirs, splitChordpro, readJson, writeJson } from "../lib.mjs";

// Looks up each song on hymnary.org and records the poetic meter of the matching
// text (CSV column `meter`, e.g. 8.7.8.7 D, CM) into song.json. Same search and
// same match rules as import-hymnary-popularity.ts, which reads totalInstances
// out of these rows; hymnal counts already in song.json are left alone.
// Respects the site's 5s crawl-delay. Writes each song.json as it goes and skips songs
// that already carry a meter, so a stopped run resumes cleanly. Named .mts so tsx
// runs it as ESM — this repo has no package.json.
//   tsx tools/harvest/import-hymnary-meter.mts [--dry]
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
const dry = process.argv.includes("--dry");
const UA = { "User-Agent": "WorshipCommons content harvest (jeremy@zongker.net)" };
const DELAY = 5000;

// the forms tools/validate.mjs accepts: syllable counts, optionally doubled, or C/L/S M
export const METER_RE = /^(?:\d{1,2}(?:\.\d{1,2})+(?:[ .]D)?|[CLS]MD?)$/;

/** hymnary meter text → a canonical meter, or null when it is not one we store (Irregular, prose, notes). */
export function normalizeMeter(raw: string): string | null {
  const one = (raw || "").split(";")[0].replace(/\s+/g, " ").trim()
    .replace(/^([CLS])\.\s*M\.?(\s*D\.?)?$/i, (_m, letter: string, dbl: string) => letter.toUpperCase() + "M" + (dbl ? "D" : ""));
  return METER_RE.test(one) ? one : null;
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/['’,¡!¿?()."]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

const cacheDir = path.join(os.tmpdir(), "hymnary-cache");
fs.mkdirSync(cacheDir, { recursive: true });

let blocked = 0;
async function getText(url: string): Promise<string | null> {
  const cf = path.join(cacheDir, url.replace(/^https?:\/\//, "").replace(/[^a-z0-9.-]+/gi, "_"));
  if (fs.existsSync(cf)) return fs.readFileSync(cf, "utf8");
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(90000), headers: UA });
      if (resp.status === 404) return null;
      if (resp.ok) {
        const text = await resp.text();
        fs.writeFileSync(cf, text);
        await new Promise(r => setTimeout(r, DELAY));
        return text;
      }
      if (resp.status === 403 || resp.status === 429) { blocked++; await new Promise(r => setTimeout(r, attempt * 60000)); continue; }
      if (resp.status < 500) return null;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, attempt * 10000));
  }
  return null;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (field || row.length) { row.push(field); rows.push(row); row = []; field = ""; }
      if (c === "\r" && text[i + 1] === "\n") i++;
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// CSV columns: displayTitle,firstLine,textTitle,refrainFirstLine,slug,languages,authors,meter,sources,totalInstances
async function search(qu: string): Promise<string[][]> {
  const csv = await getText(`https://hymnary.org/search?qu=${encodeURIComponent(qu)}&export=csv`);
  // "readings" is a catch-all pseudo-authority whose 3000+ count isn't a real text's
  return csv ? parseCsv(csv).slice(1).filter(r => r.length >= 10 && r[4] !== "readings") : [];
}

// Prefix match either way — hymnary titles carry parenthetical first lines.
const hits = (cand: string, w: string) => !!w && !!cand && (w.length >= 8 ? (cand.startsWith(w) || w.startsWith(cand)) : cand === w);

// A first-line match identifies the actual text; a title-only match is the fallback.
// Within each kind the most-published row wins, the same ranking the count import uses.
function bestMeter(rows: string[][], wantTitle: string, wantFirst: string): string | null {
  let byLine: [number, string] = [0, ""], byTitle: [number, string] = [0, ""];
  for (const r of rows) {
    const n = parseInt(r[9], 10) || 0;
    const meter = normalizeMeter(r[7]);
    if (!meter) continue;
    if (hits(norm(r[1]), wantFirst)) { if (n >= byLine[0]) byLine = [n, meter]; }
    else if ([r[2], r[0], r[1]].some(c => hits(norm(c), wantTitle))) { if (n >= byTitle[0]) byTitle = [n, meter]; }
  }
  return byLine[1] || byTitle[1] || null;
}

let found = 0, checked = 0;
for (const { dir, langDir, section, folder } of songDirs(ROOT)) {
  const songPath = path.join(dir, "song.json");
  const song = readJson(songPath);
  if (song.meter) continue;
  checked++;

  const { body } = splitChordpro(fs.readFileSync(path.join(dir, "lyrics.chordpro"), "utf8"));
  const firstLine = body.split("\n")
    .map((l: string) => l.replace(/\[[^\]]*\]/g, "").trim())
    .find((l: string) => l && !/^(Verse|Chorus|Coro|Refrain|Bridge)/i.test(l)) || "";
  const wantTitle = norm(song.title), wantFirst = norm(firstLine);

  let meter = bestMeter(await search(`in:texts textTitle:"${song.title}"`), wantTitle, wantFirst);
  if (!meter && firstLine) meter = bestMeter(await search(`in:texts textTitle:"${firstLine}"`), wantTitle, wantFirst);
  if (blocked >= 4) { console.error("Blocked by hymnary.org (repeated 403/429) — rerun later; cache resumes where this left off."); process.exit(1); }

  console.log(`  [${(meter || "-").padStart(12)}] ${langDir}/${section}/${folder}`);
  if (!meter) continue;
  found++;
  if (dry) continue;
  // keep meter next to the other musical facts rather than appended at the end
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(song)) { out[k] = v; if (k === "timeSignature") out.meter = meter; }
  if (!("meter" in out)) out.meter = meter;
  writeJson(songPath, out);
}
console.log(`\nFound a meter for ${found}/${checked} songs`);
