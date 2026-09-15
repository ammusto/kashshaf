# Kashshaf Lab

A desktop application for in-depth analysis of a single premodern Arabic text
against the Kashshaf corpus: concordance, keyness, dispersion, collocations,
isnād extraction and annotation, text reuse, and Qurʾānic quotation detection.

Lab is a companion to Kashshaf, not a part of it. It lives in the same
repository and shares the search engine (`engine/`), the data-directory and
download code (`common/`) and the frontend utilities
(`packages/kashshaf-shared/`), but it carries **its own version**, its own tag
namespace (`lab-vX.Y.Z`), its own release workflow and its own update manifest.
Releasing one does not release the other.

**The specification is `dev-docs/KASHSHAF_LAB_SPEC.md`** (version 1.5). It is
the contract: what Lab must do, in what order, with which formulae and
thresholds. That directory is gitignored, so the spec is not in the
repository — this README refers to it by path. Read §1 for the phase order and
§2 for the architecture before changing anything here.

Current status: **Phase 5** — the workspace, the Read panel, in-text search
and the restructure the spec's §A–§K describe, on top of Phase 4's network
and poetry, Phase 3's reuse and Qurʾān, Phase 2's isnāds and Phase 1's
statistics. Version `0.6.0`. Nothing has been tagged, built as an installer,
or published.

**Lab wants corpus 4.2.0**, the first to ship `toc.db`. An older corpus opens
and works; the table of contents, the section scopes and Analyse section then
say which corpus they need instead of failing silently.

---

## Layout

```
lab/
├── fixtures/             isnad_gold.json, reuse_gold.json — hand-labelled gold sets (DRAFT);
│                         quran_baseline.json — Quran_Detector's output on 20 sample pages
├── scripts/              quran_baseline.py — regenerates that baseline (dev-only, Python)
├── src-tauri/            kashshaf-lab, the Tauri 2 backend
│   ├── lexicons/         shipped defaults: stop words, transmission verbs, formulae
│   ├── quran/            the Qurʾān as Lab data: quran.jsonl.zst + quran.db (§4.4)
│   └── src/
│       ├── main.rs       Tauri setup and the command registry
│       ├── mode.rs       local | api | unavailable, resolved at startup (§2.4)
│       ├── lexicon.rs    lexicon_entry: shipped defaults, re-sync, user edits (§6.5)
│       ├── quran_data.rs the embedded Qurʾān: sūra pages, āya token ranges
│       ├── source/       BookSource and its two implementations (§3.1), the
│       │                 api-mode bulk cache (§2.5), the frequency snapshot (§3.4)
│       ├── analysis/     algorithms — pure Rust, no Tauri or HTTP types (§4)
│       ├── commands/     one module per feature area
│       ├── store.rs      analysis.db and its migrations (§6)
│       └── bin/          lab-bench (§8 targets); lab-cli (reuse-eval, reuse-find, quran-scan)
└── src/                  React 18 + TypeScript + Tailwind v4 frontend
    ├── api/pages.ts      the page-label rule and the `Pages` lookup (1.5 §C1)
    ├── components/workspace/ the startup view: the workspace list, the text
    │                     browser, a text's metadata (1.5 §A1)
    ├── components/read/  the Read panel and the table-of-contents pane (1.5 §C)
    ├── components/search/ search within the open text (1.5 §D)
    ├── components/ui/    the loading overlay, the run strip, the size warning,
    │                     the scope picker (1.5 §F, §G)
    ├── components/stats/ the Stats panel (§7.3) and its virtualised table
    ├── components/isnad/ the isnād workbench (§7.4)
    ├── components/reuse/ the reuse panel (§7.5)
    ├── components/quran/ the Qurʾān panel (§7.6)
    └── components/network/ the transmission network (§7.7)
```

Shared with Kashshaf, and changed with care because two apps depend on it:

- `engine/` (`kashshaf-engine`) — the index, the token cache, search. Phase 1
  added `TokenCache::book_pages` / `resolve_pages`, the bulk path both Lab and
  the API's `/book/{id}/tokens` use.
