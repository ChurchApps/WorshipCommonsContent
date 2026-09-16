// output/composition/score.musicxml from sources/tune.abc, via the vendored abc2xml
// (tools/vendor/abc2xml.py, Wim Vree, LGPL) — the only converter that keeps Open
// Hymnal's four voices on a grand staff and every verse under the melody. music21
// flattens the voices and drops the words, so it is not used.
//
// The conversion is an output: it rebuilds from sources/tune.abc on any machine.
// A score we were given or that a person proofread lives in sources/ and wins.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ABC2XML = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor", "abc2xml.py");
const PYTHON = process.env.PYTHON || "python";

let pythonOk;
export function pythonAvailable() {
  if (pythonOk === undefined) {
    const r = spawnSync(PYTHON, ["--version"], { encoding: "utf8" });
    pythonOk = r.status === 0;
  }
  return pythonOk;
}

// returns "written" | "unchanged" | "source" | "no-abc" | "skipped" | "failed"
export function scoreFor(dir) {
  const source = path.join(dir, "sources", "score.musicxml");
  const out = path.join(dir, "output", "composition", "score.musicxml");
  const abc = path.join(dir, "sources", "tune.abc");

  // Someone gave us (or proofread) the notes: that is the owner, nothing to build.
  if (fs.existsSync(source)) {
    if (fs.existsSync(out)) fs.unlinkSync(out);
    return "source";
  }
  if (!fs.existsSync(abc)) return "no-abc";
  if (!pythonAvailable()) return "skipped";

  const outDir = path.join(dir, "output", "composition");
  fs.mkdirSync(outDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(outDir, ".abc2xml-"));
  try {
    const r = spawnSync(PYTHON, [ABC2XML, "-o", tmp, abc], { encoding: "utf8" });
    const xml = fs.readdirSync(tmp).find(f => f.endsWith(".xml"));
    if (r.status !== 0 || !xml) {
      console.error(`abc2xml failed for ${abc}
${(r.stderr || r.stdout || "").trim().slice(-400)}`);
      return "failed";
    }
    // byte-compare before replacing: a churned mtime would rebuild the stems pack
    const built = fs.readFileSync(path.join(tmp, xml));
    if (fs.existsSync(out) && fs.readFileSync(out).equals(built)) return "unchanged";
    fs.writeFileSync(out, built);
    return "written";
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const XML2MIDI = path.join(path.dirname(fileURLToPath(import.meta.url)), "xml2midi.py");

// score.mid from whichever score.musicxml owns the notes. Playable in a DAW, and the
// only MIDI we generate: sources/tune.mid is someone else's file, not ours.
// returns "written" | "unchanged" | "no-score" | "skipped" | "failed"
export function midiFor(dir) {
  const source = path.join(dir, "sources", "score.musicxml");
  const built = path.join(dir, "output", "composition", "score.musicxml");
  const abc = path.join(dir, "sources", "tune.abc");
  const xml = fs.existsSync(source) ? source : fs.existsSync(built) ? built : null;
  const dest = path.join(dir, "output", "composition", "score.mid");
  // Stem sketch MIDI is timed to the recording (multi-instrument, intro intact).
  // Flattening it through MusicXML would drop the band and the intro. ABC hymns
  // and a human sources/score.musicxml still go through xml2midi.
  if (!fs.existsSync(source) && !fs.existsSync(abc)) {
    return fs.existsSync(dest) ? "unchanged" : "no-score";
  }
  if (!xml) {
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    return "no-score";
  }
  if (!pythonAvailable()) return "skipped";
  if (fs.existsSync(dest) && fs.statSync(dest).mtimeMs >= fs.statSync(xml).mtimeMs) return "unchanged";
  const r = spawnSync(PYTHON, [XML2MIDI, xml, dest], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`xml2midi failed for ${xml}
${(r.stderr || r.stdout || "").trim().slice(-400)}`);
    return "failed";
  }
  return (r.stdout || "").trim() === "unchanged" ? "unchanged" : "written";
}
