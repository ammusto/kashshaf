# Changelog

All notable changes to the Kashshaf desktop app, API server, and data pipeline. Format loosely follows Keep a Changelog. Dates are build dates; nothing below has been tagged or published yet.

---
## [0.5.2] — 2026-09-13

**Fixed:** the corpus update prompt now distinguishes an optional update from a first install. If you have a working corpus and a newer one is available, you'll see what changed and can choose to update later.

## [0.5.1] — 2026-09-12

Backend fixes to the server deployment and release process. No changes to the app.

## [0.5.0] — 2026-09-12

**Faster search.** The search engine was rebuilt. Most searches are now
2–10× faster, and the corpus download is about a third smaller.

**Accurate result counts.** Proximity and wildcard searches used to report
counts that were silently too low — sometimes by a lot. Counts are now exact,
or clearly marked as a lower bound (`20,000+`) when a search matches too much
to count quickly. Desktop users working from local data can turn on exact
counts for every search in Settings.

**Better wildcards.** Wildcards now work anywhere in a word and you can use
more than one: `أب*`, `*رف`, `أح*مد`, `*قول*`, `مع*رف*`. Wide patterns like
`ال*` no longer fail — they just run. Wildcards are still surface-mode only
and need at least two letters.

**Scrolling results is instant.** Loading the next page of results no longer
re-runs the search.

**New:** exact-counts setting, a Settings window, and a data-location panel
showing where your corpus lives.

### Fixed
- **Corpus update dialog showed the first-install copy for optional updates.** With 4.0.0 installed and 4.1.0 published, launch opened the Download modal saying the corpus "must" be downloaded. `check_corpus_status` computed `ready` from the diff against the *remote* file list, so a newer version made the local corpus look absent. `ready` now means "the installed corpus is complete and this app can read it" (`corpus_ready`, unit-tested), so launch shows the dismissible banner per spec §3.2, and the modal renders three explicit states from `CorpusStatus`: no corpus (*Download N GB* / *Use online mode*), update available ("You have corpus X. Version Y is available (N GB)." + the manifest's notes; *Update now* / *Later*, which downloads and deletes nothing), update required (format changed, this app cannot read the installed corpus; *Update now* / *Use online mode*, no dismiss). Destination, free-space check and verify checkbox stay in all three. `corpus_manifest.json` gains an optional `notes` string (`publish_corpus.py --notes`), surfaced as `CorpusStatus.remote_notes`. Frontend unit tests (vitest + Testing Library, `npm test`) cover the three states.
- **API unit vs. symlinked data directory.** `api/deploy/kashshaf-api.service` had `ReadOnlyPaths=/opt/kashshaf/data`; with `/opt/kashshaf/data -> data-4.0.0/` the bind mount does not resolve the symlink inside the service namespace and SQLite fails at startup with "unable to open database file" (error 14). Removed; `ProtectSystem=full`. The symlink-per-version layout is now the documented way to swap corpora on the server (api/deploy/README.md "Corpus layout", spec §20, BUILD_CORPUS.md); `install.sh` no longer creates `data` as a real directory.
- Corpus download failed on Windows when the app was installed to the default
  Program Files location. The corpus and settings now go to `%APPDATA%\Kashshaf`.
  Existing portable installs are unaffected.
- The download screen now shows where files will go and whether you have room,
  before starting.
- Wildcard searches were not running as wildcards at all — the `*` was being
  stripped from the query.
- In 45 texts where page numbers restart each volume, the word-analysis popup
  could show words from the wrong volume.
- Root-mode highlighting was misplaced on about 9% of pages.
- Searching the same word twice (`الله الله`) was treated as a single word.

### Requires
This version requires corpus 4.0.0.

## [0.4.1] — 2026-05-08
- Lemma variant display and search.

## [0.4.0] — 2026-05-07
- Citation feature (Chicago, MLA) from `citation_json`; cleaned book metadata; sortable columns in the text browser and text selection.

## [0.3.1] — 2026-05-06
- Fix build error from package version mismatch.

## [0.3.0] — 2026-05-06 (required update)
- Vol:page navigation; `metadata.db` distributed with the corpus; reading-order sort of results.

## [0.2.3] — 2026-01-12
- Global page ids per book; updated data indices.

## [0.2.2] — 2026-01-11
- Collections.

## [0.2.1] — 2026-01-11
- Desktop build announcement fix.

## [0.2.0] — 2026-01-10
- Full corpus release; concordance feature removed; corpus schema and index update; matched token positions capped at 5 in results.

## [0.1.5] — 2026-01-06
- Web platform build.

## [0.1.0] – [0.1.4] — 2026-01-05
- Initial release, updater, startup modals, bug fixes.
