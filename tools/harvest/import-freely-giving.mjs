// Harvest original congregational songs listed at https://freely.giving/music
// whose authors dedicated the composition to the public domain (CC0 / copy.church/free).
// Usage: node tools/harvest/import-freely-giving.mjs
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  idFor, packageFolder, ensurePkgDirs, orderSong, splitHarvested, renderChordpro,
  draftForm, splitChordpro, writeJson, writeManifest, sha256File, isoDate
} from "../lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STAGING = path.join(path.dirname(fileURLToPath(import.meta.url)), "staging-freely");
const ACQUIRED = isoDate();

const SONGS = [
  {
    source: "kevin-kwon",
    title: "Run Run Run",
    writer: "Kevin Kwon",
    year: 2020,
    key: "G",
    timeSignature: "4/4",
    themes: "Faith,Mission,Salvation",
    page: "https://www.khmerworship.com/song/kevin-kwon/run-run-run-2973726",
    youtube: { id: "Bdzs0zSQ0lw", title: "Run Run Run [Original]" },
    body: `Verse 1
[G]I once was lost and dry
[C]But Jesus You filled my cup
[Em]Now I am full with love
[C]Thank you Jesus! [Dsus]
I can't believe You would die for me
A wretched sinner all my life
But now forgiven and restored
Thank you Jesus!

Pre-Chorus
[G]And now Jesus I'll follow [Em]You [D]
[G]Because now my old ways are [C]finally through [D]

Chorus
[G]So I'll run, run, run, run to the edge of the
[C]Earth and make Your name an anthem
[Em]I'll shout Your praise forever all of my days
[C]Loving You [D]Jesus

Verse 2
[G]I tried myself and failed
[C]To cover up my scars and shame
[Em]But Your blood has set me free
[C]Thank you Jesus! [Dsus]
But this love I can't hold in
So Lord use me I am Yours
I'll give my all to You
My salvation!

Pre-Chorus
[G]And now Jesus I'll follow [Em]You [D]
[G]Because now my old ways are [C]finally through [D]

Chorus
[G]So I'll run, run, run, run to the edge of the
[C]Earth and make Your name an anthem
[Em]I'll shout Your praise forever all of my days
[C]Loving You [D]Jesus

Chorus
[G]So I'll run, run, run, run to the edge of the
[C]Earth and make Your name an anthem
[Em]I'll shout Your praise forever all of my days
[C]Loving You [D]Jesus

Bridge
[Em]You are stronger
[C]You are greater
[G]Overcomer of all my [Dsus]sin [D]

Bridge
[Em]You are stronger
[C]You are greater
[G]The Overcomer of all my [Dsus]sin [D]

Chorus
[G]So I'll run, run, run, run to the edge of the
[C]Earth and make Your name an anthem
[Em]I'll shout Your praise forever all of my days
[C]Loving You [D]Jesus

Chorus
[G]So I'll run, run, run, run to the edge of the
[C]Earth and make Your name an anthem
[Em]I'll shout Your praise forever all of my days
[C]Loving You [D]Jesus

Outro
[Em]Further and further
[C]Into Your presence Lord
[D]I will run to [G]You`
  },
  {
    source: "kevin-kwon",
    title: "Come Jesus Come",
    writer: "Kevin Kwon",
    year: 2020,
    key: "G",
    timeSignature: "4/4",
    themes: "Hope,Adoration,Cross",
    page: "https://www.khmerworship.com/song/kevin-kwon/come-jesus-come-4768441",
    body: `Verse 1
[G]Bring all your sorrows [C]lift up your head
[Em]For His mercy and love [C]has no end
[G]Beautiful Savior, [C]You conquered death
[Em]And You promised to come [C]back again

Pre-Chorus
[Em]So look to the sky [D]for He's coming back down
[C]For eternity

Chorus
[G]So I'll never stop to give You my [Dsus]praise
[Em]The king of all kings, You know all my [C]ways
[G]So take all my hopes, my dreams they are [Dsus]Yours
[Em]I'll take up my cross, 'cause I need You [C]more
[G]And I want to [B7]see Your [Em]kingdom [D]here [C]
[G]So come Jesus [C]come

Verse 2
[G]I lift up my soul [C]to the One I adore
[Em]My Messiah, Redeemer, [C]and Friend
[G]The grave overcome, [C]I dance and rejoice
[Em]For my God is returning [C]again

Pre-Chorus
[Em]So look to the sky [D]for He's coming back down
[C]For eternity

Chorus
[G]So I'll never stop to give You my [Dsus]praise
[Em]The king of all kings, You know all my [C]ways
[G]So take all my hopes, my dreams they are [Dsus]Yours
[Em]I'll take up my cross, 'cause I need You [C]more
[G]And I want to [B7]see Your [Em]kingdom [D]here [C]
[G]So come Jesus [C]come

Bridge
[Em]Jesus we [G]long for You, [C]come for Your [D]precious [Em]bride
[C]We cannot wait to greet You [Em]face to face, [C]Oh [Dsus]Lord [D]
[Em]Jesus we [G]long for You, [C]come for Your [D]precious [Em]bride
[B7]Woah angels [Em]sing, [C]glorious day we are coming home!`
  },
  {
    source: "kevin-kwon",
    title: "Thank You For My Wife",
    writer: "Kevin Kwon",
    year: 2020,
    key: "E",
    timeSignature: "4/4",
    themes: "Wedding,Grace,Thanksgiving",
    page: "https://www.khmerworship.com/song/kevin-kwon/thank-you-for-my-wife-6444926",
    body: `Verse 1
[E]It's finally here, [A]the day has come
[C#m]A symbol of our [E]glorious Savior's [A]love
[E]I cannot wait [A]to celebrate
[C#m]And run together [E]loving our great [A]God

Chorus
[E]Cuz it's thanks to [A]Him that I can [B]be with you [E]now
[E]And it's by His [A]mercy that you'd [B]even think I'm [E]wow
[C#m]And it's by amazing [A]grace that we can [B]be together [E]now
[F#m]Thank you Lord, my [A]Savior
[B]For the gift that is my [E]wife

Verse 2
[E]It's finally here, [A]the day has come
[C#m]A symbol of our [E]glorious Savior's [A]love
[E]I cannot wait [A]to celebrate
[C#m]And run together [E]loving you [A]Jesus

Chorus
[E]Cuz it's thanks to [A]You that I can [B]be with her [E]now
[E]And it's by Your [A]mercy that she'd [B]even think I'm [E]wow
[C#m]And it's by amazing [A]grace that we can [B]be together [E]now
[F#m]Thank you Lord, my [A]Savior
[B]For the gift that is my [E]wife

Ending
[E]Oh desire of my [A]eyes are you [B]seeing it all [E]now?
[E]Oh the love from our [A]God that has [B]carried us this [E]far
[C#m]And from here on [A]out I'll cherish [B]you until my dying [E]breath
[F#m]I love you
[A]Thank you Jesus [B]for my [E]wife`
  },
  {
    source: "mark-feezell",
    title: "Holy is the Lord",
    writer: "Mark Feezell",
    year: 2003,
    key: "Ab",
    bpm: 68,
    timeSignature: "4/4",
    themes: "Adoration,Praise,Trinity",
    page: "https://drfeezell.com/holy-is-the-lord-2003-choir-and-piano/",
    files: {
      "sheetPdf.pdf": "holy-is-the-lord-choir-piano.pdf",
      "score.musicxml": "holy-is-the-lord-choir-piano.xml"
    },
    fileUrls: {
      "sheetPdf.pdf": "https://drfeezell.com/wp-content/uploads/holy-is-the-lord-choir-piano.pdf",
      "score.musicxml": "https://drfeezell.com/wp-content/uploads/holy-is-the-lord-choir-piano.xml"
    },
    body: `Verse 1
Holy is the Lord who reigns in righteousness.
He alone is worthy. He alone is holy.

Verse 2
Worship the King in His holy place, for He alone is worthy.
Holy is the Lord.

Coda
Praise Him forever. Hallelujah.`
  },
  {
    source: "mark-feezell",
    title: "Hallelujah No. 1",
    writer: "Mark Feezell",
    year: 2004,
    key: "F",
    bpm: 120,
    timeSignature: "7/8",
    themes: "Praise,Adoration",
    page: "https://drfeezell.com/hallelujah-1-2003-choir/",
    files: {
      "sheetPdf.pdf": "hallelujah-no-1-2004-choir.pdf",
      "score.musicxml": "hallelujah-no-1-2004-choir.xml"
    },
    fileUrls: {
      "sheetPdf.pdf": "https://drfeezell.com/wp-content/uploads/halellujah-no-1-2004-choir.pdf",
      "score.musicxml": "https://drfeezell.com/wp-content/uploads/hallelujah-no-1-2004-choir.xml"
    },
    body: `Chorus
Hallelujah, hallelujah,
Hallelujah, hallelujah,
Hallelujah, hallelujah,
Hallelujah.`
  }
];

