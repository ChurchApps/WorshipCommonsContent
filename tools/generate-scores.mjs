// Score step only: derivatives/score.musicxml from sources/tune.abc for every package
// that has no proofread master. `node tools/generate.mjs` already runs this step; this
// command exists for re-running just the scores. Needs python 3 on PATH (or PYTHON=...).
// Usage: node tools/generate-scores.mjs [folder]
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveTargets } from "./generate.mjs";
import { scoreFor, pythonAvailable } from "./generate/score.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export function generateScores(root = ROOT, arg) {
  if (!pythonAvailable()) throw new Error("python not found (set PYTHON=...); the score step needs it");
  const { songs, works } = resolveTargets(root, arg);
  const stats = { written: 0, unchanged: 0, master: 0, "no-abc": 0, failed: 0 };
  for (const { dir } of [...songs, ...works]) stats[scoreFor(dir)]++;
  return stats;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  const stats = generateScores(ROOT, process.argv[2]);
  console.log(`generate-scores: written ${stats.written}, unchanged ${stats.unchanged}, already master ${stats.master}, no abc ${stats["no-abc"]}, failed ${stats.failed}`);
  console.log("next: node tools/build-catalog.mjs && node tools/validate.mjs");
  process.exit(stats.failed ? 1 : 0);
}
