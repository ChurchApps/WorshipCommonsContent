// Makes 128px art-thumb.webp next to every art.webp (song list covers render at ~44px).
// Run after adding cover art:  node tools/make-thumbs.mjs [--force]
// ponytail: shells out to ffmpeg — swap for sharp only if ffmpeg stops being a given.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const force = process.argv.includes("--force");
const root = path.resolve(import.meta.dirname, "..");

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.name === "node_modules" || e.name.startsWith(".") ? []
    : e.isDirectory() ? walk(path.join(dir, e.name))
      : e.name === "art.webp" ? [path.join(dir, e.name)] : []);

let made = 0;
for (const src of walk(root)) {
  const out = path.join(path.dirname(src), "art-thumb.webp");
  if (!force && fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) continue;
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", src,
    "-vf", "scale='if(gt(iw,ih),-2,128)':'if(gt(iw,ih),128,-2)'",  // short side 128, aspect kept (CSS crops)
    "-c:v", "libwebp", "-quality", "72", out]);
  made++;
}
console.log(`${made} thumbnail(s) written`);
