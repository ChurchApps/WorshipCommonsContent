// WinAnsi Courier chord-chart PDF. Returns null when the text cannot encode.
import { chordLyricPair } from "../lib.mjs";

const WINANSI = {
  "\u2018": "'", "\u2019": "'", "\u201C": '"', "\u201D": '"',
  "\u2013": "-", "\u2014": "-", "\u2026": "...", "\u00A0": " ",
  "\u0152": "OE", "\u0153": "oe", "\u0160": "S", "\u0161": "s",
  "\u0178": "Y", "\u017D": "Z", "\u017E": "z",
  "\u0150": "O", "\u0151": "o", "\u0170": "U", "\u0171": "u"
};

function toWinAnsi(s) {
  let out = "";
  for (const ch of String(s ?? "")) {
    if (WINANSI[ch]) { out += WINANSI[ch]; continue; }
    const c = ch.codePointAt(0);
    if (c < 128 || (c >= 160 && c <= 255)) out += ch;
    else return null;
  }
  return out;
}

const pdfEscape = s => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

export { toWinAnsi };

export function chartPdf({ title, subtitle, footer, stanzas }) {
  const tTitle = toWinAnsi(title), tSub = toWinAnsi(subtitle), tFoot = toWinAnsi(footer);
  if (tTitle == null || tSub == null || tFoot == null) return null;
  const blocks = [];
  for (const st of stanzas) {
    const label = toWinAnsi(st.label || "");
    if (label == null) return null;
    const lines = [];
    for (const line of st.lines) {
      const pair = chordLyricPair(line);
      const chords = toWinAnsi(pair.chords), lyrics = toWinAnsi(pair.lyrics);
      if (chords == null || lyrics == null) return null;
      lines.push({ chords, lyrics });
    }
    blocks.push({ label, lines });
  }

  const pages = [];
  let ops = [];
  let y = 720;
  const flush = () => { if (ops.length) pages.push(ops); ops = []; y = 720; };
  const text = (font, size, str, gap) => {
    if (y - gap < 56) flush();
    y -= gap;
    ops.push(`BT /${font} ${size} Tf 72 ${y} Td (${pdfEscape(str)}) Tj ET`);
  };

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
  flush();

  const objs = [];
  const addObj = s => { objs.push(s); return objs.length; };
  const font1 = addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  const font2 = addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>");
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

function assemblePdf(pages) {
  const objs = [];
  const addObj = s => { objs.push(s); return objs.length; };
  const font1 = addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  const font2 = addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>");
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

function paginateText(draw) {
  const pages = [];
  let ops = [];
  let y = 720;
  const flush = () => { if (ops.length) pages.push(ops); ops = []; y = 720; };
  const text = (font, size, str, gap) => {
    if (y - gap < 56) flush();
    y -= gap;
    ops.push(`BT /${font} ${size} Tf 72 ${y} Td (${pdfEscape(str)}) Tj ET`);
  };
  draw({ text, y: () => y });
  flush();
  return pages;
}

/** Compact stage chart: section label + unique consecutive chords, no lyric underlay. */
export function stagePdf({ title, subtitle, footer, stanzas }) {
  const tTitle = toWinAnsi(title), tSub = toWinAnsi(subtitle), tFoot = toWinAnsi(footer);
  if (tTitle == null || tSub == null || tFoot == null) return null;
  const rows = [];
  for (const st of stanzas) {
    const label = toWinAnsi(st.label || "");
    if (label == null) return null;
    const seq = [];
    for (const line of st.lines) {
      for (const m of String(line).matchAll(/\[([^\]]+)\]/g)) {
        const c = toWinAnsi(m[1]);
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
  });
  return assemblePdf(pages);
}

