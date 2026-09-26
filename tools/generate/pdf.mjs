// Chord-chart PDF: WinAnsi Courier, else (Cyrillic, Latin Extended, ...) an embedded subset of
// Noto Sans Mono, else Malayalam shaped by HarfBuzz in Noto Sans Malayalam (tools/vendor/fonts:
// notofonts.github.io unhinted TTF, OFL). The Malayalam step runs tools/generate/shape.py and needs
// python with `pip install uharfbuzz`; without it those charts are skipped with a warning.
// Returns null when no step can carry the text: CJK is not vendored (a CJK font is ~10MB a face).
// Output is deterministic; a Malayalam chart can change with the HarfBuzz version.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chordLyricPair } from "../lib.mjs";

const WINANSI = {
  "\u2018": "'", "\u2019": "'", "\u201C": '"', "\u201D": '"',
  "\u2013": "-", "\u2014": "-", "\u2026": "...", "\u00A0": " ",
  "\u2010": "-", "\u2011": "-", "\u201A": "'", "\u201E": '"', "\u2039": "<", "\u203A": ">",
  "\u200B": "", "\u200E": "", "\u200F": "", "\uFEFF": "",
  // in WinAnsi's 0x80-0x9F block: written as that byte ("Words by … • Music by …" dropped the whole chart.pdf)
  "\u2022": "\x95", "\u2122": "\x99", "\u20AC": "\x80", "\u2020": "\x86", "\u2021": "\x87", "\u2030": "\x89",
  "\u0152": "OE", "\u0153": "oe", "\u0160": "S", "\u0161": "s",
  "\u0178": "Y", "\u017D": "Z", "\u017E": "z",
  "\u0150": "O", "\u0151": "o", "\u0170": "U", "\u0171": "u"
};

function toWinAnsi(s) {
  let out = "";
  for (const ch of String(s ?? "")) {
    if (WINANSI[ch] != null) { out += WINANSI[ch]; continue; }
    const c = ch.codePointAt(0);
    // U+0080-009F are cp1252 bytes misread as Latin-1 (validate warns); the byte is the intended glyph
    if (c < 256) out += ch;
    else return null;
  }
  return out;
}

const pdfEscape = s => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

export { toWinAnsi };

// An encoder turns text into what its fonts can show: encode() is null when they cannot,
// show() writes the string operand for /F1 (regular) or /F2 (bold), fonts() adds those two.
const COURIER = {
  encode: toWinAnsi,
  show: str => `(${pdfEscape(str)})`,
  fonts: addObj => ["Courier", "Courier-Bold"].map(f => addObj(`<< /Type /Font /Subtype /Type1 /BaseFont /${f} /Encoding /WinAnsiEncoding >>`))
};

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor", "fonts");
const ttfCache = {};
function readTtf(name) {
  if (ttfCache[name]) return ttfCache[name];
  const buf = fs.readFileSync(path.join(FONT_DIR, `${name}.ttf`));
  const dir = {};
  for (let i = 0; i < buf.readUInt16BE(4); i++) {
    const o = 12 + 16 * i, at = buf.readUInt32BE(o + 8);
    dir[buf.toString("latin1", o, o + 4)] = buf.subarray(at, at + buf.readUInt32BE(o + 12));
  }
  const { head, cmap: cmapT, loca } = dir;
  const longLoca = head.readInt16BE(50) === 1, nhm = dir.hhea.readUInt16BE(34), scale = 1000 / head.readUInt16BE(18);
  const cmap = new Map(); // format 12 (3,10): every code point the font has
  for (let i = 0; i < cmapT.readUInt16BE(2); i++) {
    const o = 4 + 8 * i;
    if (cmapT.readUInt16BE(o) !== 3 || cmapT.readUInt16BE(o + 2) !== 10) continue;
    const sub = cmapT.readUInt32BE(o + 4);
    for (let n = 0; n < cmapT.readUInt32BE(sub + 12); n++) {
      const q = sub + 16 + 12 * n, lo = cmapT.readUInt32BE(q), hi = cmapT.readUInt32BE(q + 4), gid = cmapT.readUInt32BE(q + 8);
      for (let c = lo; c <= hi; c++) cmap.set(c, gid + c - lo);
    }
  }
  for (let i = 0; !cmap.size && i < cmapT.readUInt16BE(2); i++) { // else format 4 (3,1): a BMP-only font
    const o = 4 + 8 * i;
    if (cmapT.readUInt16BE(o) !== 3 || cmapT.readUInt16BE(o + 2) !== 1) continue;
    const sub = cmapT.readUInt32BE(o + 4), n = cmapT.readUInt16BE(sub + 6) / 2;
    const ends = sub + 14, starts = ends + 2 * n + 2, deltas = starts + 2 * n, ranges = deltas + 2 * n;
    for (let k = 0; k < n; k++) {
      const lo = cmapT.readUInt16BE(starts + 2 * k), hi = cmapT.readUInt16BE(ends + 2 * k);
      const delta = cmapT.readUInt16BE(deltas + 2 * k), ro = cmapT.readUInt16BE(ranges + 2 * k);
      for (let c = lo; c <= hi && c !== 0xFFFF; c++) {
        let g = ro ? cmapT.readUInt16BE(ranges + 2 * k + ro + 2 * (c - lo)) : c;
        if (ro && !g) continue;
        g = (g + delta) & 0xFFFF;
        if (g) cmap.set(c, g);
      }
    }
  }
  return (ttfCache[name] = {
    name, dir, cmap, numGlyphs: dir.maxp.readUInt16BE(4),
    glyph: g => longLoca ? dir.glyf.subarray(loca.readUInt32BE(4 * g), loca.readUInt32BE(4 * g + 4))
      : dir.glyf.subarray(2 * loca.readUInt16BE(2 * g), 2 * loca.readUInt16BE(2 * g + 2)),
    advance: g => Math.round(dir.hmtx.readUInt16BE(4 * Math.min(g, nhm - 1)) * scale),
    bbox: [36, 38, 40, 42].map(o => Math.round(head.readInt16BE(o) * scale)),
    ascent: Math.round(dir.hhea.readInt16BE(4) * scale), descent: Math.round(dir.hhea.readInt16BE(6) * scale)
  });
}

