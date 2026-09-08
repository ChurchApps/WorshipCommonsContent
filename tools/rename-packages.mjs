// One-shot (rerunnable): rename every song folder to <slug>-<id> so git and the content
// bucket share one key (README "Layout"). Folders already ending in -<id> are left alone.
// The slug part is whatever the folder was called; nothing is re-slugified, so a folder
// that was hand-named keeps its name. Afterwards: generate → build-catalog → validate.
// Usage: node tools/rename-packages.mjs [--dry]
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { songDirs, readSong, idFromFolder } from "./lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dry = process.argv.includes("--dry");
let renamed = 0, kept = 0, skipped = 0;

for (const { dir, folder, langDir, section } of [...songDirs(ROOT)]) {
  const song = readSong(dir);
  if (!song.id) { console.warn(`skip ${folder}: no id`); skipped++; continue; }
  if (idFromFolder(folder) === song.id) { kept++; continue; }
  const dest = path.join(path.dirname(dir), `${folder}-${song.id}`);
  if (fs.existsSync(dest)) throw new Error(`${dest} already exists`);
  console.log(`${dry ? "would rename" : "rename"} songs/${langDir}/${section}/${folder} → ${path.basename(dest)}`);
  if (!dry) {
    try { fs.renameSync(dir, dest); }
    catch (e) {
      // Windows: a folder with a file open in an editor cannot be renamed. Report and carry on;
      // rerun after closing it — reruns are no-ops for everything already renamed.
      if (e.code !== "EPERM" && e.code !== "EBUSY") throw e;
      console.warn(`LOCKED ${folder}: ${e.code} — close any open file in it and rerun`);
      skipped++;
      continue;
    }
  }
  renamed++;
}
console.log(`rename-packages: renamed ${renamed}, already named ${kept}, locked/skipped ${skipped}`);
if (!dry && renamed) console.log("next: node tools/generate.mjs && node tools/build-catalog.mjs && node tools/validate.mjs");
process.exit(skipped ? 1 : 0);
