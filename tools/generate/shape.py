"""Shape text runs with HarfBuzz for tools/generate/pdf.mjs (scripts like Malayalam, whose vowel
signs reorder and whose consonants join into conjuncts: a glyph per code point is wrong).
stdin (UTF-8 JSON): {"fonts": {"<key>": "<ttf path>"}, "runs": [["<key>", "<text>"], ...]}
stdout: one list per run, of [glyph id, cluster (code point index), x advance, x offset, y offset,
the text that glyph draws or null], in font units.
Needs `pip install uharfbuzz`; exits 3 without it, and pdf.mjs skips the chart with a warning."""
import json, sys

try:
    import uharfbuzz as hb
except ImportError:
    sys.exit(3)


def shape(font, text):
    buf = hb.Buffer()
    buf.add_codepoints([ord(c) for c in text])
    buf.guess_segment_properties()
    # ZWJ/ZWNJ steer the shaping but draw nothing: no zero-width space glyph that would copy out as " "
    buf.flags = hb.BufferFlags.REMOVE_DEFAULT_IGNORABLES
    hb.shape(font, buf, {})
    return buf.glyph_infos, buf.glyph_positions


def spellings(font, text, gids, top=True):
    """Which part of a cluster's text each of its glyphs draws, for the PDF's ToUnicode map: the
    longest leading piece that shapes on its own to the cluster's leading glyphs, then the next.
    None where no piece does (a vowel sign drawn before its consonant); pdf.mjs fills those in."""
    out, pos, gi = [None] * len(gids), 0, 0
    while gi < len(gids) and pos < len(text):
        for n in range(len(text) - pos - (1 if pos == 0 else 0), 0, -1):
            got = [i.codepoint for i in shape(font, text[pos:pos + n])[0]]
            if got == gids[gi:gi + len(got)]:
                break
        else:
            break
        if len(got) == 1:
            out[gi] = text[pos:pos + n]
        else:
            out[gi:gi + len(got)] = spellings(font, text[pos:pos + n], got, False)
        pos, gi = pos + n, gi + len(got)
    if gi == len(gids) - 1 and pos < len(text):
        out[gi] = text[pos:]
    # a glyph drawn out of order: the longest piece that shapes to that glyph alone
    for k, g in enumerate(gids):
        if out[k] is None and top:
            out[k] = next((text[a:b] for n in range(len(text) - 1, 0, -1) for a in range(len(text) - n + 1)
                           for b in [a + n] if [i.codepoint for i in shape(font, text[a:b])[0]] == [g]), None)
    return out


def main():
    req = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    fonts = {k: hb.Font(hb.Face(hb.Blob.from_file_path(p))) for k, p in req["fonts"].items()}
    out = []
    for key, text in req["runs"]:
        infos, pos = shape(fonts[key], text)
        glyphs = [[i.codepoint, i.cluster, p.x_advance, p.x_offset, p.y_offset, None] for i, p in zip(infos, pos)]
        starts = sorted({g[1] for g in glyphs}) + [len(text)]
        for a, b in zip(starts, starts[1:]):
            members = [g for g in glyphs if g[1] == a]
            if len(members) > 1:
                for g, t in zip(members, spellings(fonts[key], text[a:b], [g[0] for g in members])):
                    g[5] = t
        out.append(glyphs)
    json.dump(out, sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    main()