const checksum = b => { let s = 0; for (let i = 0; i < b.length; i += 4) s = (s + b.readUInt32BE(i)) >>> 0; return s; };
const pad4 = b => b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - b.length % 4)]) : b;

// The font with only the used glyphs' outlines (and their composite parts); every other glyph
// is emptied so glyph ids stay the font's own. No cmap/GSUB/GPOS: the PDF addresses glyphs by id.
function subsetTtf(font, gids) {
  const keep = new Set([0, ...gids]);
  for (const stack = [...keep]; stack.length;) {
    const g = font.glyph(stack.pop());
    if (g.length < 10 || g.readInt16BE(0) >= 0) continue;
    for (let o = 10; ;) {
      const flags = g.readUInt16BE(o), part = g.readUInt16BE(o + 2);
      if (!keep.has(part)) { keep.add(part); stack.push(part); }
      o += 4 + (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0);
      if (!(flags & 0x20)) break;
    }
  }
  const loca = Buffer.alloc(4 * (font.numGlyphs + 1)), glyf = [];
  let pos = 0;
  for (let g = 0; g < font.numGlyphs; g++) {
    loca.writeUInt32BE(pos, 4 * g);
    if (!keep.has(g)) continue;
    const data = pad4(font.glyph(g));
    glyf.push(data);
    pos += data.length;
  }
  loca.writeUInt32BE(pos, 4 * font.numGlyphs);
  const head = Buffer.from(font.dir.head);
  head.writeUInt32BE(0, 8);
  head.writeInt16BE(1, 50);
  const post = Buffer.from(font.dir.post.subarray(0, 32));
  post.writeUInt32BE(0x00030000, 0);
  const tables = { "OS/2": font.dir["OS/2"], glyf: Buffer.concat(glyf), head, hhea: font.dir.hhea, hmtx: font.dir.hmtx, loca, maxp: font.dir.maxp, name: font.dir.name, post };
  const tags = Object.keys(tables).sort(), log2 = Math.floor(Math.log2(tags.length));
  const hdr = Buffer.alloc(12 + 16 * tags.length);
  hdr.writeUInt32BE(0x00010000, 0);
  hdr.writeUInt16BE(tags.length, 4);
  hdr.writeUInt16BE(16 << log2, 6);
  hdr.writeUInt16BE(log2, 8);
  hdr.writeUInt16BE(16 * tags.length - (16 << log2), 10);
  let off = hdr.length, headAt = 0;
  const bodies = tags.map((tag, i) => {
    const b = pad4(tables[tag]);
    hdr.write(tag, 12 + 16 * i, "latin1");
    hdr.writeUInt32BE(checksum(b), 16 + 16 * i);
    hdr.writeUInt32BE(off, 20 + 16 * i);
    hdr.writeUInt32BE(tables[tag].length, 24 + 16 * i);
    if (tag === "head") headAt = off;
    off += b.length;
    return b;
  });
  const out = Buffer.concat([hdr, ...bodies]);
  out.writeUInt32BE((0xB1B0AFBA - checksum(out)) >>> 0, headAt + 8);
  return out;
}

