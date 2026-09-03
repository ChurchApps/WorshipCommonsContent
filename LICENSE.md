# Licensing index

This repository holds content under different terms. Songs are split by license
at the folder level — `songs/<lang>/<section>/` — where the section is fixed by the
song's license in the registry [`licenses/licenses.json`](licenses/licenses.json).
One license per song. No no-derivatives (ND) license is hosted: transposing,
arranging, and translating are the point.

| Content | Terms |
|---|---|
| `songs/*/public-domain/` (`PD`) | Public domain — words, music, and files free for every purpose. Living writers dedicate with CC0 (`licenseVersion: "CC0"`). See [`licenses/public-domain.md`](licenses/public-domain.md); some sources ask for attribution (each song's `sources.txt` says which). |
| `songs/*/wc-license/` (`WC`) | The WorshipCommons License, Version 1.0 — free for worship everywhere, forever; commercial rights stay with the writer. See [`licenses/wc-license.md`](licenses/wc-license.md). |
| `songs/*/cc-by/` (`CC-BY`) | Creative Commons Attribution (4.0, or the version the song names). Credit required on every copy. See [`licenses/cc-by.md`](licenses/cc-by.md). |
| `songs/*/cc-by-sa/` (`CC-BY-SA`) | Creative Commons Attribution-ShareAlike. Credit required; derivatives share alike. See [`licenses/cc-by-sa.md`](licenses/cc-by-sa.md). |
| `songs/*/cc-by-nc/` (`CC-BY-NC`) | Creative Commons Attribution-NonCommercial. Credit required; no commercial use (no sales, ads, monetized streams). See [`licenses/cc-by-nc.md`](licenses/cc-by-nc.md). |
| `songs/*/cc-by-nc-sa/` (`CC-BY-NC-SA`) | Creative Commons Attribution-NonCommercial-ShareAlike. Credit required; no commercial use; derivatives share alike. See [`licenses/cc-by-nc-sa.md`](licenses/cc-by-nc-sa.md). |
| [`writers/`](writers/LICENSE.md) | Portraits: Wikimedia-Commons-verified public domain / CC0. Bios: Wikipedia article openings, CC BY-SA. |
| `tools/`, `catalog.json`, `sources.json`, docs | MIT, matching the WorshipCommons application repositories. |

Per-song provenance lives in each song folder's `song.json` (`provenance`) and
human-readable `sources.txt`, resolved against the registry in
[`sources.json`](sources.json).

**No warranty.** All licensing determinations were made in good faith but are
best-effort and may contain errors; copyright terms vary by country. Everything
in this repository is provided as is, without warranty of any kind — see the
"No warranty" section of [`licenses/public-domain.md`](licenses/public-domain.md).
If you believe something is included in error, tell us and we'll review and
remove it.
