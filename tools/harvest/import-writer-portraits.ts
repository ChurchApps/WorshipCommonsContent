import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { songDirs, readJson, writeJson } from "../lib.mjs";

// Seeds a writer page for every person named in a song.json "writer" credit:
// writers/<slug>/writer.json (+ portrait.jpg when Commons has a public-domain
// image) and a song.json writerRef pointing at it. Composite credits — "A & B",
// "A · tr. C" — are split so each person gets their own page. Bios are the
// article's opening sentences (CC BY-SA, credited on-site); portraits are only
// taken when Commons marks the file public domain / CC0.
// Existing writer folders and existing writerRefs are never overwritten.
// Usage: node tools/harvest/import-writer-portraits.ts [--limit-minutes N]
// Follow with: node tools/build-catalog.mjs && node tools/validate.mjs
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const writersDir = path.join(ROOT, "writers");
const UA = "WorshipCommonsContent/1.0 (https://worshipcommons.org; support@churchapps.org)";
const WIKI = "https://en.wikipedia.org/w/api.php";
const COMMONS = "https://commons.wikimedia.org/w/api.php";
const RATE_MS = 1000; // one request per second, API or image

const limitArg = process.argv.indexOf("--limit-minutes");
const deadline = limitArg > -1 ? Date.now() + Number(process.argv[limitArg + 1]) * 60_000 : Infinity;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let nextCall = 0;
const gate = async () => { await sleep(Math.max(0, nextCall - Date.now())); nextCall = Date.now() + RATE_MS; };
const getJson = async (url: string) => {
  for (let attempt = 0; ; attempt++) {
    await gate();
    const resp = await fetch(url, { headers: { "user-agent": UA } });
    if ((resp.status === 429 || resp.status >= 500) && attempt < 3) { await sleep(5000 * (attempt + 1)); continue; }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json() as any;
  }
};

// letters NFD cannot decompose, so "Michael Weiße" and "Michael Weisse" tokenize alike
const TRANSLIT: Record<string, string> = { "ß": "ss", "ø": "o", "æ": "ae", "œ": "oe", "đ": "d", "ð": "d", "þ": "th", "ł": "l" };
const tokens = (s: string) =>
  s.toLowerCase().replace(/[ßøæœđðþł]/g, c => TRANSLIT[c])
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
const slugFor = (name: string) => tokens(name).join("-");

// A credit is "Author & Author · tr. Translator, Translator"; "·" also introduces
// a tune name ("William C. Dix · Greensleeves"), which the filters below drop.
const cleanName = (s: string) => s
  .replace(/\(.*?\)/g, "")
  .replace(/\s+aka\..*$/i, "")
  .replace(/^\s*(tr\.|attr\.?|after|from)\s+/i, "")
  .replace(/\s+/g, " ").trim().replace(/[.,;:]+$/, "").trim();
const splitPeople = (writer: string) => (writer || "").split(/·|\s+&\s+|,|\s+and\s+/i).map(cleanName).filter(Boolean);

// corpus placeholders and source labels that are not people
const IGNORE = /^(anon|an[oó]n|an[oó]im|traditional|trad\b|unknown|various|attr|tr|arr|adapted?|african[- ]american|spiritual|folk|hymn|psalm|melody|chorale|carol|source|bohemian|basque|dutch|german|latin|welsh|irish|french|silesian|swedish|danish|norwegian|italian|spanish|greek|hebrew|medieval|early|old|ancient)\b/i;
const LATIN_ONLY = /^[\p{Script=Latin}\p{M}\p{Zs}'’.\-]+$/u;

// why a candidate never reaches Wikipedia — reported as skip counts at the end
function localSkip(name: string) {
  if (/[\d�]/.test(name)) return "not-a-name"; // years, mojibake
  if (IGNORE.test(name)) return "ignore-list";
  if (!LATIN_ONLY.test(name)) return "non-latin";
  const parts = name.split(" ");
  if (parts.length < 2 || parts.length > 6) return "not-a-name";
  return null;
}

const PERSONISH = /hymn|compos|pastor|poet/i;
const BIRTH_YEAR = /\([^)]*\b\d{3,4}\b[^)]*\)/;
// an opening like "X (1725-1807) was an English cleric" — list and topic pages fail this
const looksLikePerson = (extract: string) => {
  const intro = extract.slice(0, 240);
  return BIRTH_YEAR.test(intro) || (/\bwas (?:a|an|the)\b/i.test(intro) && PERSONISH.test(extract));
};