const hex4 = n => n.toString(16).toUpperCase().padStart(4, "0");
const utf16Hex = ch => Buffer.from(ch, "utf16le").swap16().toString("hex").toUpperCase();

// Type0 / Identity-H font over a subset TrueType, with a ToUnicode map so the text copies out.
function embedTtf(addObj, font, used, flags = 5) {
  const gids = [...used.keys()].sort((a, b) => a - b);
  const bin = subsetTtf(font, gids).toString("latin1");
  const tag = [...crypto.createHash("sha1").update(font.name + gids.join(",")).digest().subarray(0, 6)].map(b => String.fromCharCode(65 + b % 26)).join("");
  const baseFont = `${tag}+${font.name}`;
  const fileId = addObj(`<< /Length ${bin.length} /Length1 ${bin.length} >>\nstream\n${bin}\nendstream`);
  const descId = addObj(`<< /Type /FontDescriptor /FontName /${baseFont} /Flags ${flags} /FontBBox [${font.bbox.join(" ")}] /ItalicAngle 0 /Ascent ${font.ascent} /Descent ${font.descent} /CapHeight ${font.ascent} /StemV 80 /FontFile2 ${fileId} 0 R >>`);
  const widths = gids.filter(g => font.advance(g) !== 600).map(g => `${g} [${font.advance(g)}]`).join(" ");
  const cidId = addObj(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${baseFont} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descId} 0 R /DW 600 /W [${widths}] /CIDToGIDMap /Identity >>`);
  const bf = [];
  for (let i = 0; i < gids.length; i += 100) {
    const chunk = gids.slice(i, i + 100);
    bf.push(`${chunk.length} beginbfchar\n${chunk.map(g => `<${hex4(g)}> <${utf16Hex(used.get(g))}>`).join("\n")}\nendbfchar\n`);
  }
  const cmap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n" +
    `1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${bf.join("")}endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;
  const toUni = addObj(`<< /Length ${Buffer.byteLength(cmap, "latin1")} >>\nstream\n${cmap}endstream`);
  return addObj(`<< /Type /Font /Subtype /Type0 /BaseFont /${baseFont} /Encoding /Identity-H /DescendantFonts [${cidId} 0 R] /ToUnicode ${toUni} 0 R >>`);
}

function notoMono() {
  const faces = { F1: readTtf("NotoSansMono-Regular"), F2: readTtf("NotoSansMono-Bold") };
  const used = { F1: new Map(), F2: new Map() };
  const has = cp => faces.F1.cmap.has(cp) && faces.F2.cmap.has(cp);
  return {
    encode: s => {
      const str = String(s ?? "").normalize("NFC").replace(/[\u200B\u200E\u200F\uFEFF]/g, "");
      return [...str].every(ch => has(ch.codePointAt(0))) ? str : null;
    },
    show: (str, font) => `<${[...str].map(ch => {
      const g = faces[font].cmap.get(ch.codePointAt(0)) ?? 0;
      if (!used[font].has(g)) used[font].set(g, ch);
      return hex4(g);
    }).join("")}>`,
    fonts: addObj => ["F1", "F2"].map(f => embedTtf(addObj, faces[f], used[f]))
  };
}

// Malayalam: its vowel signs reorder and its consonants join into conjuncts, so a glyph per code
// point is wrong. Malayalam runs are shaped by HarfBuzz (shape.py, `pip install uharfbuzz`) in
// Noto Sans Malayalam (proportional); everything else stays Noto Sans Mono. Chords sit over the
// shaped x of the syllable they precede. A syllable whose glyphs do not map back to its text in
// order carries /ActualText, so it copies out as typed.
const PYTHON = process.env.PYTHON || "python";
const SHAPE_PY = path.join(path.dirname(fileURLToPath(import.meta.url)), "shape.py");
const isMl = cp => (cp >= 0x0D00 && cp <= 0x0D7F) || cp === 0x200C || cp === 0x200D || cp === 0x25CC;
const num = n => String(Math.round(n * 1000) / 1000);
const MAX_WIDTH = 612 - 2 * 72; // points
let shapeWarned = false;

