// Shared helpers for the WorshipCommonsContent tools. Plain Node ESM, zero dependencies.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// deterministic char(11) id in UniqueIdHelper.shortId's base64url format — must
// match idFor in WorshipCommonsApi/src/seed-data/catalog.ts. Ids are frozen in
// song.json at export time; this is only used to stamp NEW songs.
export const idFor = title => crypto.createHash("sha1").update("wcsong:" + title).digest("base64url").slice(0, 11);

// language name (as stored in song.json "language") → songs/<code>/ dir
export const LANG_CODES = {
  English: "en",
  German: "de",
  Spanish: "es",
  Latin: "la",
  French: "fr",
  Portuguese: "pt",
  Russian: "ru",
  Malayalam: "ml",
  Albanian: "sq",
  Hungarian: "hu",
  Zulu: "zu",
  Swedish: "sv"
};

// folder name from a title: lowercase, apostrophes dropped, other punctuation/space
// runs → "-", diacritics and non-Latin scripts kept. Cosmetic only — identity is song.json id.
export const slugify = title =>
  title.normalize("NFC").toLowerCase()
    .replace(/['’ʼ]/gu, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "untitled";

export const SECTIONS = ["public-domain", "wc-license"];

// lyrics.chordpro = directive header lines, one blank line, body verbatim, one trailing \n.
// The body must roundtrip byte-identical to the DB chordPro column.
export function splitChordpro(text) {
  const lines = text.replace(/\n$/, "").split("\n");
  let i = 0;
  const header = {};
  while (i < lines.length && lines[i].startsWith("{")) {
    const m = lines[i].match(/^\{([^:}]+):\s*(.*)\}$/);
    if (m) header[m[1].trim()] = m[2];
    i++;
  }
  if (lines[i] === "") i++;
  return { header, body: lines.slice(i).join("\n") };
}

export function renderChordpro(song, body) {
  const lines = [];
  const d = (name, v) => { if (v !== null && v !== undefined && v !== "") lines.push(`{${name}: ${v}}`); };
  d("title", song.title);
  d("artist", song.writer);
  d("key", song.key);
  d("time", song.timeSignature);
  d("tempo", song.bpm);
  return lines.join("\n") + "\n\n" + body + "\n";
}

const ASSET_LABELS = {
  text: "Text (lyrics.chordpro)",
  tune: "Tune (tune.mid)",
  abc: "Engraving source (tune.abc)",
  timing: "Lyric timings (timing.json)",
  art: "Cover art (art.webp)"
};

// sources.txt is generated from song.json + sources.json — never hand-edited.
export function renderSourcesTxt(song, sources) {
  const lines = [
    `${song.title} — sources & attribution`,
    "Generated from song.json and the repository's sources.json. Do not edit by hand.",
    ""
  ];
  for (const [asset, label] of Object.entries(ASSET_LABELS)) {
    const key = song.provenance?.[asset];
    if (!key) continue;
    const s = sources[key];
    if (!s) throw new Error(`${song.title}: provenance.${asset} references unknown source "${key}"`);
    let line = `${label}: ${s.name}`;
    if (s.url) line += ` — ${s.url}`;
    if (s.attribution?.required) line += ` (attribution required)`;
    lines.push(line);
  }
  if (song.hymnalCount > 0) lines.push("Hymnal-count metadata: Hymnary.org — https://hymnary.org");
  const pdSource = song.license === "PD" && song.licenseSource ? sources[song.licenseSource] : null;
  if (song.license === "PD" && song.licenseSource && !pdSource) throw new Error(`${song.title}: licenseSource references unknown source "${song.licenseSource}"`);
  lines.push("", song.license === "PD"
    ? `License: Public domain.${pdSource ? ` Public-domain source: ${pdSource.name}.` : ""} See licenses/public-domain.md at the repository root.`
    : "License: The WorshipCommons License, Version 1.0. See licenses/wc-license.md at the repository root.");
  return lines.join("\n") + "\n";
}

// walk <root>/songs/<lang>/<section>/<slug>/ folders; yields { section, langDir, dir, folder }
export function* songDirs(root) {
  const songsRoot = path.join(root, "songs");
  if (!fs.existsSync(songsRoot)) return;
  for (const langDir of fs.readdirSync(songsRoot).filter(d => fs.statSync(path.join(songsRoot, d)).isDirectory()).sort()) {
    for (const section of SECTIONS) {
      const sectionRoot = path.join(songsRoot, langDir, section);
      if (!fs.existsSync(sectionRoot)) continue;
      for (const folder of fs.readdirSync(sectionRoot).filter(d => fs.statSync(path.join(sectionRoot, d)).isDirectory()).sort()) {
        yield { section, langDir, folder, dir: path.join(sectionRoot, folder) };
      }
    }
  }
}

// read <root>/works/<slug>/work.json into a map by slug. A work groups a
// translation family: shared assets (tune.mid/tune.abc/art.webp) live in the
// work folder; member songs point at it via song.json workRef.
export function readWorks(root) {
  const worksRoot = path.join(root, "works");
  const works = new Map();
  if (!fs.existsSync(worksRoot)) return works;
  for (const slug of fs.readdirSync(worksRoot).filter(d => fs.statSync(path.join(worksRoot, d)).isDirectory()).sort()) {
    const dir = path.join(worksRoot, slug);
    works.set(slug, { ...JSON.parse(fs.readFileSync(path.join(dir, "work.json"), "utf8")), dir, folder: slug });
  }
  return works;
}

export const readJson = p => JSON.parse(fs.readFileSync(p, "utf8"));
export const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n");
