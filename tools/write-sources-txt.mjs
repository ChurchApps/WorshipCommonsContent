// (Re)generates every song folder's sources.txt from song.json + sources.json.
// sources.txt is derived data — this script is the only writer of it.
// Usage: node tools/write-sources-txt.mjs
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSourcesTxt, songDirs, readJson } from "./lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sources = readJson(path.join(ROOT, "sources.json"));

let written = 0;
for (const { dir } of songDirs(ROOT)) {
  const song = readJson(path.join(dir, "song.json"));
  if (song.submittedBy) continue; // submissions carry no provenance — no sources.txt
  const text = renderSourcesTxt(song, sources);
  const target = path.join(dir, "sources.txt");
  if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== text) {
    fs.writeFileSync(target, text);
    written++;
  }
}
console.log(`sources.txt: ${written} written/updated`);
