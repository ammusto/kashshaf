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

**The specification is `dev-docs/KASHSHAF_LAB_SPEC.md`** (version 1.2). It is
the contract: what Lab must do, in what order, with which formulae and
thresholds. That directory is gitignored, so the spec is not in the
repository — this README refers to it by path. Read §1 for the phase order and
§2 for the architecture before changing anything here.

Current status: **Phase 1** — text statistics (§4.1), the Stats panel (§7.3),
the bulk token route (§5.1) and the frequency snapshot (§3.4), on top of
Phase 0's scaffolding, modes, browser and reader. Version `0.2.0`. Nothing has
been tagged, built as an installer, or published.

---

## Layout

```
lab/
├── src-tauri/            kashshaf-lab, the Tauri 2 backend
│   ├── lexicons/         shipped defaults (stop words); user edits live in analysis.db
│   └── src/
│       ├── main.rs       Tauri setup and the command registry
│       ├── mode.rs       local | api | unavailable, resolved at startup (§2.4)
│       ├── source/       BookSource and its two implementations (§3.1), the
│       │                 api-mode bulk cache (§2.5), the frequency snapshot (§3.4)
│       ├── analysis/     algorithms — pure Rust, no Tauri or HTTP types (§4)
│       ├── commands/     one module per feature area
│       ├── store.rs      analysis.db and its migrations (§6)
│       └── bin/          lab-bench, which measures the §8 targets
└── src/                  React 18 + TypeScript + Tailwind v4 frontend
    └── components/stats/ the Stats panel (§7.3) and its virtualised table
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
- `api/` — `GET /book/{id}/tokens` (§5.1) and `bulk_tokens` in `/health`.

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
  browser, the reader and every Stats tab work through the bulk token fetch
  (§5.1), cached on disk. Keyness against the corpus needs the frequency
  snapshot the corpus ships (§3.4); keyness against a chosen set of books is
  capped at 8 books online because of the server's bulk limits. Both say so
  in place.
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

- `analysis.db` — settings (the stop list) now; annotations from Phase 2
- `cache/` — api-mode bulk bodies (size-capped, LRU by last use) and the
  frequency snapshot
- `exports/` — every export, timestamped

It is a sibling of the corpus directory, never inside it, so Kashshaf's
"delete local data" and its corpus archiving cannot reach it.

Settings ▸ **Open Lab folder** opens it.

### The frequency snapshot

Keyness against the whole corpus needs `lemma_freq.bin` and `root_freq.bin`
(spec §3.4). They are built once per corpus by
`kashshaf-data-clean/build_lab_freq.py` and, when a corpus ships them, listed
in its manifest. Lab looks for them in the corpus directory (local) or
downloads them from the manifest (api). If a local corpus has none,
Settings ▸ **Build frequency snapshot** scans the corpus once — 1.6 s on the
25-book sample, several minutes on the full 4.1.0 — with progress and cancel.

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

## The statistics

Every number in the Stats panel comes from a pure function in
`lab/src-tauri/src/analysis/` over a `BookText` — the book as one interned
token stream on a layer. The formulae and their references are in each
module's header; the unit tests check them against hand-computed values
(Rayson & Garside's G² example, Gries's DP example, a worked collocation
table). The concordance matches with the engine's own rules — `normalize_arabic`
and the glob grammar on surface, exact lemma, `normalize_root_query` on root —
plus Kashshaf's `و ف ب ل ك` proclitic expansion, so a hit in Lab is a hit in
Kashshaf.

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
  reference set, building the snapshot: progress through `stats-progress`,
  cancel through `stats_cancel` (ground rule 6).
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

Phases 2–5 of the spec: the isnād workbench and authority file, text reuse,
Qurʾān detection, the network and poetry views, and Lab's release pipeline.
The left rail lists them and says which phase each one arrives in.