- `common/` (`kashshaf-common`) — corpus directory, manifests, download,
  settings-DB helpers. `check_corpus_status` takes the caller's
  `CompatFloor`.
- `packages/kashshaf-shared/` (`@kashshaf/shared`) — the tokenizer, the
  sanitizer, citation formatting, `TokenPopup`, and the types the bridge
  returns.
- `api/` — `GET /book/{id}/tokens` (§5.1), `GET /book/{id}/toc` (1.5 §B2),
  `/authors`, `/genres`, and `bulk_tokens` / `toc` in `/health`.

## The workspace

Lab opens on the workspace (spec 1.5 §A1): the texts you are working on, and
the corpus to find more in. A text is added to it deliberately, and adding one
creates its folder under the workspace root:

```
<data dir>/KashshafLab/workspace/<book id>/
├── metadata.json          the book's row, as the corpus has it
├── isnads/
│   ├── confirmed.csv      one row per confirmed chain
│   ├── transmitters.csv   their transmitters, with the person each is linked to
│   └── rejected.csv       what you rejected, so a re-run does not offer it again
├── reuse/verdicts.csv     confirmed and rejected matches
├── quran/verdicts.csv     confirmed and rejected quotations
├── notes.json             your annotations, with the words they were anchored to
└── state.json             where you were reading, and each panel's settings
```

Every action that changes one of these writes the database **and** rewrites
the file, so the folder is never behind. `Ctrl+S` rewrites all of them.
Opening a text whose folder holds rows the database does not reads them back
in, re-anchoring each span by its stored snapshot when the page has moved
(§6.1). Settings has **Open workspace folder**. Removing a text from the
workspace deletes its folder after asking; the database keeps what you found,
so adding the text again brings it back.

`dirs::data_dir()` is `%APPDATA%` on Windows, `~/Library/Application Support`
on macOS, `~/.local/share` on Linux.

## How a page is named

One rule, one helper, everywhere (spec 1.5 §C1): `lab/src/api/pages.ts`.

- A single-part text prints the page number alone: `24`.
- A multi-part text prints part and page: `1:24`, the part counted from one.
- The number is the one **printed on the page**, not the corpus's `page_id`,
  which is why the reader fetches a page list (`list_pages`) when it opens a
  text: the printed numbers live in the index, not in `page_tokens`.
- Never `0:24`, never `:24`, never "Page 20 of 405".

Every table that shows a page goes through `Pages.label`: the concordance, the
dispersion strip, the isnād list and its transmitter table, the reuse rows,
the Qurʾān list, the poetry list, the network's transmitter rows, the table of
contents, the search results and the reader's own locator.

## The table of contents

`toc.db` ships beside `corpus.db` from corpus 4.2.0. It is built by
`kashshaf-data-clean/build_toc.py` from the `<title id=N parent=M>` markup the
pipeline keeps in each page body, and holds one row per heading:

```
toc(book_id, id, parent, title, part_index, page_id, page_number)
```

The whole corpus is 2,384,556 headings over 6,083 of 7,199 books, 242 MB. The
1,116 books without one have no heading markup in the source.

`BookSource::toc` returns it as a tree; api mode fetches `GET /book/{id}/toc`.
Lab's floor for it is `MIN_TOC_CORPUS_VERSION` in `lab/src-tauri/src/lib.rs`,
separate from `MIN_CORPUS_VERSION` on purpose: a corpus without a table of
contents is still fully readable, so Lab opens it and reports the absence
through `lab_status` rather than refusing to start.

## Build and run

Node 20+ and a stable Rust toolchain, as for Kashshaf. Lab has its own
`node_modules`; install them once:

```sh
cd lab
npm install
```

