// Sunday-kit derivatives from SATB ABC + ChordPro + MIDI.
//
//   node tools/generate-kit.mjs                  whole library
//   node tools/generate-kit.mjs amazing-grace    one slug
//   node tools/generate-kit.mjs --skip-audio
//
// Writes (gitignored derivatives/, plus masters/lyrics.chordpro for chord backfill):
//   chart-<key>.pdf  stage.pdf  stage-<key>.pdf
//   lead.abc lead.pdf  satb.pdf  soprano.pdf alto.pdf tenor.pdf bass.pdf
//   piano.mp3 organ.mp3 click.mp3
//   assets/pads/<key>.mp3
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  readWorks, readJson, readSong, lyricsPath, parseChordproStanzas, splitChordpro,
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

function keyedPdfs(dir, song, stanzas, notice, kind) {
  const { root, suffix } = splitKey(song.key || "");
  if (!root || !/\[[A-G][#b]?/.test(stanzas.map(s => s.lines.join("\n")).join("\n"))) return { n: 0 };
  let n = 0;
  for (const k of KEY_CHOICES) {
    const shift = shiftFor(song.key, k);
    const useFlats = useFlatsFor(k);
    const stamped = transposeStanzas(stanzas, shift, useFlats);
    const subtitle = [song.writer, `Key of ${k}${suffix}`, song.timeSignature, song.bpm && `${song.bpm} BPM`].filter(Boolean).join(" · ");
    const pdf = kind === "stage"
      ? stagePdf({ title: song.title, subtitle, footer: notice, stanzas: stamped })
      : chartPdf({ title: song.title, subtitle, footer: notice, stanzas: stamped });
    if (!pdf) continue;
    const name = kind === "stage" ? `stage-${keyFile(k)}.pdf` : `chart-${keyFile(k)}.pdf`;
    if (writeIfChanged(path.join(dir, "derivatives", name), pdf)) n++;
  }
  const orig = kind === "stage"
    ? stagePdf({
      title: song.title,
      subtitle: [song.writer, song.key && `Key of ${song.key}`, song.timeSignature, song.bpm && `${song.bpm} BPM`].filter(Boolean).join(" · "),
      footer: notice,
      stanzas
    })
    : null;
  if (orig) writeIfChanged(path.join(dir, "derivatives", "stage.pdf"), orig);
  return { n };
}

async function engravePackage(pkgDir, title, writer, notice, abc, { dropWords = false } = {}) {
  const out = name => path.join(pkgDir, "derivatives", name);
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

  const { songs, works } = resolveTargets(root, arg);
  const stats = { charts: 0, stage: 0, engraved: 0, fail: 0 };

  for (const { dir } of songs) {
    const song = readSong(dir);
    if (song.submittedBy) continue;
    ensurePkgDirs(dir);
    const { body } = splitChordpro(fs.readFileSync(lyricsPath(dir), "utf8"));
    const parsed = parseChordproStanzas(body);
    const notice = licenseNotice(song);
    const c = keyedPdfs(dir, song, parsed, notice, "chart");
    const s = keyedPdfs(dir, song, parsed, notice, "stage");
    stats.charts += c.n;
    stats.stage += s.n;
  }

  if (!flags.skipLeadAbc) {
    console.log("kit: lead.abc");
    py(path.join(root, "tools", "generate", "lead_abc.py"), ["--root", root, ...(arg ? ["--only", arg] : []), ...(flags.force ? ["--force"] : [])]);
  }

  if (!flags.skipEngrave) {
    console.log("kit: engraving ABC → PDF");
    try {
      const workList = works.length ? works : [...readWorks(root).values()].filter(w => !arg || w.folder.includes(arg) || path.basename(w.dir).includes(arg));
      for (const w of workList) {
        const abcFile = path.join(w.dir, "sources", "tune.abc");
        if (!fs.existsSync(abcFile)) continue;
        const abc = fs.readFileSync(abcFile, "utf8");
        const meta = readJson(path.join(w.dir, "masters", "work.json"));
        try {
          await engravePackage(w.dir, meta.title || w.folder, "", "Public domain. Generated from the Open Hymnal SATB setting.", abc);
          stats.engraved++;
        } catch (e) {
          stats.fail++;
          console.error(`engrave work ${w.folder}: ${e.message}`);
        }
      }
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
  console.log(`kit: ${stats.charts} keyed charts, ${stats.stage} stage keys, ${stats.engraved} engraved${stats.fail ? `, ${stats.fail} FAILED` : ""}`);
  return stats.fail ? 1 : 0;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) process.exit(await main());
