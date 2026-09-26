// Chord-chart PDF: WinAnsi Courier, else (Cyrillic, Latin Extended, ...) an embedded subset of
// Noto Sans Mono (tools/vendor/fonts: notofonts.github.io unhinted TTF, OFL). Returns null when neither can carry the text —
// scripts that need shaping (Malayalam) and CJK are not in the font.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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
function embedTtf(addObj, font, used) {
  const gids = [...used.keys()].sort((a, b) => a - b);
  const bin = subsetTtf(font, gids).toString("latin1");
  const tag = [...crypto.createHash("sha1").update(font.name + gids.join(",")).digest().subarray(0, 6)].map(b => String.fromCharCode(65 + b % 26)).join("");
  const baseFont = `${tag}+${font.name}`;
  const fileId = addObj(`<< /Length ${bin.length} /Length1 ${bin.length} >>\nstream\n${bin}\nendstream`);
  const descId = addObj(`<< /Type /FontDescriptor /FontName /${baseFont} /Flags 5 /FontBBox [${font.bbox.join(" ")}] /ItalicAngle 0 /Ascent ${font.ascent} /Descent ${font.descent} /CapHeight ${font.ascent} /StemV 80 /FontFile2 ${fileId} 0 R >>`);
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

// Lay out with the first encoder that can carry every string: Courier, else Noto Sans Mono.
function withEncoder(build) {
  for (const make of [() => COURIER, notoMono]) {
    const pdf = build(make());
    if (pdf) return pdf;
  }
  return null;
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
  const [font1, font2] = enc.fonts(addObj);
  const contentIds = pages.map(pageOps => {
    const stream = pageOps.join("\n") + "\n";
    return addObj(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`);
  });
  const pageIds = contentIds.map(cid =>
    addObj(`<< /Type /Page /Parent PAGES /MediaBox [0 0 612 792] /Contents ${cid} 0 R /Resources << /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >> >> >>`));
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
    ops.push(`BT /${font} ${size} Tf 72 ${y} Td ${enc.show(str, font)} Tj ET`);
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
