// 128px webp thumb from sources/cover.webp. Shells out to ffmpeg (already a given here).
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