function shaped() {
  const faces = {
    F1: readTtf("NotoSansMono-Regular"), F2: readTtf("NotoSansMono-Bold"),
    F3: readTtf("NotoSansMalayalam-Regular"), F4: readTtf("NotoSansMalayalam-Bold")
  };
  const used = { F1: new Map(), F2: new Map(), F3: new Map(), F4: new Map() };
  const both = (a, b, cp) => faces[a].cmap.has(cp) && faces[b].cmap.has(cp);
  const nominal = {};
  for (const f of ["F3", "F4"]) {
    nominal[f] = new Map();
    for (const [cp, g] of faces[f].cmap) if (!nominal[f].has(g)) nominal[f].set(g, String.fromCodePoint(cp));
  }
  const clean = s => String(s ?? "").normalize("NFC").replace(/[\u200B\u200E\u200F\uFEFF]/g, "");
  // Script runs: Malayalam letters to the Malayalam face; space, digits and punctuation the Malayalam
  // face has go with the run before them (the first run, at the start); the rest to mono.
  // null when a character is in neither face.
  const itemize = str => {
    const cps = [...str].map(ch => ch.codePointAt(0));
    const cls = cps.map(cp => isMl(cp) ? "ml" : both("F3", "F4", cp) ? null : "mono");
    for (let i = 0, prev = cls.find(c => c) || "mono"; i < cls.length; i++) {
      if (!cls[i]) cls[i] = prev === "mono" && !both("F1", "F2", cps[i]) ? "ml" : prev;
      prev = cls[i];
    }
    const runs = [];
    for (let i = 0; i < cps.length; i++) {
      const ml = cls[i] === "ml";
      if (!(ml ? both("F3", "F4", cps[i]) : both("F1", "F2", cps[i]))) return null;
      const last = runs[runs.length - 1];
      if (last && last.ml === ml) last.cps.push(cps[i]);
      else runs.push({ ml, start: i, cps: [cps[i]] });
    }
    return runs;
  };
  const pending = new Map(), results = new Map();
  // one line's glyphs in `font` (F1 regular / F2 bold): [{face, gid, adv, xo, yo, cl}], 1/1000 em
  const layout = (font, str) => {
    const out = [];
    for (const run of itemize(str)) {
      if (!run.ml) {
        run.cps.forEach((cp, i) => {
          const gid = faces[font].cmap.get(cp);
          if (!used[font].has(gid)) used[font].set(gid, String.fromCodePoint(cp));
          out.push({ face: font, gid, adv: faces[font].advance(gid), xo: 0, yo: 0, cl: run.start + i });
        });
        continue;
      }
      const face = font === "F1" ? "F3" : "F4", text = String.fromCodePoint(...run.cps), k = face + "\u0000" + text;
      const glyphs = results.get(k);
      if (!glyphs) { pending.set(k, [face, text]); continue; }
      const starts = [...new Set(glyphs.map(g => g[1]))].sort((a, b) => a - b);
      for (let n = 0; n < glyphs.length;) { // one cluster: a syllable's glyphs, reordered and joined
        const cl = glyphs[n][1], end = starts.find(c => c > cl) ?? run.cps.length, text = String.fromCodePoint(...run.cps.slice(cl, end));
        let m = n;
        while (m < glyphs.length && glyphs[m][1] === cl) m++;
        const cluster = glyphs.slice(n, m).map(([gid, , adv, xo, yo, spells]) => ({ face, gid, adv, xo, yo, spells, cl: run.start + cl }));
        // ToUnicode, first use wins: a code point's own glyph is that code point; a conjunct or joined
        // sign is what shape.py found it spells, else the part of the syllable its neighbours do not
        // already spell, else the whole syllable
        for (const g of cluster) {
          const t = nominal[face].get(g.gid) ?? g.spells;
          if (!used[face].has(g.gid) && t) used[face].set(g.gid, t);
        }
        const fresh = cluster.filter(g => !used[face].has(g.gid));
        if (fresh.length === 1) {
          // glyphs before it spell the start, glyphs after it the end; one drawn out of order (a vowel
          // sign drawn before its consonant) is the last place its text occurs
          const k = cluster.indexOf(fresh[0]), texts = cluster.map(g => used[face].get(g.gid));
          let rest = text;
          const odd = [];
          for (let i = 0; i < k; i++) if (rest.startsWith(texts[i])) rest = rest.slice(texts[i].length); else odd.push(texts[i]);
          for (let i = cluster.length - 1; i > k; i--) if (rest.endsWith(texts[i])) rest = rest.slice(0, -texts[i].length); else odd.push(texts[i]);
          for (const t of odd) { const at = rest.lastIndexOf(t); if (at >= 0) rest = rest.slice(0, at) + rest.slice(at + t.length); }
          used[face].set(fresh[0].gid, rest.replace(/[\u200C\u200D]/g, "") || text);
        } else for (const g of fresh) if (!used[face].has(g.gid)) used[face].set(g.gid, text);
        // /ActualText when its glyphs' ToUnicode strings do not spell the syllable (a vowel sign drawn
        // first, a conjunct glyph first met in another word) or a mark sits on its base (pdftotext
        // orders by x and would move it)
        const texts = cluster.map(g => used[face].get(g.gid)), marked = cluster.length > 1 && cluster.some(g => !g.adv || g.xo || g.yo);
        if (texts.join("") !== text && !marked) {
          // only over the glyphs that differ: MuPDF (1.27) repeats a matching tail when it has one
          let i = 0, j = cluster.length, t = text;
          while (i < j - 1 && t.startsWith(texts[i])) t = t.slice(texts[i++].length);
          while (j - 1 > i && t.endsWith(texts[j - 1])) t = t.slice(0, -texts[--j].length);
          if (t) { cluster[i].actual = t; cluster[j - 1].actualEnd = true; }
        } else if (marked) { // the whole syllable, so a reader that orders by x keeps the mark with its base
          cluster[0].actual = text;
          cluster[cluster.length - 1].actualEnd = true;
        }
        out.push(...cluster);
        n = m;
      }
    }
    return out;
  };
  // TJ with the shaped advances and offsets (a TJ number moves left by n/1000 em), Ts for y offsets
  const showGlyphs = (glyphs, size) => {
    let ops = "", face = null, rise = 0, tj = [];
    const flush = () => { if (tj.length) ops += ` [${tj.join(" ")}] TJ`; tj = []; };
    const adjust = n => {
      if (!n) return;
      if (typeof tj[tj.length - 1] === "number") { tj[tj.length - 1] += n; if (!tj[tj.length - 1]) tj.pop(); }
      else tj.push(n);
    };
    for (const g of glyphs) {
      if (g.face !== face) { flush(); ops += ` /${g.face} ${size} Tf`; face = g.face; }
      if (g.actual) { flush(); ops += ` /Span << /ActualText <FEFF${utf16Hex(g.actual)}> >> BDC`; }
      if (g.yo !== rise) { flush(); rise = g.yo; ops += ` ${num(rise * size / 1000)} Ts`; }
      adjust(-g.xo);
      tj.push(`<${hex4(g.gid)}>`);
      adjust(-(g.adv - faces[g.face].advance(g.gid) - g.xo));
      if (g.actualEnd) { flush(); ops += " EMC"; }
    }
    flush();
    return ops + (rise ? " 0 Ts" : "");
  };
  // x (1/1000 em) where the cluster holding code point i starts in a row of glyphs
  // (a chord after the last word, at code point `end`, sits after it)
  const xAt = (glyphs, end) => {
    const at = [];
    let x = 0;
    for (const g of glyphs) { if (at[g.cl] == null) at[g.cl] = x; x += g.adv; }
    return i => { if (i >= end) return x; for (let j = i; j >= 0; j--) if (at[j] != null) return at[j]; return 0; };
  };
  let collecting = true;
  return {
    encode: s => { const str = clean(s); return itemize(str) ? str : null; },
    // "[A]word [E]more": the lyric, and each chord at the code point it precedes
    chordLine: (line, font, size) => {
      let lyrics = "", last = 0, m;
      const anchors = [], re = /\[([^\]]*)\]/g;
      while ((m = re.exec(line))) {
        lyrics += clean(line.slice(last, m.index));
        const chord = clean(m[1]);
        if (!itemize(chord)) return null;
        if (chord.trim()) anchors.push({ at: [...lyrics].length, chord });
        last = m.index + m[0].length;
      }
      lyrics = (lyrics + clean(line.slice(last))).replace(/\s+$/, "");
      if (!itemize(lyrics)) return null;
      if (collecting) return [{ lyrics, chords: anchors.length ? { anchors, lyrics, font, size } : "" }];
      // a line too wide for the page (a translator's note) wraps at its spaces; a chord goes with the
      // row of the syllable it precedes
      const glyphs = layout(font, lyrics), cps = [...lyrics], isSpace = g => cps[g.cl] === " ", rows = [];
      let row = [], width = 0;
      for (const g of glyphs) {
        row.push(g);
        width += g.adv * size / 1000;
        const cut = row.findLastIndex((h, i) => i && isSpace(h));
        if (width > MAX_WIDTH && cut > 0) {
          rows.push(row.slice(0, cut));
          row = row.slice(cut);
          while (row.length && isSpace(row[0])) row.shift();
          width = row.reduce((w, h) => w + h.adv * size / 1000, 0);
        }
      }
      rows.push(row);
      return rows.map((r, k) => {
        const from = k ? rows[k - 1][rows[k - 1].length - 1].cl + 1 : 0, to = k + 1 < rows.length ? rows[k][r.length - 1].cl + 1 : Infinity;
        const mine = anchors.filter(a => a.at >= from && a.at < to);
        return { lyrics: { glyphs: r }, chords: mine.length ? { anchors: mine, glyphs: r, size, end: cps.length } : "" };
      });
    },
    op: (font, size, y, value) => {
      if (value.anchors) { // chords over a lyric row; a chord never starts before the last one ends + a space
        const at = value.glyphs ? xAt(value.glyphs, value.end) : xAt(layout(value.font, value.lyrics), Infinity);
        const space = faces[font].advance(faces[font].cmap.get(32)) * size / 1000;
        let ops = "", x = 0, prevEnd = -Infinity;
        for (const { at: i, chord } of value.anchors) {
          const glyphs = layout(font, chord);
          const cx = Math.max(at(i) * value.size / 1000, prevEnd + space);
          ops += ` ${num(cx - x)} 0 Td${showGlyphs(glyphs, size)}`;
          x = cx;
          prevEnd = cx + glyphs.reduce((w, g) => w + g.adv, 0) * size / 1000;
        }
        return collecting ? "" : `BT 72 ${y} Td${ops} ET`;
      }
      const glyphs = value.glyphs || layout(font, value);
      if (collecting || !glyphs.length) return "";
      return `BT 72 ${y} Td${showGlyphs(glyphs, size)} ET`;
    },
    shapeAll: () => {
      collecting = false;
      if (!pending.size) return true;
      const fonts = { F3: path.join(FONT_DIR, "NotoSansMalayalam-Regular.ttf"), F4: path.join(FONT_DIR, "NotoSansMalayalam-Bold.ttf") };
      const r = spawnSync(PYTHON, [SHAPE_PY], { input: JSON.stringify({ fonts, runs: [...pending.values()] }), encoding: "utf8", maxBuffer: 64 << 20 });
      if (r.status !== 0) {
        if (!shapeWarned) console.warn(`chart.pdf: ${r.status === 3 ? "uharfbuzz not installed (pip install uharfbuzz)" : `shape.py failed: ${r.error?.message || r.stderr}`}; Malayalam charts skipped`);
        shapeWarned = true;
        return false;
      }
      const keys = [...pending.keys()];
      JSON.parse(r.stdout).forEach((glyphs, i) => results.set(keys[i], glyphs));
      return true;
    },
    // an unused face is left out of the file (its /Fn is never drawn)
    fonts: addObj => ["F1", "F2", "F3", "F4"].map(f => used[f].size ? embedTtf(addObj, faces[f], used[f], f === "F3" || f === "F4" ? 4 : 5) : null)
  };
}

