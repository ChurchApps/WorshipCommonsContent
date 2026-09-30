"""python tools/harvest/test_align_vocal_timings.py — align() times a stanza once per time the recording sings it."""
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("avt", Path(__file__).with_name("align-vocal-timings.py"))
avt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(avt)


def words(text):
    return [{"n": avt.norm(w), "t": 0.0, "d": 0.1, "text": w} for w in text.split()]


chart = avt.parse_stanzas("Verse\nfather of lights ancient of days\n\nChorus\ntaste and see the lord is good\n\nBridge\nkeep my tongue from evil")
tokens = avt.lyric_tokens(chart)
labels = lambda passes: [chart[tokens[p[0][0]]["si"]]["label"] for p in passes]

# sung as written: one pass per stanza, every word matched
plain = avt.align(tokens, words("father of lights ancient of days taste and see the lord is good keep my tongue from evil"))
assert labels(plain) == ["Verse", "Chorus", "Bridge"], labels(plain)
assert all(j is not None for p in plain for _, j in p)

# the recording repeats the chorus and sings the verse twice: each repeat is its own pass, matched in place
sung = "father of lights ancient of days taste and see the lord is good father of lights ancient of days " \
       "taste and see the lord is good taste and see the lord is good keep my tongue from evil"
passes = avt.align(tokens, words(sung))
assert labels(passes) == ["Verse", "Chorus", "Verse", "Chorus", "Chorus", "Bridge"], labels(passes)
assert all(j is not None for p in passes for _, j in p)
assert [j for _, j in passes[3]] == list(range(19, 26)), passes[3]

# a chart closing on a wordless "Chorus (2x)" ends on that chorus, not on one more pass of its bridge
closing = avt.parse_stanzas("Verse\nfather of lights ancient of days\n\nChorus\ntaste and see the lord is good\n\n"
                            "Bridge\nkeep my tongue from evil\n\nChorus (2x)")
ctoks = avt.lyric_tokens(closing)
ending = avt.align(ctoks, words("father of lights ancient of days taste and see the lord is good keep my tongue from evil "
                                "taste and see the lord is good taste and see the lord is good"), closing)
assert [closing[ctoks[p[0][0]]["si"]]["label"] for p in ending] == ["Verse", "Chorus", "Bridge", "Chorus", "Chorus"], ending
# without that heading the chart's last stanza still closes the run, so no stanza drops out of the timing
assert labels(avt.align(tokens, words("father of lights ancient of days taste and see the lord is good"), chart))[-1] == "Bridge"
print("ok")
