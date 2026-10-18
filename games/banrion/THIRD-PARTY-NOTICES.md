<!-- banrion/THIRD-PARTY-NOTICES.md -->

# Third-party components

Banrion is licensed **GPL-3.0-or-later** (see `LICENSE`). It vendors the
components below, each under its own permissive licence. Those licences are
GPL-compatible, so the combined work is distributable under the GPL — but the
components themselves keep their original terms, and these notices must travel
with any copy, including the single-file build that inlines all of them.

| Component | Version | Licence | Where |
|---|---|---|---|
| [chess.js](https://github.com/jhlywa/chess.js) — Jeff Hlywa | 1.4.0 | BSD-2-Clause | `js/chess.js`, wrapped in an IIFE; otherwise unmodified |
| [MQTT.js](https://github.com/mqttjs/MQTT.js) | 5.15.2 | MIT | `js/mqtt.min.js`, unmodified browser UMD build |
| [Lozza](https://github.com/op12no2/lozza) — Colin Jenkins | 11 | MIT | `js/lozza.js`, unmodified; full text in `LOZZA-LICENSE.txt` |

The splash artwork (`banrion.webp`) and all original code are copyright
Scott Peterman.

## On the single-file build

`chess_single.html` is a generated artifact that inlines the vendored
components, including a minified copy of MQTT.js. Under the GPL that makes the
**repository** — the modular `js/` tree plus `bundle.py` — the corresponding
source for it. Anyone distributing the single file should point at the
repository, and the built artifact should not be the only thing published.
