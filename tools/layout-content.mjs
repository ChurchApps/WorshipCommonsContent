// Lays out catalog.json's files manifest as an S3-shaped content dir
// (songs/<id>/tune.mid etc.) for syncing to a WorshipCommons content bucket,
// or for anyone who wants the assets keyed by song id instead of by folder.
// Usage: node tools/layout-content.mjs <outDir>
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.argv[2];
if (!outDir) {
  console.error("Usage: node tools/layout-content.mjs <outDir>");
  process.exit(1);
}

const { files } = readJson(path.join(ROOT, "catalog.json"));
for (const f of files) {
  const target = path.join(outDir, ...f.key.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(ROOT, ...f.src.split("/")), target);
}
console.log(`Laid out ${files.length} content files in ${outDir}`);
