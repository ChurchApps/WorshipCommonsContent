// A song's length from its notes, for duration.json when there is no recording or timing.json:
// bars × beats per bar @ bpm, times the passes the lyrics sing through the tune. Plain Node.
//
// The tune is usually one stanza (a hymn: every verse sung under the same notes), so the passes
// come from the lyric stanzas; a MIDI far longer than a score without numbered verses (a Larry Holder
// demo) is a whole performance and is timed as it stands.
import * as fs from "node:fs";
import * as path from "node:path";

const CHORUS = /^(?:chorus|refrain|refrein|refrão|coro|estribillo|kehrvers|ref\b)/i;
const VERSE = /^(?:verse|vers|verso|estrofa|strophe|couplet|stanza)/i;
const ASSUMED_BPM = 100; // a hymn's usual pace, when nothing gives a tempo
const PERFORMANCE = 1.6; // a MIDI this many times the notated tune's length plays more than one pass
const LINE_BEATS = 6; // quarter notes a sung line needs, at least, when the notes are the whole song

// Standard MIDI file: quarter-note length to the last note, tempo map, first time signature
export function readMidi(file) {
  const b = fs.readFileSync(file);
  if (b.length < 14 || b.toString("latin1", 0, 4) !== "MThd") return null;
  const tpb = b.readUInt16BE(12);
  if (tpb & 0x8000) return null; // SMPTE timing: not worth the trouble
  const tempos = [], sigs = [];
  let end = 0, pos = 8 + b.readUInt32BE(4);
  while (pos + 8 <= b.length) {
    const stop = Math.min(b.length, pos + 8 + b.readUInt32BE(pos + 4));
    if (b.toString("latin1", pos, pos + 4) === "MTrk") {
      let p = pos + 8, t = 0, status = 0;
      const vlq = () => { let v = 0, c; do { c = b[p++]; v = v * 128 + (c & 0x7f); } while (c & 0x80 && p < stop); return v; };
      while (p < stop) {
        t += vlq();
        const s = b[p];
        if (s === 0xff) {
          const type = b[p + 1]; p += 2;
          const n = vlq();
          if (type === 0x51 && n >= 3) tempos.push({ t, bpm: 60e6 / b.readUIntBE(p, 3) });
          if (type === 0x58 && n >= 2) sigs.push({ t, num: b[p], den: 2 ** b[p + 1] });
          p += n;
        } else if (s === 0xf0 || s === 0xf7) { p++; p += vlq(); }
        else {
          if (s & 0x80) { status = s; p++; }
          const hi = status >> 4;
          p += hi === 0xc || hi === 0xd ? 1 : 2;
          if (hi === 0x8 || hi === 0x9) end = Math.max(end, t);
        }
      }
    }
    pos = stop;
  }
  tempos.sort((a, c) => a.t - c.t);
  let seconds = 0, at = 0, bpm = 120;
  for (const x of tempos) {
    if (x.t >= end) break;
    seconds += (x.t - at) / tpb * 60 / bpm;
    at = x.t; bpm = x.bpm;
  }
  seconds += (end - at) / tpb * 60 / bpm;
  const sig = sigs.find(x => x.t === 0) || null;
  return { beats: end / tpb, seconds, tempo: tempos.find(x => x.t === 0)?.bpm ?? null, sig };
}

