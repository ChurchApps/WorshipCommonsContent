// derivatives/score.musicxml from sources/tune.abc (files.md §3.1), via the vendored
// abc2xml (tools/vendor/abc2xml.py, Wim Vree, LGPL) — the only converter that keeps Open
// Hymnal's four voices on a grand staff and every verse under the melody. music21
// flattens the voices and drops the words, so it is not used.
//
// The result is a derivative: rebuildable, gitignored, catalog confidence
// "converted-from-abc". A person promotes it into masters/ by proofreading it.
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

// returns "written" | "unchanged" | "master" | "no-abc" | "failed"
export function scoreFor(dir) {
  if (fs.existsSync(path.join(dir, "masters", "score.musicxml"))) return "master";
  const abc = path.join(dir, "sources", "tune.abc");
  if (!fs.existsSync(abc)) return "no-abc";
  const dest = path.join(dir, "derivatives", "score.musicxml");
  if (fs.existsSync(dest) && fs.statSync(dest).mtimeMs >= fs.statSync(abc).mtimeMs) return "unchanged";
  fs.mkdirSync(path.join(dir, "derivatives"), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(dir, "derivatives", ".abc2xml-"));
  try {
    const r = spawnSync(PYTHON, [ABC2XML, "-o", tmp, abc], { encoding: "utf8" });
    const xml = fs.readdirSync(tmp).find(f => f.endsWith(".xml"));
    if (r.status !== 0 || !xml) {
      console.error(`abc2xml failed for ${abc}\n${(r.stderr || r.stdout || "").trim().slice(-400)}`);
      return "failed";
    }
    fs.renameSync(path.join(tmp, xml), dest);
    return "written";
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