// Lay out with the first encoder that can carry every string: Courier, else Noto Sans Mono,
// else HarfBuzz-shaped Noto Sans Malayalam. The shaped one lays out twice: the first pass only
// collects the runs, so python runs once per PDF.
function withEncoder(build) {
  for (const make of [() => COURIER, notoMono]) {
    const pdf = build(make());
    if (pdf) return pdf;
  }
  const enc = shaped();
  if (build(enc) == null || !enc.shapeAll()) return null;
  return build(enc);
}

export function chartPdf({ title, subtitle, footer, stanzas }) {
  return withEncoder(enc => {
    const tTitle = enc.encode(title), tSub = enc.encode(subtitle), tFoot = enc.encode(footer);
    if (tTitle == null || tSub == null || tFoot == null) return null;
    const blocks = [];
    for (const st of stanzas) {
      const label = enc.encode(st.label || "");
      if (label == null) return null;
      const lines = [];
      for (const line of st.lines) {
        if (enc.chordLine) {
          const l = enc.chordLine(line, "F1", 11);
          if (!l) return null;
          lines.push(...l);
          continue;
        }
        const pair = chordLyricPair(line);
        const chords = enc.encode(pair.chords), lyrics = enc.encode(pair.lyrics);
        if (chords == null || lyrics == null) return null;
        lines.push({ chords, lyrics });
      }
      blocks.push({ label, lines });
    }
    const pages = paginateText(({ text }) => {
      text("F2", 16, tTitle, 18);
      text("F1", 10, tSub, 16);
      for (const block of blocks) {
        text("F2", 9, block.label.toUpperCase(), 16);
        for (const line of block.lines) {
          if (line.chords) text("F2", 8, line.chords, 10);
          text("F1", 11, line.lyrics || " ", line.chords ? 11 : 13);
        }
      }
      text("F1", 8, tFoot, 24);
    }, enc);
    return assemblePdf(pages, enc);
  });
}

