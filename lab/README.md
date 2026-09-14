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

**The specification is `dev-docs/KASHSHAF_LAB_SPEC.md`.** It is the contract:
what Lab must do, in what order, with which formulae and thresholds. That
directory is gitignored, so the spec is not in the repository — this README
refers to it by path. Read §1 for the phase order and §2 for the architecture
before changing anything here.

Current status: **Phase 0** — workspace scaffolding, shared crates, mode
detection, book browser, reader with token overlay. Version `0.1.0`. Nothing
has been tagged, built as an installer, or published.

---

## Layout

```
lab/
├── src-tauri/            kashshaf-lab, the Tauri 2 backend
│   └── src/
│       ├── main.rs       Tauri setup and the command registry
│       ├── mode.rs       local | api | unavailable, resolved at startup (§2.4)
│       ├── source/       the BookSource trait and its two implementations (§3.1)
│       ├── analysis/     algorithms — pure Rust, no Tauri or HTTP types (§4)
│       ├── commands/     one module per feature area
│       ├── store.rs      analysis.db and its migrations (§6)
│       └── bin/          lab-bench, which measures the §8 targets
└── src/                  React 18 + TypeScript + Tailwind v4 frontend
```

Shared with Kashshaf, and changed with care because two apps depend on it:

- `engine/` (`kashshaf-engine`) — the index, the token cache, search
- `common/` (`kashshaf-common`) — corpus directory, manifests, download,
  settings-DB helpers
- `packages/kashshaf-shared/` (`@kashshaf/shared`) — the tokenizer, the
  sanitizer, citation formatting, `TokenPopup`, and the types the bridge
  returns

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
- **api** — no local corpus; Lab talks to `https://api.kashshaf.com`. The book
  browser, the reader and the token overlay work; features that need the bulk
  token fetch (spec §5.1) are shown disabled with the reason.
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
`~/.local/share/KashshafLab` on Linux — holding `analysis.db` and, as later
phases add them, `lab_settings.db`, `exports/` and `cache/`. It is a sibling of
the corpus directory, never inside it, so Kashshaf's "delete local data" and
its corpus archiving cannot reach your annotations.

Settings ▸ **Open Lab folder** opens it.

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

The alignment acceptance test (spec §3.3, §9) runs against a real sample
corpus and skips without one:

```sh
KASHSHAF_SAMPLE_DIR="D:/DH Projects/kashshaf-data-clean/data/sample-mini" \
  cargo test -p kashshaf-lab --release --test alignment
```

Use `--release`: it walks every page of the sample and takes minutes in a debug
build.

### Measuring against the §8 targets

```sh
cargo run -p kashshaf-lab --release --bin lab-bench -- "D:/DH Projects/kashshaf-data-clean/data/sample-mini"
```

With no argument it measures whatever corpus Lab would open normally.

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

## Conventions

- **Never write to the corpus.** `LocalSource` opens `corpus.db` and
  `metadata.db` with `SQLITE_OPEN_READ_ONLY`; Lab must work while Kashshaf has
  the same files open.
- **Degrade honestly.** A feature the current mode cannot provide is shown
  disabled with the reason, never hidden and never approximated. In Rust that
  is `source::unavailable(what, why)`.
- **Algorithms are pure.** Anything in `analysis/` takes `&dyn BookSource` or
  plain data, so it can be tested on fixtures and gives the same answer in both
  modes.
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

Phases 1–5 of the spec: statistics and concordance, the isnād workbench and
authority file, text reuse, Qurʾān detection, the network and poetry views,
and Lab's release pipeline. The left rail lists them and says which phase each
one arrives in.
