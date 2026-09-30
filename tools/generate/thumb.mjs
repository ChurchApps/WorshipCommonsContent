// sources/cover.webp from a writer's uploaded art, and the 128px webp thumb from it. Shells out to ffmpeg (already a given here).
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export function writeThumb(cover, dest) {
  if (!cover || !fs.existsSync(cover)) return false;
  if (fs.existsSync(dest) && fs.statSync(dest).mtimeMs >= fs.statSync(cover).mtimeMs) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", cover,
    "-vf", "scale='if(gt(iw,ih),-2,128)':'if(gt(iw,ih),128,-2)'",
    "-c:v", "libwebp", "-quality", "72", dest]);
  return true;
}

// The list and home page load sources/cover.webp for every song with art. An upload arrives as
// sources/art.<ext>: copy a webp as-is, encode anything else (capped at 1600px). The upload stays untouched.
export function writeCover(art, dest) {
  if (!art || fs.existsSync(dest)) return false;
  if (art.endsWith(".webp")) fs.copyFileSync(art, dest);
  else execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", art,
    "-vf", "scale='min(1600,iw)':'min(1600,ih)':force_original_aspect_ratio=decrease",
    "-c:v", "libwebp", "-quality", "85", dest]);
  return true;
}
