// Transpose helpers for generated charts. Same pitch-class rules as the site's chordpro.ts.
export const SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
export const KEY_CHOICES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
export const keyFile = root => (root === "F#" ? "Fs" : root);
export const FLAT_KEYS = new Set(["F", "Bb", "Eb", "Ab", "Db"]);

export const noteIndex = n => {
  const i = SHARP.indexOf(n);
  return i >= 0 ? i : FLAT.indexOf(n);
};

export const splitKey = key => {
  const m = String(key || "C").match(/^([A-G][#b]?)(.*)$/);
  return { root: m ? m[1] : "C", suffix: m ? m[2] : "" };
};

export function transposeChord(chord, shift, useFlats) {
  const m = String(chord || "").match(/^([A-G][#b]?)(.*)$/);
  if (!m || noteIndex(m[1]) < 0) return chord;
  const scale = useFlats ? FLAT : SHARP;
  return scale[(noteIndex(m[1]) + shift + 12) % 12] + m[2];
}

export function transposeLine(line, shift, useFlats) {
  return String(line || "").replace(/\[([^\]]+)\]/g, (_, c) => `[${transposeChord(c, shift, useFlats)}]`);
}

export function transposeStanzas(stanzas, shift, useFlats) {
  return stanzas.map(st => ({ ...st, lines: st.lines.map(l => transposeLine(l, shift, useFlats)) }));
}

export function shiftFor(fromKey, toRoot) {
  const from = splitKey(fromKey).root;
  const a = noteIndex(from), b = noteIndex(toRoot);
  if (a < 0 || b < 0) return 0;
  return (b - a + 12) % 12;
}

export const useFlatsFor = root => FLAT_KEYS.has(root) || /b/.test(root);
