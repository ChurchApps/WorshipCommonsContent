// Finish publishing what reviewers approved in B1 Admin. An approve writes song.json and sources/ into the
// bucket and nothing else; this builds the rest, locally, and brings the repo up to date.
//
//   node tools/publish-approved.mjs [--dry] [--since <iso>] [--no-commit]
//
// 1. Finds every package whose song.json changed in the bucket since the last run (tools/publish-approved.json,
//    committed by each run). An approve always rewrites song.json, so that is the evidence the bucket copy is the
//    newer one. Nothing else is pulled — never `sync.mjs pull` wholesale.
// 2. Pulls song.json + sources/ of those packages (sources/ with --delete: for an approved package the bucket is
//    the master).
// 3. node tools/generate.mjs <pkg>, then python tools/pack/build.py <pkg> (a no-op without a granted master), then
//    python tools/harvest/align-vocal-timings.py <pkg>: sources/timing.json from the recording's vocals, so Lead
//    Worship waits out the intro (skipped without a master or when the words do not match the singing).
// 4. build-catalog + validate. A failure stops here with nothing uploaded; `git checkout -- songs` undoes the pull.
// 5. Pushes each package's output/ (--delete: output/ is rebuildable by definition), and sources/timing.json with the
//    manifest that lists it.
// 6. The API registers the new files so the site serves them: its 30-minute timer does it for every song approved in
//    the last week, or right away with COMMONS_TOKEN set (POST /commons/admin/sync-output).
// 7. Commits the packages, catalog.json and the new stamp. Does not push the commit.
//
// Needs: the AWS CLI with bucket credentials; python for scores and packs; a checkout whose output/ is complete
// (build-catalog reads every package's output/ — run generate.mjs first on a fresh clone).
// Env: WC_CONTENT_BUCKET (default s3://churchapps-content/commons), COMMONS_API (default
// https://api.churchapps.org/commons), COMMONS_TOKEN — optional server-admin JWT (B1 Admin's CommonsApi token)
// to register the files now instead of on the API's next 30-minute timer.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = path.join(ROOT, "tools", "publish-approved.json");
const BUCKET = (process.env.WC_CONTENT_BUCKET || "s3://churchapps-content/commons").replace(/\/$/, "");
const API = (process.env.COMMONS_API || "https://api.churchapps.org/commons").replace(/\/$/, "");
const TOKEN = process.env.COMMONS_TOKEN || "";
const PYTHON = process.env.PYTHON || "python";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const noCommit = args.includes("--no-commit");
const sinceArg = args.includes("--since") ? args[args.indexOf("--since") + 1] : undefined;

// PYTHONUTF8: the Windows AWS CLI dies on non-ASCII keys without it
const ENV = { ...process.env, PYTHONUTF8: "1" };