// the article title must end in the same surname and share one more given name
// (or its initial) — "Ernest W. Shurtleff" matches "Ernest Warburton Shurtleff",
// "Fanny Crosby" does not match "List of hymns by Fanny Crosby".
function titleMatches(name: string, title: string) {
  if (/^(list of|category:)/i.test(title) || /\(disambiguation\)/i.test(title)) return false;
  const t = tokens(title.replace(/\(.*?\)/g, "")), n = tokens(name);
  if (!t.length || !n.length || t[t.length - 1] !== n[n.length - 1]) return false;
  const given = t.slice(0, -1); // an initial may only stand in for a given name, never the surname
  return n.slice(0, -1).some(w => given.includes(w) || (w.length === 1 && given.some(x => x[0] === w)));
}

// Search the exact credit first, then loosely; take the best-ranked page that
// reads like a person's article. Only Commons-verified PD/CC0 images are kept.
async function lookup(name: string) {
  const PAGE_PROPS = "&prop=extracts|pageimages|pageprops&exintro=1&explaintext=1&exlimit=max&piprop=name&ppprop=disambiguation";
  // the article titled exactly the credit, if there is one — search ranks
  // "William Wordsworth (composer)" above the poet once "hymn" is in the query
  const byTitle = async (title: string) => {
    const q = `${WIKI}?action=query&format=json&formatversion=2&redirects=1&titles=${encodeURIComponent(title)}${PAGE_PROPS}`;
    return ((await getJson(q)).query?.pages || []).filter((p: any) => !p.missing);
  };
  const search = async (term: string) => {
    const q = `${WIKI}?action=query&format=json&formatversion=2&generator=search&gsrlimit=3` +
      `&gsrsearch=${encodeURIComponent(term)}${PAGE_PROPS}`;
    return ((await getJson(q)).query?.pages || []).sort((a: any, b: any) => a.index - b.index);
  };
  // an article titled exactly the credit beats a better-ranked namesake:
  // "William Wordsworth" is the poet, not "William Wordsworth (composer)"
  const exactTitle = tokens(name).join(" ");
  const usable = (pages: any[]) => {
    const ok = pages.filter((p: any) =>
      p.pageprops?.disambiguation === undefined && p.extract && titleMatches(name, p.title) && looksLikePerson(p.extract));
    return ok.find((p: any) => tokens(p.title.replace(/\(.*?\)/g, "")).join(" ") === exactTitle) ?? ok[0];
  };

  // the credit's initials often differ from the article's full given names
  const spelled = name.split(" ").filter(w => w.replace(/\./g, "").length > 1).join(" ");
  const terms = [`"${name}" hymn`];
  if (spelled !== name && spelled.split(" ").length > 1) terms.push(`"${spelled}" hymn`);
  terms.push(`${name} hymn`);

  // a bare-title page is whoever Wikipedia considers the primary topic — take it
  // only when the defining sentence puts them in this corpus's line of work, or
  // "Edward Hopper" the credit becomes Edward Hopper the painter
  const direct = (await byTitle(name)).filter((p: any) => PERSONISH.test((p.extract || "").slice(0, 240)));
  let hit = usable(direct), seen = direct.length;
  for (const term of terms) {
    if (hit) break;
    const pages = await search(term);
    seen += pages.length;
    hit = usable(pages);
  }
  if (!hit) return { skip: seen ? "not-a-person" : "no-article" };

  const found = {
    bio: excerpt(hit.extract),
    article: `https://en.wikipedia.org/wiki/${encodeURI(hit.title.replace(/ /g, "_"))}`,
    thumbUrl: null as string | null,
    license: ""
  };
  if (!hit.pageimage) return found;

  const ii = await getJson(`${COMMONS}?action=query&format=json&formatversion=2&iiurlwidth=330` +
    `&titles=${encodeURIComponent("File:" + hit.pageimage)}&prop=imageinfo&iiprop=extmetadata|url`);
  const info = ii.query?.pages?.[0]?.imageinfo?.[0];
  const license = info?.extmetadata?.LicenseShortName?.value || "";
  if (info?.thumburl && /public domain|^pd|cc0/i.test(license)) { found.thumbUrl = info.thumburl; found.license = license; }
  return found;
}