Development (Vite on port 5174, one above Kashshaf's, so both can run at once):

```sh
cd lab
npm run tauri dev
```

Frontend only, without the desktop shell — useful for UI work, though every
backend call will fail because there is no Tauri bridge:

```sh
cd lab
npm run dev
```

Release build:

```sh
cd lab
npm run tauri build
```

This produces Lab's installers only. Kashshaf's `npm run tauri build` at the
repository root is unaffected and does not build Lab.

### Which mode Lab starts in

Lab resolves its mode once at startup (spec §2.4) and shows it in the badge in
the top right:

- **local** — `kashshaf-common` found a readable corpus in Kashshaf's data
  directory. Lab opens it read-only. Every feature is available.
- **api** — no local corpus; Lab talks to `https://api.kashshaf.com`. The
  browser, the reader, every Stats tab and the isnād workbench work through
  the bulk token fetch (§5.1), cached on disk. Keyness against the corpus
  needs the frequency snapshot the corpus ships (§3.4); keyness against a
  chosen set of books is capped at 8 books online because of the server's
  bulk limits. Both say so in place.
- **unavailable** — neither worked. Lab still opens and shows both reasons.

Downloading the corpus in Kashshaf makes it available to Lab as well: they read
the same directory. Press **Recheck** in the badge to pick it up without
restarting.

Point Lab at a different server with `KASHSHAF_API_BASE`:

```sh
KASHSHAF_API_BASE=http://localhost:8080 npm run tauri dev
```

### Where Lab keeps its data

Lab never writes to the corpus (spec ground rule 2). Its own directory is
`dirs::data_dir()/KashshafLab` — `%APPDATA%\KashshafLab` on Windows,
`~/Library/Application Support/KashshafLab` on macOS,
`~/.local/share/KashshafLab` on Linux — holding:

- `analysis.db` — settings, the lexicon, every isnād and transmitter, the
  authority file, and the audit log (`equivalence_log`)
- `cache/` — api-mode bulk bodies (size-capped, LRU by last use) and the
  frequency snapshot
- `exports/` — every export, timestamped

It is a sibling of the corpus directory, never inside it, so Kashshaf's
"delete local data" and its corpus archiving cannot reach it.

Settings ▸ **Open Lab folder** opens it.

### The frequency snapshot

Built in local mode on first use of keyness or reuse (spec 1.4, fix 4), with
progress, or from Settings: `corpus.db` holds no per-definition counts, so
the tokens are counted — as definition ids from the bulk path into a flat
array, joined to lemma and root strings once at the end. The full corpus
(7,199 books, 991.6 M tokens) takes 40 s and is byte-identical to the
shipped `lemma_freq.bin`; the sample 0.23 s. `lab-cli freq-build [--corpus
DIR] [--out DIR]` times it.

Keyness against the whole corpus needs `lemma_freq.bin` and `root_freq.bin`
(spec §3.4). They are built once per corpus by
`kashshaf-data-clean/build_lab_freq.py` and, when a corpus ships them, listed
in its manifest. Lab looks for them in the corpus directory (local) or
downloads them from the manifest (api). If a local corpus has none,
Settings ▸ **Build frequency snapshot** scans the corpus once — 1.6 s on the
25-book sample, several minutes on the full 4.1.0 — with progress and cancel.

## The isnād workbench

**Spans cross page breaks** (spec 1.4, Phase 4). The extractor runs over a
book as one stream — each page with the five that follow it — so a chain
open at a page end continues on the next page and a matn runs to its real
terminator (the next chain, a ḥadīth-number marker, a heading) or the
5-page cap. Token offsets in `isnad` and `transmitter` are *stream offsets*
from the start page's token 0 and may run past its end; `end_part_index /
end_page_id` (and the matn's) name the page the last token falls on
(migration 4; NULL = the start page, for rows written before). The
snapshot covers the start page; re-anchoring anchors on the start. The
workbench shows a multi-page span with a page-break bar and steps through
its pages; clicks map through the page offset.

Three token rules came with the stream: a *bridge word* (`به بذلك بهذا لنا
لي له`) between a verb and a name keeps the door open; a `ب`-fused proper
noun after a name (`بالكوفة`) is a *place tag*, CONNECT-class, stored on
the transmitter as `place`; and a chain neither begins with noise before
its first name nor runs past a comparative closer (`بمعناه نحوه مثله`) —
without the last, the stream merged consecutive isnād-only ḥadīths that a
page break used to separate. Two merges remain and are documented in the
gold set: a BERT `noun_prop` on a common noun (`ائدموه`), and `عن` inside a
matn (`سأل مسروقا عن الصلاة`) reopening the door.

**Navigation** (fixes 7–8): a transmitter row opens the reader at its
occurrence with the name highlighted (a grouped row offers its
occurrences); a token click selects and scrolls to its row; a click on the
pane background, or Escape, clears the selection. The extraction
parameters sit behind the gear beside *Extract isnāds* and persist in
`lab_setting` (`isnad.params`).

**Extract isnāds** runs the §4.2 extractor over the whole current book,
streaming: each page's candidates are written as the page completes, so a
cancelled run keeps every finished page. Re-running replaces *candidates*
only — confirmed, rejected and orphaned rows are your decisions and are kept.
The parameters (`min links`, `lookahead`, the lexicon groups) are on the
toolbar; every default in §4.2 is editable there.

The left pane is the reader with the current candidate emphasised: the chain
outlined, each transmitter in its own colour (six, cycling), every
transmission verb in one verb colour, the matn dotted. Above it, the
structured chain `[verb] transmitter ← [verb] transmitter ← … ← matn…`, with
the confidence and its four components (links, noun_prop share, terminal
pattern, cleanliness) spelled out — the "why".

The right pane is every transmitter span in the book (or in confirmed isnāds
only): raw form, parsed parts (kunya / ism / nasab / nisba / laqab), count of
occurrences of that form, the linked person, and any **suggestion** — an
unlinked span whose normalized form matches a person's `name_form`. A
suggestion is shown dashed and is never applied until you link it, singly or
with *Accept suggestions on page* (which shows the list first, and is one undo
step).

Every action — confirm, reject, boundary, split, merge, retag, link, same
person, rename, death year, notes, split person, accept suggestions, mark a
range as isnād — is one typed operation applied in a transaction and written
to `equivalence_log`, and each returns the operation that undoes it. The
session undo/redo stack is a stack of those inverses, so `Ctrl+Z` / `Ctrl+Y`
walk back and forward through the exact database changes.

### Keyboard map

Decided for Phase 2 (spec §12); the letters are on the buttons too.

| Key | Action |
|---|---|
| `c` / `x` | Confirm / reject the current candidate |
| `j` / `k` | Next / previous candidate |
| `b` | *Matn starts at…* — then click the word |
| `e` | *Matn ends at…* — then click the word |
| `[` / `]` | Nudge the isnād/matn boundary one word left / right |
| click a word | Select its transmitter (for split, merge, link) and the word (for retag) |
| `s` | *Split* the selected transmitter — then click the word to split at |
| `m` | Merge the selected transmitter with its right neighbour; with two rows selected on the right, *Same person* |
| `r`, then `v` `n` `f` `o` | Retag the selected word as verb / name / formula / other (an override for this span, not a lexicon change); after the same retag three times, an *Add to lexicon* offer appears |
| `l` | Link the selected transmitter to the selected row's person (an unlinked row creates a person from it) |
| `a` | Accept suggestions on this page (reviewable, one undo step) |
| `p` | Person menu for the selected linked row: rename, death year, notes, split |
| `g` | Group the table by form |
| `/` | Focus the name search |
| `Esc` | Leave a mode; close the person menu or the review |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo (session) |

The matn boundary has no drag handles yet: `b`/`e` with a click, or `[`/`]`,
set it instead. Recorded as a Phase 2 deviation from §7.4.

### Lexicons

`lab/src-tauri/lexicons/transmission.json` (the four groups of §4.2) and
`formulas.json` are the shipped defaults, inserted into `lexicon_entry` on
first run and re-synced on every start: a missing shipped entry is inserted,
user entries and user-disabled shipped entries are never touched. Entries are
normalized surfaces; multi-token entries match as sequences; a leading `و`/`ف`
is tolerated. Every stored isnād records the hash of the lexicon that
produced it.

### The gold set

`lab/fixtures/isnad_gold.json` holds 42 hand-labelled chains from the sample
corpus — ḥadīth 17, history 11, adab 12, Shīʿī 2 — as isnād span, matn
boundary and transmitter spans, plus two *inline* chains given as tokens
(the `أخبرنا به يحيى بن محمد العكرمي بالكوفة` chain of fix 2, which is not in
the sample, and a copy of it with page breaks inside a transmitter and the
matn). Chain 41 crosses a page break (ʿUyūn al-akhbār 96→97); chain 43
documents the `عن`-in-matn merge. **It is a draft** awaiting review; its
conventions are in the file. `tests/isnad_gold.rs` scores the extractor
against it — windowed the way a whole-book run is — and prints span F1,
transmitter F1 (exact and IoU ≥ 0.8), matn-start accuracy and per-genre
figures; the inline chains run without a corpus. Those numbers are the
baseline, not a gate (spec §9). Phase 4 left the original 40 chains'
numbers unchanged (span F1 0.769, transmitter F1 0.828); with the three
added chains the baseline is span F1 0.756, transmitter F1 0.824.

## Text reuse

**Passage mode** (both modes): select a range in the reader on the Reuse
panel and press *Find reuse*. Lab takes the passage's rarest lemma trigrams
whose tokens are all non-banal as anchors, runs each as a phrase query on the
index (the engine locally, `POST /search/combined` remotely — the mode-parity
test checks both return the same pages), keeps the pages that hit enough
anchors, aligns the passage against each with Smith–Waterman (affine gaps,
lemma match +2, root-only +1, mismatch −2; disjoint alignments within 40
tokens are merged in proximity mode), and scores every alignment on three
layers. Everything is a parameter with the §4.3 default (`reuse::Params`);
the threshold, type filter and banality slider re-score the stored matches
without re-running. Confirm writes the pair to `reuse_gold`.

**Book mode** (local only): *Analyse whole book* runs every 60-token window
(stride 30) of the book through passage mode after a 20-window trial gives
the estimate; progress is per page; cancel keeps the pages done. Results are
the ranked source-book table, per-book match lists and a reader layer.

**Anchors** (spec 1.4, fix 3). Token banality was the wrong unit for anchor
selection: `من أين تأكلون فقال لسنا نعرف الأسباب` is made of top-300 lemmas
and had no anchor. Now every lemma trigram is a candidate; the count budget
(24 lookups) is spent evenly over six slices of the passage, each trigram's
document frequency comes from the index (`find_pages` with limit 1), and the
trigrams with the lowest count *beyond the query's own page* (1 = "only
here") and within the candidate cap are taken greedily without overlap,
rank breaking ties — the rarest phrases of a passage cluster where its
wording is peculiar, which is exactly where a parallel differs, so an
anchor per region matters. One hit on an anchor with df ≤ 50 makes a page a
candidate by itself. A passage under 12 tokens or with no anchor also goes
to the index whole (lemma phrase with slop 2 — `SearchEngine::phrase_hits`;
the compound index refuses a too-wide slop phrase and the exact phrase is
tried — then surface phrase) and carries no banality penalty. Zone
exclusion from anchoring is off by default: a Qurʾānic trigram hundreds of
pages quote sorts itself last. `reuse-eval` on the full corpus went from
26/31 to 30/31 (the seven-token passage is gold pair 31, in the full corpus
only); on the sample 30/30.

**Banality.** A token is banal when its corpus lemma rank ≤ 300 (or it is
covered by a `banal` lexicon phrase — none is shipped). Two things the spec
did not say, both measured on the sample corpus (`tests/banality_probe.rs`):

- The top-300 lemmas are **61.9 %** of running text and the median page is
  60 % banal, so §4.3's `banality_factor = 1 − min(1, share / 0.5)` gives
  ordinary prose factor 0. Lab measures the share *in excess of* that corpus
  baseline (`Params::banality_baseline`, filled from the frequency table), so
  a region as banal as the corpus is not penalised and one made entirely of
  top-300 lemmas is.
- Pure formulae are suppressed by the **anchor rule**, not the penalty: an
  isnād chain or a basmala has no trigram of three non-banal tokens, so it
  retrieves no candidates at all (0 of 40 gold chains, 0 of 5 page openings).
  The penalty matters only when an alignment seeded in a matn extends into a
  chain. `formulaic` is decided before `verbatim` in the type table, or a
  basmala would never show as formulaic.

**Zones.** Query tokens inside a Qurʾānic quotation (the §4.4 detector) or an
isnād (confirmed, or a live candidate at confidence ≥ 0.6) are labelled and,
by default, not used as anchors; a match whose aligned tokens are mostly in a
zone reports it.

### The reuse gold set and `lab-cli`

`lab/fixtures/reuse_gold.json` holds 30 hand-checked pairs from seven sample
books (ḥadīth matns, sayings, a Qurʾānic quotation, an author's
self-quotations and restatements) with the reader's expected type. **It is a
draft, and it is biased**: the candidates were found with `lab-cli
reuse-find` and then checked, so its recall says nothing about what Lab
misses. `lab-cli reuse-eval` reports recall and a lower-bound precision at
the threshold and the type distribution:

```sh
cargo build --release -p kashshaf-lab --bin lab-cli
export KASHSHAF_SAMPLE_DIR="D:/DH Projects/kashshaf-data-clean/data/sample-mini"
./target/release/lab-cli reuse-eval                         # the gold set
./target/release/lab-cli reuse-find --book 4697 --from 50 --to 70 --exclude-same-book
./target/release/lab-cli quran-scan --book 527 --from 0 --to 40
```

The frequency snapshot must be readable (beside the corpus, or in Lab's
cache directory; see above). Gold pair 31 lives in the full corpus:
`./target/release/lab-cli reuse-eval --corpus "$APPDATA/Kashshaf"` measures
it; on the sample its pages are reported MISSING and skipped.

## Qurʾānic quotations

The Qurʾān ships inside Lab (`lab/src-tauri/quran/`, produced by
`kashshaf-data-clean/ingest_quran.py`): one line per sūra in the corpus token
schema, and `quran.db` with the sūra/āya token ranges and both the imlāʾī and
the Uthmani text. Morphology ran on Tanzil's **imlāʾī** text, not the
Uthmani one the spec names: after the pipeline's normalisation 17.6 % of
Uthmani tokens differ from the spelling the corpus quotes in (`مَٰلِكِ` →
`ملك`, `ٱلصَّلَوٰةَ` → `الصلوة`) and 363 āyāt differ in word count. The
alignment contract holds on every sūra and āya (`tests/quran_data.rs`, not
gated — the data is embedded).

At startup Lab builds a lemma 3/4/5-gram index over it (~60 ms). *Detect
quotations* runs every page: a page trigram with at least one non-banal
token that occurs in the Qurʾān seeds an alignment against the āyāt around
the hit; ≥ 4 aligned tokens with lemma agreement ≥ 0.8, or ≥ 3 with a `﴿ ﴾`,
`«»` or `قال تعالى` cue within 3 tokens, is a quotation. Tanzil's 112
sūra-opening basmalas are not indexed (a basmala is 1:1). A span that aligns
equally to several āyāt (`فبأي آلاء ربكما تكذبان`) is one hit, marked
*ambiguous*, whose primary reading is the first in muṣḥaf order with every
other āya listed (`also` / `ayas_json`; spec 1.4, fix 6). Results go to
`quran_match` — rows you have judged survive a re-run — and show as a
virtualised table by Qurʾān reference, page (no volume prefix for a
single-part book), text and āya, with an ⓘ per row opening a detail view
(tokens, agreement, cue, the readings, the āya with one āya of context in
imlāʾī or Uthmani) and a reader layer. Detection parameters sit behind the
gear and persist in `lab_setting` (`quran.params`).

**Baseline.** `lab/scripts/quran_baseline.py` runs `Quran_Detector`
(SElBeltagy, Python, offline) on 20 sample pages into
`lab/fixtures/quran_baseline.json`; `tests/quran_baseline.rs` runs Lab on
the same pages, prints every disagreement and asserts Lab's recall on the
baseline's matches is at least the baseline's on Lab's (0.800 vs 0.750 on
the committed fixture). Python is never run by the tests.

## The transmission network

From **confirmed** isnāds with **linked** transmitters only (spec §4.5).
Nodes are canonical persons; an edge `A → B` means B transmitted from A —
adjacent links of one chain, A at the higher position (nearer the source) —
weighted by how many chains carry it; an unlinked transmitter between two
linked ones breaks adjacency. The panel lays the whole-book graph out by
force on an SVG canvas with a node cap (default 300, by weighted degree)
and a minimum edge weight; a node click shows its ego graph and its
transmitter rows; "the author's direct sources" lists the position-0
persons by count. Export a CSV edge list or GraphML (`network_export`).

## Poetry (experimental)

Candidate verses (spec §4.6) are lines with a hemistich marker — `۞`, ` ... `,
or the `%~%` residue — or two near-equal segments split by wide whitespace,
with page token coordinates (`۞` is itself a token to the corpus tokenizer).
Meter comes from ʿarūḍ scansion of the **vowelled** surface only: the
hemistich is written prosodically (mutaḥarrik / sākin — shadda, tanwīn, long
vowels, hamzat al-waṣl, pausal ending) and matched against the sixteen
meters' feet with their common ziḥāfāt and the majzūʾ forms
(`analysis/poetry.rs`); a hemistich that is under 60 % vowelled, or scans
as nothing, is `unknown` — never a guess — and several matches are reported
as ambiguous. Nothing is stored; the panel holds the scan, layers the
current page, and exports CSV.

## Test

Everything below must pass before a Lab release; the release workflow runs the
whole workspace, because Lab ships shared crates (spec §10).

```sh
# Rust: the whole workspace, Kashshaf and the API included
cargo test --workspace

# Lab's frontend
cd lab && npm test

# Kashshaf's frontend, which also owns @kashshaf/shared's tests
npm test
```

### Tests that need a corpus

These run against a real sample corpus and skip without one. Use `--release`:
they walk every page of the sample and take minutes in a debug build.

```sh
export KASHSHAF_SAMPLE_DIR="D:/DH Projects/kashshaf-data-clean/data/sample-mini"

# The alignment contract over every sample page (§3.3, §9)
cargo test -p kashshaf-lab --release --test alignment

# Mode parity: LocalSource against a real kashshaf-api on the same corpus (§9)
cargo build --release -p kashshaf-api
cargo test -p kashshaf-lab --release --test mode_parity

# The frequency snapshot: Rust builder byte-identical to the Python writer (§3.4)
python ../kashshaf-data-clean/build_lab_freq.py --corpus-db "$KASHSHAF_SAMPLE_DIR/corpus.db" --out-dir /tmp/freq
KASHSHAF_FREQ_DIR=/tmp/freq cargo test -p kashshaf-lab --release --test freq_snapshot

# The isnād gold baseline and the §8 extraction speed
cargo test -p kashshaf-lab --release --test isnad_gold -- --nocapture

# What "banal" covers, and what it does to formulae (§4.3)
cargo test -p kashshaf-lab --release --test banality_probe -- --nocapture

# Lab's Qurʾān detector against the Quran_Detector baseline (§4.4)
cargo test -p kashshaf-lab --release --test quran_baseline -- --nocapture

# The engine's bulk path against its per-page path
cargo test -p kashshaf-engine --release --test book_pages
```

### Measuring against the §8 targets

```sh
cargo run -p kashshaf-lab --release --bin lab-bench -- "D:/DH Projects/kashshaf-data-clean/data/sample-mini"
```

With no argument it measures whatever corpus Lab would open normally. On the
sample's largest book (6,336 pages): opening it (`page_refs`) 14 ms; loading
it whole 0.26 ms/page, i.e. 129 ms per 500 pages against the < 1 s target.
Isnād extraction over the whole 4.1M-token sample: 2.1 s, i.e. 0.5 s per
million tokens against the < 10 s target.

## The alignment contract

Every span Lab stores is `(corpus_version, book_id, part_index, page_id,
tok_start, tok_end)` in token coordinates (spec ground rule 4). Those
coordinates only mean anything because the backend's token indices and the
frontend's agree exactly, on every page.

That contract is pinned on both sides:

- `packages/kashshaf-shared/src/utils/arabicTokenizer.ts` is the frontend's
  tokenizer, and `arabicTokenizer.test.ts` fixes its behaviour.
- `lab/src-tauri/src/analysis/align.rs` is a port of it, with the *same*
  fixtures in its unit tests.
- `lab/src-tauri/src/analysis/verify.rs` (`verify_alignment`, exposed as a
  Tauri command) checks real pages: the number of tokens the corpus reports
  must equal the number the display tokenizer finds in the page body.
- `lab/src-tauri/tests/alignment.rs` runs that over every page of the sample
  corpus and expects zero divergences.

If you change either tokenizer, change both, and run all four. The reader also
checks the page in front of the user and disables its overlay rather than
highlighting the wrong words if that page does not align.

## The algorithms

Every number in the Stats panel and every candidate in the workbench comes
from a pure function in `lab/src-tauri/src/analysis/`. The formulae and their
references are in each module's header; the unit tests check them against
hand-computed values. The isnād extractor (`isnad.rs`) is §4.2's state
machine over the five token classes; its header records the three places it
departs from the letter of the spec and why (nisbas are tagged `noun` as often
as `adj`; a name must be introduced by a verb, `عن` or a kin/nasab connector,
because `noun_prop` — 74% of transmitter tokens, but also 15% of matn tokens —
is evidence, not a licence; the Prophet ends a chain). `tests/pos_audit.rs`
checks that the POS Lab sees is the POS the pipeline wrote and the POS
Kashshaf's own `get_page_tokens` returns. Transmitter segmentation (`names.rs`)
is a port of Kashshaf's `namePatterns.ts` structure.

## Conventions

- **Never write to the corpus.** `LocalSource` opens `corpus.db` and
  `metadata.db` with `SQLITE_OPEN_READ_ONLY`; Lab must work while Kashshaf has
  the same files open.
- **Degrade honestly.** A feature the current mode cannot provide is shown
  disabled with the reason, never hidden and never approximated. In Rust that
  is `source::unavailable(what, why)`; in the panel, a note in place of the
  column.
- **Algorithms are pure.** Anything in `analysis/` takes plain data, so it can
  be tested on fixtures and gives the same answer in both modes — which
  `tests/mode_parity.rs` checks against a live API.
- **Batch work reports and can be cancelled.** Loading a book, building a
  reference set, building the snapshot, extracting isnāds: progress through
  an event, cancel through `stats_cancel` (ground rule 6).
- **Every annotation change is an `Op`.** Applied in a transaction, logged to
  `equivalence_log`, and it returns its inverse — undo is `apply(inverse)`.
- **Suggestions are never written.** A matching `name_form` is shown; only a
  link writes.
- **Migrations are forward-only.** Add a numbered entry to `MIGRATIONS` in
  `store.rs`; never edit one that has shipped.
- **Versions.** `lab/package.json` and `lab/src-tauri/Cargo.toml` carry Lab's
  version explicitly — *not* `version.workspace = true`. `tauri.conf.json`
  reads `lab/package.json`. The two must agree.
- **Compatibility is Lab's own.** `corpus_manifest.json`'s `min_app_version`
  gates Kashshaf and is ignored here; Lab's floor is `MIN_CORPUS_VERSION` plus
  the engine's schema gate (spec §2.4). That is what
  `CompatFloor::MinCorpusVersion` expresses.

## Not done yet

Phase 5 of the spec: re-anchoring across corpus versions (§6.1), "Export
everything", and Lab's release pipeline. Both gold sets are drafts, and the
reuse set needs pairs found by other means before its recall is a
measurement. Meter detection covers the base feet and common ziḥāfāt only;
a vowelled hemistich with a rarer ʿilla comes out `unknown`.