function writeSong(row) {
  const id = idFor(row.title);
  const folder = packageFolder(row.title, id);
  const dir = path.join(ROOT, "songs", "en", folder);
  ensurePkgDirs(dir);

  const song = {
    id,
    title: row.title,
    writer: row.writer,
    year: row.year,
    language: "English",
    themes: row.themes,
    key: row.key,
    bpm: row.bpm ?? null,
    timeSignature: row.timeSignature,
    scripture: null,
    license: "PD",
    licenseVersion: "CC0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    licenseSource: row.source,
    provenance: { text: row.source, tune: row.source }
  };
  if (row.files?.["sheetPdf.pdf"]) song.uploads = { sheetPdf: "sheetPdf.pdf" };

  const { masters, harvested, provenance } = splitHarvested(song);
  const lyrics = renderChordpro(masters, row.body);
  if (!masters.form) {
    const form = draftForm(splitChordpro(lyrics).body);
    if (form) masters.form = form;
  }
  writeJson(path.join(dir, "song.json"), orderSong(masters));
  fs.writeFileSync(path.join(dir, "sources", "lyrics.chordpro"), lyrics);

  const urls = { "lyrics.chordpro": row.page };
  const notes = {
    "lyrics.chordpro": `Harvested from ${row.page}; writer dedicated the composition to the public domain (CC0 / copy.church/free)`
  };
  const acquired = { "lyrics.chordpro": ACQUIRED };
  const basis = { "lyrics.chordpro": row.source };
  if (row.youtube) {
    writeJson(path.join(dir, "sources", "video.json"), { youtube: row.youtube.id, title: row.youtube.title });
    urls["video.json"] = `https://www.youtube.com/watch?v=${row.youtube.id}`;
    notes["video.json"] = "Writer's own recording. A link, not a ripped master.";
    acquired["video.json"] = ACQUIRED;
    basis["video.json"] = row.source;
  }
  if (row.files) {
    for (const [name, stagingName] of Object.entries(row.files)) {
      const src = path.join(STAGING, stagingName);
      if (!fs.existsSync(src)) throw new Error(`missing staging file ${stagingName}`);
      fs.copyFileSync(src, path.join(dir, "sources", name));
      urls[name] = row.fileUrls[name];
      notes[name] = `Acquired from ${row.fileUrls[name]}`;
      acquired[name] = ACQUIRED;
      basis[name] = row.source;
    }
  }
  if (Object.keys(harvested).length) {
    const src = path.join(dir, "sources");
    fs.mkdirSync(src, { recursive: true });
    writeJson(path.join(src, "hymnary.json"), harvested);
  }
  writeManifest(dir, provenance, { urls, notes, acquired, basis });

  const mp = path.join(dir, "sources", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(mp, "utf8"));
  for (const fileRow of manifest.files) {
    fileRow.obtainedVia = "harvest";
    fileRow.license = "PD";
    fileRow.licenseVersion = "CC0";
    if (fileRow.file === "lyrics.chordpro") fileRow.layer = "text";
    else if (fileRow.file === "score.musicxml" || fileRow.file === "sheetPdf.pdf") fileRow.layer = "arrangement";
    else if (fileRow.file === "video.json") { fileRow.layer = "extra"; delete fileRow.license; }
    else if (fileRow.file === "hymnary.json") { fileRow.obtainedVia = "generated"; delete fileRow.license; }
  }
  writeJson(mp, manifest);
  return folder;
}

let n = 0;
for (const row of SONGS) {
  const folder = writeSong(row);
  console.log(`wrote songs/en/${folder}`);
  n++;
}
console.log(`imported ${n} freely.giving songs; run generate.mjs, build-catalog.mjs, validate.mjs`);
