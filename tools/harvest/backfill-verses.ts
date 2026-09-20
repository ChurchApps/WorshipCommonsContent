// Retired. The 2026-08 seed-data overlay (verse-expansion.ts from karaoke JSON)
// does not write package lyrics.chordpro, so curated hymns stayed at verse 1.
//
// Package-layout replacement — ABC SATB underlay, chords aligned, first-verse
// match so a borrowed tune cannot donate another hymn's stanzas:
//
//   python tools/harvest/backfill-library-chords.py --expand [--dry-run] [--only slug]
//   node tools/generate.mjs <pkg>
//   node tools/build-catalog.mjs && node tools/validate.mjs
console.error("backfill-verses.ts is retired. Use: python tools/harvest/backfill-library-chords.py --expand");
process.exit(1);