function run(cmd, cmdArgs, { capture = false, allowFail = false } = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, env: ENV, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${cmdArgs.join(" ")} failed (${r.status})`);
  return r;
}

// no shell: arguments (keys with spaces, the JMESPath query) reach the CLI verbatim
const aws = (a, opts) => run("aws", a, opts);

/** Package dirs (songs/<lang>/<slug>-<id>) whose bucket song.json is newer than `since`, plus pre-2026-09 ones found. */
function changedPackages(since) {
  const [, bucket, prefix = ""] = BUCKET.match(/^s3:\/\/([^/]+)\/?(.*)$/);
  const pre = prefix ? `${prefix}/` : "";
  const out = aws(["s3api", "list-objects-v2", "--bucket", bucket, "--prefix", `${pre}songs/`, "--query", "Contents[?ends_with(Key, 'song.json')].[Key,LastModified]", "--output", "json"], { capture: true }).stdout;
  const rows = JSON.parse(out || "null") || [];
  const dirs = [], legacy = [];
  for (const [key, modified] of rows) {
    if (new Date(modified) <= since) continue;
    const rel = key.slice(pre.length);
    if (rel.endsWith("/masters/song.json")) legacy.push(rel.replace(/\/masters\/song\.json$/, ""));
    else if (/^songs\/[^/]+\/[^/]+\/song\.json$/.test(rel)) dirs.push(rel.replace(/\/song\.json$/, ""));
  }
  return { dirs: dirs.sort(), legacy };
}

function missingOutput(except) {
  const missing = [];
  for (const lang of fs.readdirSync(path.join(ROOT, "songs"))) {
    for (const folder of fs.readdirSync(path.join(ROOT, "songs", lang))) {
      const dir = `songs/${lang}/${folder}`;
      if (!except.has(dir) && fs.existsSync(path.join(ROOT, dir, "song.json")) && !fs.existsSync(path.join(ROOT, dir, "output", "composition"))) missing.push(dir);
    }
  }
  return missing;
}

async function syncOutput(ids) {
  const results = {};
  for (let i = 0; i < ids.length; i += 20) {
    const res = await fetch(`${API}/admin/sync-output`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ ids: ids.slice(i, i + 20) }) });
    if (!res.ok) throw new Error(`sync-output ${res.status}: ${await res.text()}`);
    Object.assign(results, await res.json());
  }
  return results;
}

async function main() {
  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
  const since = new Date(sinceArg || state.since || 0);
  const startedAt = new Date();

  const dirty = run("git", ["status", "--porcelain", "--", "songs", "catalog.json", "tools/publish-approved.json"], { capture: true }).stdout.trim();
  if (dirty && !dry) throw new Error(`uncommitted changes under songs/ or catalog.json — commit or stash them first:\n${dirty}`);

  const { dirs, legacy } = changedPackages(since);
  console.log(`approved since ${since.toISOString()}: ${dirs.length} package(s)`);
  for (const d of dirs) console.log(`  ${d}`);
  for (const d of legacy) console.warn(`  SKIPPED ${d}: pre-2026-09 layout (masters/). Move it into songs/<lang>/<slug>-<id>/ by hand.`);
  if (dry || !dirs.length) return;

  // ponytail: all-or-nothing on output/ coverage — a partial checkout would commit a catalog.json with null columns
  const missing = missingOutput(new Set(dirs));
  if (missing.length) throw new Error(`${missing.length} package(s) have no output/composition (e.g. ${missing[0]}) — run node tools/generate.mjs first`);

  for (const d of dirs) {
    const local = path.join(ROOT, d);
    fs.mkdirSync(local, { recursive: true });
    aws(["s3", "cp", `${BUCKET}/${d}/song.json`, path.join(local, "song.json"), "--only-show-errors"]);
    aws(["s3", "sync", `${BUCKET}/${d}/sources`, path.join(local, "sources"), "--delete", "--only-show-errors"]);
  }
  for (const d of dirs) {
    run("node", ["tools/generate.mjs", d]);
    // a pack is optional: build.py refuses (and says why) when there is no master or no recording grant
    run(PYTHON, ["tools/pack/build.py", d], { allowFail: true });
    run(PYTHON, ["tools/harvest/align-vocal-timings.py", d], { allowFail: true });
    // again, now that timing.json exists: duration.json takes the recording's length from it instead of an estimate
    run("node", ["tools/generate.mjs", d]);
  }
  run("node", ["tools/build-catalog.mjs"]);
  run("node", ["tools/validate.mjs"]);

  for (const d of dirs) {
    aws(["s3", "sync", path.join(ROOT, d, "output"), `${BUCKET}/${d}/output`, "--delete", "--only-show-errors"]);
    // the one file this job adds to sources/; the manifest row came with it
    if (fs.existsSync(path.join(ROOT, d, "sources", "timing.json")))
      for (const f of ["timing.json", "manifest.json"]) aws(["s3", "cp", path.join(ROOT, d, "sources", f), `${BUCKET}/${d}/sources/${f}`, "--content-type", "application/json", "--only-show-errors"]);
  }
  if (TOKEN) {
    const registered = await syncOutput(dirs.map(d => d.slice(-11)));
    for (const [id, r] of Object.entries(registered)) console.log(`  ${id}: ${r ? `+${r.added} -${r.removed} files` : "no pipeline package in the API — check it by hand"}`);
  } else console.log("output/ pushed; the API registers it within 30 minutes (set COMMONS_TOKEN to do it now)");

  fs.writeFileSync(STATE, JSON.stringify({ since: startedAt.toISOString() }, null, 2) + "\n");
  if (noCommit) return console.log("done; not committed (--no-commit)");
  run("git", ["add", "--", ...dirs, "catalog.json", "tools/publish-approved.json"]);
  const titles = dirs.map(d => JSON.parse(fs.readFileSync(path.join(ROOT, d, "song.json"), "utf8")).title);
  run("git", ["commit", "-q", "-m", `Publish approved: ${titles.join(", ")}`.slice(0, 200), "-m", dirs.join("\n")]);
  console.log("committed. Review with `git show --stat`, then push.");
}

main().catch(e => { console.error(e.message); process.exit(1); });