// MusicXML (first part): bars played (a pickup is not a bar; repeats play again, a first ending once),
// the time signature, the notated tempo, and each verse's words run together, for spotting a refrain
export function readScore(file) {
  const x = fs.readFileSync(file, "utf8");
  const part = x.match(/<part\b[\s\S]*?<\/part>/)?.[0] || "";
  let bars = 0, run = 0, firstEnding = false;
  for (const m of part.match(/<measure\b[\s\S]*?<\/measure>/g) || []) {
    if (/<repeat[^>]*direction="forward"/.test(m)) run = 0;
    if (/<ending[^>]*number="1[^"]*"[^>]*type="start"/.test(m) || /<ending[^>]*type="start"[^>]*number="1[^"]*"/.test(m)) firstEnding = true;
    const bar = /^<measure[^>]*implicit="yes"/.test(m) ? 0 : 1;
    bars += bar;
    if (!firstEnding) run += bar;
    if (/<ending[^>]*number="1[^"]*"[^>]*type="(?:stop|discontinue)"/.test(m) || /<ending[^>]*type="(?:stop|discontinue)"[^>]*number="1[^"]*"/.test(m)) firstEnding = false;
    const back = m.match(/<repeat[^>]*direction="backward"[^>]*/);
    if (back) { bars += run * ((Number(back[0].match(/times="(\d+)"/)?.[1]) || 2) - 1); run = 0; }
  }
  const beats = Number(part.match(/<beats>(\d+)<\/beats>/)?.[1]);
  const beatType = Number(part.match(/<beat-type>(\d+)<\/beat-type>/)?.[1]);
  const tempo = Number(x.match(/<sound[^>]*tempo="([\d.]+)"/)?.[1]) || null;
  const words = {};
  for (const [, attrs, body] of part.matchAll(/<lyric\b([^>]*)>([\s\S]*?)<\/lyric>/g)) {
    const n = attrs.match(/number="(\d+)"/)?.[1] || 1;
    words[n] = (words[n] || "") + [...body.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(t => t[1]).join("");
  }
  return { bars, sig: beats && beatType ? { num: beats, den: beatType } : null, tempo, words: Object.values(words).map(letters) };
}

// ABC: the bar lines in the first tune's body (no repeat handling — a last resort before the MIDI)
export function abcBars(file) {
  const body = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const k = body.findIndex(l => /^K:/.test(l));
  let bars = 0;
  for (const l of body.slice(k + 1)) {
    if (/^X:/.test(l)) break;
    if (/^[A-Za-z]:|^%/.test(l)) continue;
    bars += (l.replace(/"[^"]*"|![^!]*!/g, "").match(/:*\|+[\]:]*|\[\|/g) || []).filter((m, i) => i || !/^\|:$/.test(m)).length;
  }
  return bars;
}

const letters = s => s.toLowerCase().replace(/[^\p{L}]/gu, "");
const placeholder = bpm => !bpm || Math.abs(bpm - 120) < 0.01;

// stanzas: [{ label, lines: [sung text] }]. Null when there are no notes to go on.
export function estimateFromNotes(dir, song, stanzas) {
  const src = f => path.join(dir, "sources", f);
  const xml = [src("score.musicxml"), path.join(dir, "output", "composition", "score.musicxml")].find(f => fs.existsSync(f));
  const score = xml ? readScore(xml) : null;
  const midi = fs.existsSync(src("tune.mid")) ? readMidi(src("tune.mid")) : null;
  const abc = !score?.bars && fs.existsSync(src("tune.abc")) ? abcBars(src("tune.abc")) : 0;
  if (!score?.bars && !abc && !midi?.beats) return null;
  const guesses = [];

  // meter: the notes' own time signature before song.json's (often a default 4/4)
  const [n, d] = String(song.timeSignature || "").split("/").map(Number);
  const valid = s => (s?.num > 0 && s?.den > 0 ? s : null); // some MIDIs declare 0/4
  const sig = valid(score?.sig) || valid(midi?.sig) || (n && d ? { num: n, den: d } : null) || (guesses.push("meter"), { num: 4, den: 4 });
  const perBar = sig.num * 4 / sig.den; // quarter notes
  const compound = sig.den === 8 && sig.num % 3 === 0 && sig.num > 3;
  const unit = compound ? 1.5 : sig.den === 2 ? 2 : 1; // quarters in the beat a bpm may count

  // tempo: song.json's bpm, counted in quarters or in the meter's beat (a dotted quarter, a half) — whichever
  // the MIDI/score tempo (always quarters) agrees with. Unchecked, a half-note meter counts halves and the rest
  // quarters: song.json's 6/8 bpm matches the MIDI's quarter tempo in 34 of 39 packages.
  const noted = [midi?.tempo, score?.tempo].find(t => !placeholder(t)) || null;
  let bpm = Number(song.bpm) || null, per = sig.den === 2 ? unit : 1;
  if (bpm) { if (noted && unit !== 1) per = Math.abs(Math.log(bpm / noted)) <= Math.abs(Math.log(bpm * unit / noted)) ? 1 : unit; }
  else if (noted) { bpm = noted; per = 1; }
  else { bpm = ASSUMED_BPM; per = 1; guesses.push("bpm"); }
  const quarterBpm = bpm * per, beatsPerBar = +(perBar / per).toFixed(2);
  const tune = score?.bars ? score.bars * perBar : abc ? abc * perBar : midi.beats;
  const bars = q => Math.round(q / perBar);
  const at = `${beatsPerBar} beats @ ${Math.round(bpm)} bpm${guesses.includes("bpm") ? " (assumed)" : ""}`;

  const sung = stanzas.filter(s => s.lines.length);
  const lineCount = sung.reduce((c, s) => c + s.lines.length, 0);
  // passes: the lyric lines sung ÷ the lines one pass of the tune carries. With verses numbered under the
  // notes (a hymn), a pass is what the first lyric line runs through: verse 1 and any refrain printed with it.
  // Otherwise a tune long enough for every line (LINE_BEATS a line), or with verse 2 in its words, is the whole
  // song; else a pass is verse 1 and a hymn's refrain. A hymn prints its chorus once and sings it after every verse.
  const kind = s => CHORUS.test(s.label || "") ? "chorus" : !s.label || VERSE.test(s.label) ? "verse" : "other";
  const verses = sung.filter(s => kind(s) === "verse"), choruses = sung.filter(s => kind(s) === "chorus");
  const hymn = choruses.length === 1 && verses.length > 1 && sung.every(s => kind(s) !== "other" || /^(?:ending|coda|tag|fin|slot)/i.test(s.label));
  const total = lineCount + (hymn ? (verses.length - 1) * choruses[0].lines.length : 0);
  const whole = beats => beats / total >= LINE_BEATS;
  const streams = score?.words?.filter(Boolean) || [];
  const head = s => letters(s.lines.join(" ")).slice(0, 14);
  let passes = 1, passLines = total;
  if (verses.length) {
    const v = verses[0].lines.length, c = choruses[0]?.lines.length || 0;
    const first = streams[0] || "", found = h => h && first.includes(h);
    if (streams.length > 1 && found(head(verses[0]))) {
      passLines = 0;
      for (const h of new Set(sung.map(head).filter(Boolean))) {
        const printed = sung.filter(s => head(s) === h);
        passLines += Math.min(printed.length, first.split(h).length - 1) * printed[0].lines.length;
      }
    } else if (whole(tune) || (verses[1] && found(head(verses[1])))) passLines = total;
    else {
      passLines = v + (hymn ? c : 0);
      if (c && !(found(head(choruses[0])) || streams.length)) guesses.push("refrain");
    }
    const lens = verses.map(s => s.lines.length);
    passes = Math.max(1, total / passLines);
    if (passes > 1.05 && Math.max(...lens) > 1.5 * Math.min(...lens)) guesses.push("verse lengths");
    if (passes > 20) guesses.push("passes");
  }

  // a whole performance: a MIDI far longer than the notated tune, timed as it plays, rescaled to song.json's tempo —
  // unless the score numbers its verses: then the lyrics say how many passes (an Open Hymnal MIDI may play fewer, or 18)
  if (midi?.beats && tune !== midi.beats && midi.beats > PERFORMANCE * tune && streams.length < 2) {
    const seconds = song.bpm ? midi.beats * 60 / quarterBpm : midi.seconds;
    return { seconds: Math.round(seconds), basis: `estimate: MIDI performance, ${bars(midi.beats)} bars × ${at}`, guesses };
  }

  const p = passLines === total ? "whole song," : Math.abs(passes - Math.round(passes)) < 0.05 ? `${Math.round(passes)} stanza${Math.round(passes) === 1 ? "" : "s"}` : `${passes.toFixed(1)} passes`;
  const source = score?.bars ? "" : abc ? " (abc)" : " (MIDI)";
  return { seconds: Math.round(passes * tune * 60 / quarterBpm), basis: `estimate: ${p}${passLines === total ? "" : " ×"} ${bars(tune)} bars${source} × ${at}`, guesses };
}