// prefix-cut at a sentence end, never after an initial like "O." — avoids mangling "O. Cist." etc.
function excerpt(text: string) {
  const t = String(text).replace(/\s+/g, " ").trim();
  if (t.length <= 320) return t;
  const cut = t.slice(0, 320);
  const ends = [...cut.matchAll(/(?<![ .][A-Z])[.!?](?= |$)/g)].map(m => m.index as number);
  return ends.length ? cut.slice(0, ends[ends.length - 1] + 1) : cut.replace(/\s+\S*$/, "") + "…";
}

// ---- collect candidates -------------------------------------------------

const songs = [...songDirs(ROOT)].map(d => ({ file: path.join(d.dir, "song.json"), json: readJson(path.join(d.dir, "song.json")) }));
const linkable = songs.filter(s => !s.json.writerRef && !s.json.submittedBy);
const skips = new Map<string, string>(); // candidate → reason
const candidates = new Map<string, string>(); // lowercased → display name
for (const s of linkable) {
  for (const person of splitPeople(s.json.writer)) {
    const why = localSkip(person);
    if (why) { skips.set(person, why); continue; }
    if (!candidates.has(person.toLowerCase())) candidates.set(person.toLowerCase(), person);
  }
}
console.log(`${songs.length} songs, ${linkable.length} without a writerRef`);
console.log(`${candidates.size} distinct people, ${skips.size} strings skipped locally`);

// ---- resolve ------------------------------------------------------------

const slugs = new Map<string, string>(); // lowercased name → writers/ slug
const byArticle = new Map<string, string>(); // article url → slug, so name variants share one page
let added = 0, portraits = 0, remaining = candidates.size, stopped = false;
for (const [key, name] of candidates) {
  remaining--;
  const slug = slugFor(name);
  const dir = path.join(writersDir, slug);
  if (fs.existsSync(path.join(dir, "writer.json"))) { slugs.set(key, slug); continue; } // already seeded
  if (Date.now() > deadline) { stopped = true; break; }
  try {
    const found = await lookup(name);
    if ("skip" in found) { skips.set(name, found.skip); console.log(`  -- ${name}: ${found.skip}`); continue; }
    if (byArticle.has(found.article)) { // "Philip Nicolai" and "Philipp Nicolai" are one writer
      slugs.set(key, byArticle.get(found.article)!);
      console.log(`  ~~ ${name}: same article as ${byArticle.get(found.article)}`);
      continue;
    }
    fs.mkdirSync(dir, { recursive: true });
    if (found.thumbUrl) {
      await gate();
      const resp = await fetch(found.thumbUrl, { headers: { "user-agent": UA } });
      if (resp.ok) { fs.writeFileSync(path.join(dir, "portrait.jpg"), Buffer.from(await resp.arrayBuffer())); portraits++; }
    }
    writeJson(path.join(dir, "writer.json"), { slug, bio: found.bio, article: found.article });
    slugs.set(key, slug);
    byArticle.set(found.article, slug);
    added++;
    console.log(`  ok ${name} [${found.license || "bio only"}] ${found.article}`);
  } catch (e: any) {
    skips.set(name, "lookup-error");
    console.log(`  !! ${name}: ${e.message}`);
  }
}
if (stopped) console.log(`!! time limit reached — ${remaining + 1} people not looked up`);

// ---- link songs ---------------------------------------------------------

// the first person in the credit who has a writer page wins; a song has one writerRef
let linked = 0;
for (const s of linkable) {
  const person = splitPeople(s.json.writer).map(p => p.toLowerCase()).find(p => slugs.has(p));
  if (!person) continue;
  writeJson(s.file, { ...s.json, writerRef: slugs.get(person) });
  linked++;
}

const byReason: Record<string, number> = {};
for (const reason of skips.values()) byReason[reason] = (byReason[reason] || 0) + 1;
console.log(`\n${added} writers added (${portraits} with a portrait), ${linked} songs newly linked`);
console.log("skipped:", byReason);
