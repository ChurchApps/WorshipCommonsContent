<img align="right" width="140" alt="WorshipCommons" src="https://raw.githubusercontent.com/ChurchApps/WorshipCommons/main/public/favicon.svg">

# WorshipCommons Content

[![License](https://img.shields.io/badge/license-varies%20by%20song-blue?style=flat-square)](LICENSE.md)
[![Stars](https://img.shields.io/github/stars/ChurchApps/WorshipCommonsContent?style=flat-square&color=yellow)](https://github.com/ChurchApps/WorshipCommonsContent/stargazers)
[![Last Commit](https://img.shields.io/github/last-commit/ChurchApps/WorshipCommonsContent?style=flat-square)](https://github.com/ChurchApps/WorshipCommonsContent/commits)
[![Sponsor](https://img.shields.io/badge/Sponsor-ea4aaa?style=flat-square&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/ChurchApps)
[![Slack](https://img.shields.io/badge/Slack-4A154B?style=flat-square&logo=slack&logoColor=white)](https://join.slack.com/t/livechurchsolutions/shared_invite/zt-i88etpo5-ZZhYsQwQLVclW12DKtVflg)

> **WorshipCommons Content** is the song library behind <a href="https://worshipcommons.org/">worshipcommons.org</a>. One folder per song: the words, the rights, and the files a church downloads. Public-domain hymns and songs writers chose to share.

<p align="center">
  <a href="https://worshipcommons.org/songs/YxPfAFYWOaG">
    <img width="100%" alt="Amazing Grace, built from a folder in this library" src="docs/preview-song.png">
  </a>
</p>

A service of [ChurchApps](https://churchapps.org). The website that reads this library is [WorshipCommons](https://github.com/ChurchApps/WorshipCommons).

## What's in a song

Each song is a folder, `songs/<language>/<slug>-<id>/`.

| Path | What it is |
| --- | --- |
| `song.json` | Title, writer, key, and the license. A person edits this on purpose |
| `sources/` | Lyrics, scores, and other files the tools cannot rebuild |
| `output/` | Charts and audio the tools rebuild. Not stored in git |

`writers/` holds portraits and bios shared across songs. `catalog.json` is the generated index. `licenses/` is the full text of each grant.

The rules — what you may edit, how a translation inherits a tune, how to add a song — are in the [library guide](LIBRARY.md).

## Licenses

One license per song, named in `song.json`, not in the folder path. Full terms: [LICENSE.md](LICENSE.md).

| `license` | In short |
| --- | --- |
| `PD` | Public domain in the United States (best-effort). Other countries may differ |
| `WC` | Free for worship. Commercial rights stay with the writer |
| `CC-BY`, `CC-BY-SA`, `CC-BY-NC`, `CC-BY-NC-SA` | Creative Commons, as the writer applied it |

No no-derivatives licenses. Transposing, arranging, and translating are the point. Tools and docs in this repo are MIT.

## Get Involved

### 🤝 Help Support Us

The only reason this program is free is because of the generous support from users. If you want to support us to keep this free, please head over to [ChurchApps](https://churchapps.org/partner) or [sponsor us on GitHub](https://github.com/sponsors/ChurchApps/). Thank you so much!

### 🏘️ Join the Community

We have a great community for end-users on [Facebook](https://www.facebook.com/churchapps.org). It's a good way to ask questions, get tips and follow new updates. Come join us!

### ⚠️ Report an Issue

If you discover an issue or have a feature request, simply submit it to our [issues log](https://github.com/ChurchApps/ChurchAppsSupport/issues). Don't be shy, that's how the program gets better. A song you believe is included in error: same place, and we will review it.

### 💬 Join us on Slack

If you would like to contribute in any way, head over to our [Slack Channel](https://join.slack.com/t/livechurchsolutions/shared_invite/zt-i88etpo5-ZZhYsQwQLVclW12DKtVflg) and introduce yourself. We'd love to hear from you.

### 🏗️ Start Coding

There is no install step. Node.js 18 or newer can check the library:

```bash
node tools/validate.mjs
```

Editing a song, rebuilding charts, and the rest of the commands are in the [library guide](LIBRARY.md#tools).
