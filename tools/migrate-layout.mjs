// One-shot: songs/<lang>/<section>/<slug>-<id>/{sources,masters,derivatives}
//        ->  songs/<lang>/<slug>-<id>/{song.json, sources/, output/{composition,stems}}
//
//   node tools/migrate-layout.mjs [--dry-run]
//
// Two rules decide where a file lands:
//   sources/  bytes this package cannot reproduce from its own other files
//   output/   anything generate.mjs or pack/build.py can rebuild on any machine
//
// So lyrics.chordpro and the frozen covers become sources (nothing rebuilds them),
// score.musicxml becomes output (abc2xml rebuilds it from sources/tune.abc), and
// timing.json becomes a source (its generator does not live in this repo) — which
// is what lets .gitignore be a plain **/output/ with no exceptions.
//
// The license folder level is gone: license is mutable metadata and the path is the
// bucket key. Every *Url in catalog.json moves — re-sync the bucket and re-seed.
//
// Safe to re-run: an already-migrated package is skipped.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECTIONS = ["public-domain", "wc-license", "cc-by", "cc-by-sa", "cc-by-nc", "cc-by-nc-sa"];

const readJson = p => JSON.parse(fs.readFileSync(p, "utf8"));
const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n");
const sha256 = async p => {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
};

// file in masters/ or derivatives/ -> where it goes, and (for sources) its manifest row
const MOVES = [
  { from: "masters/song.json", to: "song.json" },
  { from: "masters/lyrics.chordpro", to: "sources/lyrics.chordpro", note: "The words. Nothing in this repo rebuilds them" },
  { from: "masters/cover.webp", to: "sources/cover.webp", basis: "worshipcommons", note: "Generated once by WorshipCommons tooling; kept, never regenerated" },
  { from: "derivatives/timing.json", to: "sources/timing.json", basis: "worshipcommons", note: "Lyric timings; the generator does not live in this repo" },
  { from: "masters/work.json", to: "work.json" },
  { from: "masters/score.musicxml", to: "output/composition/score.musicxml" }
];

function move(dir, dry) {
  const moved = [];
  for (const m of MOVES) {
    const src = path.join(dir, m.from);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(dir, m.to);
    if (!dry) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(src, dest);
    }
    moved.push(m);
  }
  // every other derivative is rebuilt by generate.mjs — drop it rather than move it
  const derivatives = path.join(dir, "derivatives");
  if (fs.existsSync(derivatives) && !dry) fs.rmSync(derivatives, { recursive: true, force: true });
  const masters = path.join(dir, "masters");
  if (fs.existsSync(masters) && !dry) {
    if (fs.readdirSync(masters).length) throw new Error(`${dir}: masters/ still has ${fs.readdirSync(masters).join(", ")}`);
    fs.rmdirSync(masters);
  }
  if (!dry) fs.mkdirSync(path.join(dir, "output", "composition"), { recursive: true });
  return moved;
}

// the files that just arrived in sources/ need manifest rows, or validate rejects them
async function addRows(dir, moved, song) {
  const mp = path.join(dir, "sources", "manifest.json");
  const manifest = fs.existsSync(mp) ? readJson(mp) : { files: [] };
  const have = new Set((manifest.files ?? []).map(r => r.file));
  let added = 0;
  for (const m of moved) {
    if (!m.to.startsWith("sources/")) continue;
    const name = m.to.slice("sources/".length);
    if (have.has(name)) continue;
    manifest.files.push({
      file: name,
      url: null,
      acquired: null,
      sha256: await sha256(path.join(dir, m.to)),
      licenseBasis: m.basis ?? song?.rights?.text?.source ?? song?.licenseSource ?? "contributor",
      original: false,
      submittedBy: null,
      note: m.note ?? null,
      layer: name === "cover.webp" ? "artwork" : name === "lyrics.chordpro" ? "text" : undefined,
      obtainedVia: m.basis === "worshipcommons" ? "generated" : undefined
    });
    added++;
  }
  manifest.files.sort((a, b) => a.file.localeCompare(b.file));
  for (const row of manifest.files) for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
  writeJson(mp, manifest);
  return added;
}

export async function migrate(dry = false) {
  const stats = { songs: 0, rows: 0, already: 0 };
  const songsRoot = path.join(ROOT, "songs");

  for (const lang of fs.readdirSync(songsRoot).filter(d => fs.statSync(path.join(songsRoot, d)).isDirectory()).sort()) {
    const langDir = path.join(songsRoot, lang);
    for (const section of SECTIONS) {
      const sectionDir = path.join(langDir, section);
      if (!fs.existsSync(sectionDir)) continue;
      for (const folder of fs.readdirSync(sectionDir).sort()) {
        const from = path.join(sectionDir, folder);
        if (!fs.statSync(from).isDirectory()) continue;
        const to = path.join(langDir, folder);
        if (fs.existsSync(to)) throw new Error(`${to} already exists — two packages want the same folder`);
        if (!dry) fs.renameSync(from, to);
        const dir = dry ? from : to;
        const song = readJson(path.join(dir, fs.existsSync(path.join(dir, "masters", "song.json")) ? "masters/song.json" : "song.json"));
        const moved = move(dir, dry);
        if (!dry) stats.rows += await addRows(dir, moved, song);
        stats.songs++;
      }
      if (!dry) fs.rmdirSync(sectionDir);
    }
  }

  return stats;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  const dry = process.argv.includes("--dry-run");
  const s = await migrate(dry);
  console.log(`${dry ? "would migrate" : "migrated"}: ${s.songs} songs, ${s.rows} manifest rows added${s.already ? `, ${s.already} already done` : ""}`);
}
