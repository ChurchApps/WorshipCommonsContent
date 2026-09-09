// ABC voice splits for lead sheets and choir parts. Mirrors WorshipCommons/src/abc.ts
// without importing the site (content tools stay dependency-free).
const PART_NAMES = {
  2: ["Treble", "Bass"],
  3: ["Soprano", "Tenor", "Bass"],
  4: ["Soprano", "Alto", "Tenor", "Bass"]
};

export const partName = (i, total) => PART_NAMES[total]?.[i] || `Part ${i + 1}`;
export const filePart = name => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

export const abcTitle = abc => abc.match(/^T:\s*(.+)$/m)?.[1].trim() || "";
export const abcKeyRoot = abc => abc.match(/^K:\s*([A-G][#b]?)/m)?.[1] || "";

export function abcVoices(abc) {
  const ids = [];
  for (const m of abc.matchAll(/^V:\s*(\S+)/gm)) if (!ids.includes(m[1])) ids.push(m[1]);
  return ids;
}

const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
export const titlesMatch = (a, b) => {
  const x = norm(a), y = norm(b);
  return !!x && !!y && (x.includes(y) || y.includes(x));
};

export const stripLyrics = abc => abc.split(/\r?\n/).filter(l => !/^w:/i.test(l)).join("\n");

export function soloVoice(abc, voice) {
  const out = [];
  let clef = "";
  let current = "";
  for (const line of abc.split(/\r?\n/)) {
    const decl = line.match(/^V:\s*(\S+)\s*(.*)$/);
    if (decl) {
      const c = decl[2].match(/clef=\S+/);
      if (c) clef = c[0];
      if (decl[1] === voice) out.push(c || !clef ? line : `V: ${voice} ${clef}`);
      continue;
    }
    if (/^%%staves/.test(line)) continue;
    const inline = line.match(/^\[V:\s*(\S+?)\]/);
    if (inline) {
      current = inline[1];
      if (current === voice) out.push(line);
      continue;
    }
    if (/^w:/i.test(line)) {
      if (current === voice) out.push(line);
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

export function melodyOnly(abc) {
  const out = [];
  let prevW = false;
  for (const line of abc.split(/\r?\n/)) {
    if (/^[TCWSHNZOBDFGR]:/.test(line)) { prevW = false; continue; }
    if (/^w:/i.test(line)) { if (prevW) continue; prevW = true; }
    else prevW = false;
    out.push(line);
  }
  return out.join("\n");
}

// Drop Open Hymnal PostScript decorations that abcjs cannot run.
export function cleanAbc(abc) {
  return abc.split(/\r?\n/).filter(l =>
    !l.startsWith("%%postscript") &&
    !l.startsWith("%%deco") &&
    !l.startsWith("%OH") &&
    !(l.startsWith("%") && !l.startsWith("%%") && !l.startsWith("% "))
  ).join("\n");
}

export function leadAbc(abc, { title, dropWords = false } = {}) {
  const voices = abcVoices(abc);
  const melody = voices.length ? soloVoice(abc, voices[0]) : abc;
  let text = melodyOnly(melody);
  if (dropWords) text = stripLyrics(text);
  text = cleanAbc(text).replace(/^%%staves.*$/m, "");
  if (title) text = text.replace(/^T:.*$/m, `T: ${title}`);
  if (!/^%%score|^V:/m.test(text)) {
    // single-staff lead: keep as-is
  }
  return text;
}
