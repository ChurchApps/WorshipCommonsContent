// Sunday-kit outputs from SATB ABC + ChordPro + MIDI.
//
//   node tools/generate-kit.mjs                  whole library
//   node tools/generate-kit.mjs amazing-grace    one slug
//   node tools/generate-kit.mjs --skip-audio
//
// Writes (gitignored output/composition/, plus sources/lyrics.chordpro for chord backfill):
//   chart.pdf  stage.pdf          (original key only — other keys render on demand)
//   lead.abc lead.pdf  satb.pdf  soprano.pdf alto.pdf tenor.pdf bass.pdf
//   piano.mp3 organ.mp3 click.mp3
//   assets/pads/<key>.mp3
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  readJson, readSong, lyricsPath, parseChordproStanzas, splitChordpro,
  licenseNotice, ensurePkgDirs
} from "./lib.mjs";
import { generate as generateBase, resolveTargets } from "./generate.mjs";
import { chartPdf, stagePdf } from "./generate/pdf.mjs";
import { KEY_CHOICES, splitKey, shiftFor, transposeStanzas, useFlatsFor, keyFile } from "./generate/keys.mjs";
import {
  abcVoices, partName, filePart, leadAbc, soloVoice, cleanAbc, titlesMatch, abcTitle, stripLyrics
} from "./generate/abc-kit.mjs";
import { engraveAbc, stopEngraver } from "./generate/engrave.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON = process.env.PYTHON || "python";
const SITE = path.resolve(ROOT, "..", "WorshipCommons");

