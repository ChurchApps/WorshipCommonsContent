// Score step only: output/composition/score.musicxml from sources/tune.abc. A score in
// sources/ wins and is left alone. Promotes nothing; the old note about promoting an existing
// ABC conversion without python; a missing master still needs python 3 (or PYTHON=...).
// `node tools/generate.mjs` already runs this step.
// Usage: node tools/generate-scores.mjs [folder]
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveTargets } from "./generate.mjs";
import { scoreFor, pythonAvailable } from "./generate/score.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export function generateScores(root = ROOT, arg) {
  const { songs } = resolveTargets(root, arg);
  const stats = { written: 0, promoted: 0, unchanged: 0, master: 0, "no-abc": 0, skipped: 0, failed: 0 };
  for (const { dir } of songs) stats[scoreFor(dir)]++;
  return stats;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  const stats = generateScores(ROOT, process.argv[2]);
  console.log(`generate-scores: written ${stats.written}, promoted ${stats.promoted}, unchanged ${stats.unchanged}, already master ${stats.master}, no abc ${stats["no-abc"]}, skipped ${stats.skipped}, failed ${stats.failed}`);
  if (stats.skipped && !pythonAvailable()) console.warn("generate-scores: python not found — ABC files with no score yet were skipped (set PYTHON=...)");
  console.log("next: node tools/build-catalog.mjs && node tools/validate.mjs");
  process.exit(stats.failed ? 1 : 0);
}