function assemblePdf(pages, enc = COURIER) {
  const objs = [];
  const addObj = s => { objs.push(s); return objs.length; };
  const fontIds = enc.fonts(addObj);
  const contentIds = pages.map(pageOps => {
    const stream = pageOps.join("\n") + "\n";
    return addObj(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`);
  });
  const pageIds = contentIds.map(cid =>
    addObj(`<< /Type /Page /Parent PAGES /MediaBox [0 0 612 792] /Contents ${cid} 0 R /Resources << /Font << ${fontIds.map((id, i) => id && `/F${i + 1} ${id} 0 R`).filter(Boolean).join(" ")} >> >> >>`));
  const pagesId = addObj(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
  const catalogId = addObj(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const body = objs.map(s => s.includes("/Parent PAGES") ? s.replace("/Parent PAGES", `/Parent ${pagesId} 0 R`) : s);

  let out = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < body.length; i++) {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${body.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= body.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer << /Size ${body.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

function paginateText(draw, enc = COURIER) {
  const pages = [];
  let ops = [];
  let y = 720;
  const flush = () => { if (ops.length) pages.push(ops); ops = []; y = 720; };
  const text = (font, size, str, gap) => {
    if (y - gap < 56) flush();
    y -= gap;
    if (enc.op) { const op = enc.op(font, size, y, str); if (op) ops.push(op); }
    else ops.push(`BT /${font} ${size} Tf 72 ${y} Td ${enc.show(str, font)} Tj ET`);
  };
  draw({ text, y: () => y });
  flush();
  return pages;
}

/** Compact stage chart: section label + unique consecutive chords, no lyric underlay. */
export function stagePdf({ title, subtitle, footer, stanzas }) {
  return withEncoder(enc => {
    const tTitle = enc.encode(title), tSub = enc.encode(subtitle), tFoot = enc.encode(footer);
    if (tTitle == null || tSub == null || tFoot == null) return null;
    const rows = [];
    for (const st of stanzas) {
      const label = enc.encode(st.label || "");
      if (label == null) return null;
      const seq = [];
      for (const line of st.lines) {
        for (const m of String(line).matchAll(/\[([^\]]+)\]/g)) {
          const c = enc.encode(m[1]);
          if (c == null) return null;
          if (seq[seq.length - 1] !== c) seq.push(c);
        }
      }
      rows.push({ label, chords: seq.join("  ") });
    }
    const pages = paginateText(({ text }) => {
      text("F2", 16, tTitle, 18);
      text("F1", 10, tSub, 16);
      text("F1", 9, "STAGE CHART", 14);
      for (const row of rows) {
        text("F2", 10, row.label.toUpperCase(), 16);
        text("F2", 12, row.chords || "(no chords)", 14);
      }
      text("F1", 8, tFoot, 24);
    }, enc);
    return assemblePdf(pages, enc);
  });
}
