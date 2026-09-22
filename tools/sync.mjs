// Content bucket ⇄ this checkout, as a plain S3 sync. The bucket holds exactly this
// repo's layout (songs/, writers/, licenses/, catalog.json, sources.json,
// themes.json), output/ included — output/ is gitignored, not bucket-ignored.
//
//   node tools/sync.mjs pull [--delete] [--dry]   bucket → checkout (the bucket is the operational master)
//   node tools/sync.mjs push [--delete] [--dry]   checkout → bucket (after generate + build-catalog + validate)
//
// After a pull:  node tools/build-catalog.mjs && node tools/validate.mjs, then commit.
// After a push:  run `yarn commons-up` in the Api against the checkout (the bucket copy of catalog.json is a mirror, nothing reads it).
// --delete removes files on the receiving side that the sending side no longer has;
// it is off by default and should stay off for push unless you mean it.
// Needs the AWS CLI on PATH with credentials. Bucket: WC_CONTENT_BUCKET (default below).
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUCKET = (process.env.WC_CONTENT_BUCKET || "s3://churchapps-content/commons").replace(/\/$/, "");
const DIRS = ["songs", "writers", "licenses", "assets"];
const FILES = ["catalog.json", "sources.json", "themes.json"];
const EXCLUDE = ["*/.abc2xml-*", "*/.abc2xml-*/*", "*.log"];

const [mode, ...flags] = process.argv.slice(2);
if (!["pull", "push"].includes(mode)) {
  console.error("Usage: node tools/sync.mjs pull|push [--delete] [--dry]");
  process.exit(1);
}
const del = flags.includes("--delete"), dry = flags.includes("--dry");

function aws(args) {
  const r = spawnSync("aws", args, { stdio: "inherit", cwd: ROOT, shell: process.platform === "win32" });
  if (r.status !== 0) { console.error(`aws ${args.join(" ")} failed (${r.status})`); process.exit(r.status ?? 1); }
}

for (const d of DIRS) {
  const local = path.join(ROOT, d), remote = `${BUCKET}/${d}`;
  const [from, to] = mode === "pull" ? [remote, local] : [local, remote];
  aws(["s3", "sync", from, to, ...(del ? ["--delete"] : []), ...(dry ? ["--dryrun"] : []), ...EXCLUDE.flatMap(e => ["--exclude", e])]);
}
for (const f of FILES) {
  const local = path.join(ROOT, f), remote = `${BUCKET}/${f}`;
  const [from, to] = mode === "pull" ? [remote, local] : [local, remote];
  aws(["s3", "cp", from, to, ...(dry ? ["--dryrun"] : [])]);
}
console.log(mode === "pull"
  ? "pulled. next: node tools/build-catalog.mjs && node tools/validate.mjs, then commit"
  : "pushed. next: yarn commons-up in the Api (COMMONS_CONTENT_REPO=this checkout)");
