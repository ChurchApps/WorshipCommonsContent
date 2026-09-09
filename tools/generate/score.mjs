// masters/score.musicxml from sources/tune.abc, via the vendored abc2xml
// (tools/vendor/abc2xml.py, Wim Vree, LGPL) — the only converter that keeps Open
// Hymnal's four voices on a grand staff and every verse under the melody. music21
// flattens the voices and drops the words, so it is not used.
//
// Open Hymnal SATB is trusted: the conversion is the notes master, catalog
// confidence "proofread-score". MIDI-derived scores still belong in derivatives/.
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

// returns "written" | "promoted" | "unchanged" | "master" | "no-abc" | "skipped" | "failed"
export function scoreFor(dir) {
  const master = path.join(dir, "masters", "score.musicxml");
  const derived = path.join(dir, "derivatives", "score.musicxml");
  const abc = path.join(dir, "sources", "tune.abc");
  const dropDerived = () => { if (fs.existsSync(derived)) fs.unlinkSync(derived); };

  if (fs.existsSync(master)) { dropDerived(); return "master"; }
  // An existing ABC conversion is the master. Leave MIDI-derived scores in derivatives/.
  if (fs.existsSync(derived) && fs.existsSync(abc)) {
    fs.mkdirSync(path.join(dir, "masters"), { recursive: true });
    fs.renameSync(derived, master);
    return "promoted";
  }
  if (!fs.existsSync(abc)) return "no-abc";
  if (!pythonAvailable()) return "skipped";
  fs.mkdirSync(path.join(dir, "masters"), { recursive: true });
  fs.mkdirSync(path.join(dir, "derivatives"), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(dir, "derivatives", ".abc2xml-"));
  try {
    const r = spawnSync(PYTHON, [ABC2XML, "-o", tmp, abc], { encoding: "utf8" });
    const xml = fs.readdirSync(tmp).find(f => f.endsWith(".xml"));
    if (r.status !== 0 || !xml) {
      console.error(`abc2xml failed for ${abc}\n${(r.stderr || r.stdout || "").trim().slice(-400)}`);
      return "failed";
    }
    fs.renameSync(path.join(tmp, xml), master);
    dropDerived();
    return "written";
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