function writeIfChanged(file, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (fs.existsSync(file) && fs.readFileSync(file).equals(buf)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return true;
}

function py(script, args) {
  const r = spawnSync(PYTHON, [script, ...args], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status) throw new Error(`${path.basename(script)} exited ${r.status}`);
}

// One copy, original key. Every other key is a transposition of this same ChordPro and
// is rendered on demand when a user picks a key — twelve PDFs per song per kind is a
// cache nobody asked for. transposeStanzas/shiftFor do the work at request time.
function originalPdf(dir, song, stanzas, notice, kind) {
  const subtitle = [song.writer, song.key && `Key of ${song.key}`, song.timeSignature,
    song.bpm && `${song.bpm} BPM`].filter(Boolean).join(" · ");
  const pdf = kind === "stage"
    ? stagePdf({ title: song.title, subtitle, footer: notice, stanzas })
    : chartPdf({ title: song.title, subtitle, footer: notice, stanzas });
  if (!pdf) return { n: 0 };
  const name = kind === "stage" ? "stage.pdf" : "chart.pdf";
  return { n: writeIfChanged(path.join(dir, "output", "composition", name), pdf) ? 1 : 0 };
}

// Sweep up the per-key fan-out an older version of this tool wrote.
function dropKeyedPdfs(dir) {
  const out = path.join(dir, "output", "composition");
  if (!fs.existsSync(out)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(out)) {
    if (/^(chart|stage)-.+\.pdf$/.test(f)) { fs.unlinkSync(path.join(out, f)); n++; }
  }
  return n;
}

async function engravePackage(pkgDir, title, writer, notice, abc, { dropWords = false } = {}) {
  const out = name => path.join(pkgDir, "output", "composition", name);
  const voices = abcVoices(abc);
  const footer = notice;
  const sub = [writer, abc.match(/^K:\s*(\S+)/m)?.[1] && `Key of ${abc.match(/^K:\s*(\S+)/m)[1]}`].filter(Boolean).join(" · ");
  const cleaned = cleanAbc(abc);
  const satb = dropWords ? stripLyrics(cleaned) : cleaned;
  await engraveAbc(satb, out("satb.pdf"), { title, subtitle: sub + " · SATB", footer });
  await engraveAbc(satb, out("piano-vocal.pdf"), { title, subtitle: sub + " · piano/vocal", footer });
  for (let i = 0; i < voices.length; i++) {
    const name = partName(i, voices.length);
    const part = dropWords ? stripLyrics(soloVoice(cleaned, voices[i])) : soloVoice(cleaned, voices[i]);
    await engraveAbc(part, out(`${filePart(name)}.pdf`), { title, subtitle: `${sub} · ${name}`, footer });
  }
  const leadPath = out("lead.abc");
  const leadSrc = fs.existsSync(leadPath) ? fs.readFileSync(leadPath, "utf8") : leadAbc(cleaned, { title, dropWords });
  if (!fs.existsSync(leadPath)) writeIfChanged(leadPath, leadSrc);
  await engraveAbc(leadSrc, out("lead.pdf"), { title, subtitle: sub + " · lead sheet", footer });
}

export async function generateKit(root = ROOT, arg, flags = {}) {
  if (!flags.skipBase) generateBase(root, arg);

  if (!flags.skipChords) {
    console.log("kit: chord backfill");
    py(path.join(root, "tools", "harvest", "backfill-library-chords.py"), arg ? ["--only", arg] : []);
  }

  const { songs } = resolveTargets(root, arg);
  const stats = { charts: 0, stage: 0, engraved: 0, dropped: 0, fail: 0 };

  for (const { dir } of songs) {
    const song = readSong(dir);
    if (song.submittedBy) continue;
    ensurePkgDirs(dir);
    const { body } = splitChordpro(fs.readFileSync(lyricsPath(dir), "utf8"));
    const parsed = parseChordproStanzas(body);
    const notice = licenseNotice(song);
    stats.dropped += dropKeyedPdfs(dir);
    stats.charts += originalPdf(dir, song, parsed, notice, "chart").n;
    stats.stage += originalPdf(dir, song, parsed, notice, "stage").n;
  }

  if (!flags.skipLeadAbc) {
    console.log("kit: lead.abc");
    py(path.join(root, "tools", "generate", "lead_abc.py"), ["--root", root, ...(arg ? ["--only", arg] : []), ...(flags.force ? ["--force"] : [])]);
  }

  if (!flags.skipEngrave) {
    console.log("kit: engraving ABC → PDF");
    try {
      for (const { dir } of songs) {
        const song = readSong(dir);
        const abcFile = path.join(dir, "sources", "tune.abc");
        if (!fs.existsSync(abcFile)) continue;
        const abc = fs.readFileSync(abcFile, "utf8");
        const drop = !titlesMatch(song.title, abcTitle(abc));
        try {
          await engravePackage(dir, song.title, song.writer, licenseNotice(song), abc, { dropWords: drop });
          stats.engraved++;
        } catch (e) {
          stats.fail++;
          console.error(`engrave ${song.title}: ${e.message}`);
        }
      }
    } finally {
      await stopEngraver();
    }
  }

  if (!flags.skipAudio) {
    console.log("kit: audio");
    py(path.join(root, "tools", "generate", "audio.py"), [
      "--root", root, "--site", SITE,
      ...(arg ? ["--only", arg] : []),
      ...(flags.skipPads ? ["--skip-pads"] : []),
      ...(flags.force ? ["--force"] : [])
    ]);
  }

  return stats;
}

function parseFlags(argv) {
  const flags = {
    skipAudio: argv.includes("--skip-audio"),
    skipEngrave: argv.includes("--skip-engrave"),
    skipChords: argv.includes("--skip-chords"),
    skipLeadAbc: argv.includes("--skip-lead-abc"),
    skipPads: argv.includes("--skip-pads"),
    skipBase: argv.includes("--skip-base"),
    force: argv.includes("--force")
  };
  const arg = argv.find(a => !a.startsWith("-"));
  return { flags, arg };
}

async function main() {
  const { flags, arg } = parseFlags(process.argv.slice(2));
  const stats = await generateKit(ROOT, arg, flags);
  console.log(`kit: ${stats.charts} charts, ${stats.stage} stage charts, ${stats.engraved} engraved${stats.dropped ? `, ${stats.dropped} stale keyed PDFs removed` : ""}${stats.fail ? `, ${stats.fail} FAILED` : ""}`);
  return stats.fail ? 1 : 0;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) process.exit(await main());
