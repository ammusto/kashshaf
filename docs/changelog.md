# Changelog

All notable changes to the Kashshaf desktop app, API server, and data pipeline, and to Kashshaf Lab. The two products are released separately: `## [X.Y.Z]` sections are Kashshaf, `## [lab X.Y.Z]` sections are Lab. Format loosely follows Keep a Changelog. Dates are build dates; nothing below has been tagged or published yet.

---
## [lab 0.6.0] — 2026-09-14

A week of use, and the answer was mostly that the app was arranged around
its features rather than around a text. This release rearranges it around
the text, and fixes what got in the way of reading one.

**The workspace**

- **Lab opens on a workspace, not on a panel.** The texts you are working
  on are listed down the left, by name or by when you last opened one; the
  whole corpus is searchable down the right, reproducing Kashshaf's Text
  Selection view — title and author search that ignores how the hamza was
  written, a death-year range, genre and corpus filters, sortable columns.
  Clicking a text shows its metadata with one added button, **Add to
  Workspace**.
- **A text in the workspace has a folder on disk**, under
  `KashshafLab/workspace/<book id>/`: its metadata, the isnāds you
  confirmed and their transmitters, the ones you rejected, your reuse and
  Qurʾān verdicts, your notes, and where you were reading. Every decision
  writes the file it belongs to as you make it; **Ctrl+S** writes all of
  them. Opening a text whose folder holds something the database does not
  reads it back in, re-anchoring spans whose page has moved. Settings has
  **Open workspace folder**. Removing a text deletes its folder after
  asking, and leaves what you found in the database.
- **Ctrl+W** returns to the workspace. Settings and About moved to a menu
  bar at the top; the left rail is now only what you can do to the open
  text: Read · Search · Stats · Isnād · Reuse · Qurʾān · Network · Poetry.

**Reading**

- **A Read panel.** The page you are on is named the way the book names it:
  `24` in a one-part text, `1:24` in a multi-part one — the number printed
  on the page and the part counted from one. Never `0:24`, never the
  corpus's internal page id, never "page 20 of 405". The same rule is now
  used by every table in the app.
- Type a part and a page and press Go; ← and → turn the page (→ goes back,
  as the text reads).
- **A table of contents**, nested as the headings nest, on **Ctrl+T**.
  Clicking an entry jumps there; the entry you are inside stays marked as
  you read. It comes from a new `toc.db` shipped with the corpus: 2.4
  million headings over 6,083 of the 7,199 books.
- **Select a passage and annotate it.** Notes are kept with the text, drawn
  where they sit in it, and written to the workspace folder.
- **Search this text**: Kashshaf's boolean search narrowed to the open
  book, with the same surface, lemma and root modes and the same clitic
  handling, and results that lead back into the reader at the page.

**Reuse**

- The left half is now the reader itself, with its navigation and its
  contents, so finding reuse is something you do while reading.
- The results answer one question: who else has this passage. One row per
  match — whose book and when they died, the words themselves with what
  surrounds them, the page — ordered by how good the match is. Clicking a
  row opens that page in the other book, with a way back; the aligned
  side-by-side view is a toggle there.
- The thresholds, the banality scale, the kinds of match and "exclude this
  book" moved behind a gear, and **Analyse section** sits beside Analyse
  whole text.

**Statistics**

- The Sections tab is gone. What it was for — looking at one section — every
  tab now does, because Layer, Stop words and Section moved out of the tab
  bar to sit with the statistic they qualify.
- The concordance fills the pane and reads right to left: the words before
  the hit to its right, the words after it to its left.
- A root can be typed bare (`قول`) or in the form results show it
  (`ق.#.ل`); both find the same word, in the concordance and in dispersion.
- Arabic input boxes are set at a size the script can be read at.

**Isnād, Qurʾān, network**

- **A bare عن opens a chain.** A page that carries on from the chain before
  it, with no reporting verb in front, was invisible to the extractor.
- Extraction can be limited to **the whole text, one section, or a range of
  printed pages**, and its results appear as pages finish rather than in
  one lump at the end.
- **Qurʾān quotations list in the order the book reads**, page by page.
- **The network draws what you have confirmed**, and redraws as you confirm
  more. A transmitter you have not linked to a person is a node of its own,
  drawn hollow, labelled with the form as written; linking it merges it
  into the person. One confirmed chain is enough. With none, the panel says
  so and shows nothing else.

**Long operations**

- A run shows a bar with its progress, **Pause** and **Cancel**. The bar
  goes when the run ends; a cancelled run leaves a line saying how far it
  got, and everything it found is kept.
- A run that would read more than 300,000 words or 2,000 pages asks first,
  showing what it will read. Both numbers are in Settings.

**Requires** corpus 4.2.0 for the table of contents. Lab opens an older
corpus and works, and says where the contents would have been.

---
## [lab 0.5.0] — 2026-09-14

Two days of real use turned up six things that distorted results; they come
first. Then the last two views.

**Fixed**

- **Isnāds and matns cross page breaks.** The extractor read each page on
  its own, so a chain that began at the foot of a page lost its remaining
  links and a matn that ran on was cut. It now reads the book as one
  stream: an open chain continues on the next page and a matn runs to its
  real end (the next chain, a ḥadīth number, a heading, or five pages). The
  workbench shows such a span with the page break marked and lets you step
  through its pages.
- **An opening link was missed** when a word like *به* stood between the
  verb and the name (`أخبرنا به يحيى بن محمد العكرمي بالكوفة`), and a place
  tag (*بالكوفة*, *بمصر*) was swallowed into the name. Both are handled; the
  place is kept on the transmitter.
- **Reuse found nothing for a passage made of common words** (`من أين
  تأكلون فقال لسنا نعرف الأسباب`) although it occurs verbatim in seven
  books. Anchors are now chosen by how rare a phrase is in the corpus, not by
  how rare its words are, and a short passage is also looked up whole. On the
  full corpus the gold set went from 26 to 30 of 31 found.
- **Building the frequency snapshot took about an hour**; it takes 40 s on
  the full corpus, gives the same bytes, and happens by itself the first
  time keyness or reuse needs it.
- **Dev builds missed an installed corpus** in the per-user data folder.
- **A Qurʾānic phrase that occurs in several āyāt** (`فبأي آلاء ربكما
  تكذبان`) was reported as one āya; it is now marked ambiguous with every
  āya listed.

**Workbench and panels**

- Clicking a transmitter row opens the reader at that occurrence with the
  name highlighted (a grouped row offers its occurrences); clicking a name
  in the text selects its row. Clicking the pane background, or Escape,
  clears the highlight.
- The isnād and Qurʾān parameters moved behind a gear beside the panel's
  main button, with Apply and Reset; they are remembered.
- The Qurʾān table scrolls to every row, drops the volume prefix for
  single-volume books, and trades four columns for an ⓘ that opens the
  details — agreement, cue, every reading, and the āya with one āya of
  context in imlāʾī or Uthmani.

**New: Network.** The transmission network of the current book, built
from the isnāds you have confirmed and the transmitters you have linked:
persons as nodes, "B transmitted from A" as edges weighted by count. A
force layout with a node cap and a minimum edge weight; click a person for
their neighbourhood and their transmitter rows; the author's direct sources
by count; export as CSV or GraphML.

**New: Poetry (experimental).** Find verse candidates by hemistich markers
or wide whitespace and, where the text is vowelled, their meter by ʿarūḍ
scansion — unknown otherwise, never guessed. Table, reader layer, CSV.

*Spec 1.4: §4.2, §4.3, §4.4, §4.5, §4.6, §6.2, §6.4. Phase 4 of the Lab spec.*

## [lab 0.4.0] — 2026-09-14

**New: Reuse.** Find where a passage of the current book is reused elsewhere
in the corpus — or, on the local corpus, everything the whole book reuses.

- **Find reuse**: select a passage in the reader and Lab retrieves candidate
  pages through the index, aligns the passage against each, and lists the
  matches grouped by source book with a score and a *type* — verbatim,
  inflected, paraphrase, weak, or formulaic — derived from how far the two
  texts agree on surface, lemma and root. Each match shows its target text
  with the aligned words marked, a side-by-side view with aligned words
  connected by colour, and a link back to the passage. Works in both modes.
- **Analyse whole book** (local corpus only): every window of the book, with a
  time estimate before you start, progress per page, and a Cancel that keeps
  what is done. Results as a ranked table of source books, per-book match
  lists, and a highlight layer in the reader.
- **Sliders, not re-runs**: the score threshold, the type filter and the
  banality penalty re-score the stored matches instantly. Formulaic matches
  — chains of transmission, opening formulae — are hidden by default.
- **Confirm / reject** each match; confirmed pairs become the reuse gold set
  that `lab-cli reuse-eval` measures against. Export a run as CSV or JSON.

**New: Qurʾān.** *Detect quotations* finds Qurʾānic quotations across the
current book — exact and inflected, with or without ﴿ ﴾ brackets or a
"قال تعالى" cue — and lists them by sūra:āya with the page, the text as
quoted, the āya, the agreement and the cue. Confirm or reject; judged rows
survive a re-run. The Qurʾān ships inside Lab: no corpus is needed for it.

**Under the hood**

- The Qurʾān is ingested through the same morphology pipeline as the corpus
  (`kashshaf-data-clean/ingest_quran.py`, Tanzil imlāʾī text; Uthmani kept
  for display) and embedded in the binary with its āya token ranges.
- `analysis.db` migration 3 adds `reuse_run`, `reuse_match`, `reuse_gold`
  and `quran_match`.
- `lab-cli` (`reuse-eval`, `reuse-find`, `quran-scan`) and two new
  corpus-gated tests: the banality probe and the Quran_Detector baseline.
- Candidate retrieval (`BookSource::find_pages`) is the same index query in
  both modes; the mode-parity test checks it.

*Spec: §4.3, §4.4, §6.4, §7.5, §7.6. Phase 3 of the Lab spec.*

## [lab 0.3.0] — 2026-09-14

**New: the Isnād workbench.** Lab finds the chains of transmission in the
current book and gives you a place to check them.

- **Extract isnāds** reads the whole book and marks every candidate chain,
  with a confidence score and the reasons behind it. Extraction streams page
  by page, can be cancelled, and never discards a decision you have made.
- **Review** each candidate in the text: the chain outlined, every
  transmitter in its own colour, the transmission verbs and the matn in
  theirs, with the chain laid out as `[verb] transmitter ← [verb]
  transmitter ← … ← matn` above the page. Confirm or reject; move the
  isnād/matn boundary; split or merge a transmitter; retag a word the
  machine misread — and after the same correction three times, add it to
  the lexicon.
- **Transmitters** in a table on the right: the raw form, its parts (kunya,
  ism, nasab, nisba, laqab), how often it occurs, and the person it is
  linked to. A form that matches a person you have already named is
  *suggested* — shown dashed, never applied until you say so.
- **The authority file**: link transmitters to persons, declare two the
  same person, rename, add a death year and notes, split a person back
  apart. Every action is undoable in the session (Ctrl+Z / Ctrl+Y) and
  kept permanently in an audit log.
- **Export** isnāds (one row per transmitter, or nested) and the authority
  file as CSV or JSON.
- The transmission-verb and formula lexicons ship with defaults you can
  edit; your edits survive updates.

Keyboard: `c` confirm, `x` reject, `j`/`k` next/previous, `l` link, and the
rest in the Lab README.

*Spec sections implemented: §4.2 extraction, §6.2 isnād tables, §6.3
authority file, §6.5 lexicons, §6.6 isnād and authority exports, §7.4
workbench. Spec amended to 1.3 (§3.1, §3.4). Baseline against the draft gold
set: isnād span F1 0.77, transmitter F1 0.83.*

## [lab 0.2.0] — 2026-09-14

**New: the Stats panel.** Six tabs over the current book, on the surface,
lemma or root layer, with or without stop words, for the whole book or one
section:

- **Frequencies** — every word with its count and rate, and the corpus count,
  rank and rate alongside.
- **Concordance** — every hit of a word or phrase with its context, using the
  same matching as a Kashshaf search (wildcards, clitics); click a line to
  open the reader at that page with the hit marked.
- **Keyness** — what this book uses more, and less, than the rest of the
  corpus, the same author, genre or century, or books you choose; scored by
  log-likelihood with a Bayes-factor threshold and Log Ratio.
- **Dispersion** — where a word falls across the book, as a strip plot and
  Gries's DP, with a per-section breakdown.
- **Collocations** and **n-grams** — words that keep company, scored three
  ways (MI, log-likelihood, t-score).
- **Sections** — the table of contents with each section's length; any tab
  can be restricted to one section.

Every table sorts by any column and exports to CSV or JSON.

**Online mode now loads whole books** through a new server route, cached on
disk, so every Stats tab works without a local corpus. Keyness against the
corpus needs a frequency snapshot that newer corpora ship; without it Lab
says so rather than guessing. Settings gains the stop-word editor and, in
local mode, a one-off build of that snapshot.

Loading a book is 22× faster than in 0.1.0.

*Spec sections implemented: §3.4 frequency snapshot, §4.1 text statistics,
§5.1 bulk token route, §7.3 Stats panel, §9 mode parity. Spec amended to 1.2
(§1, §2.4, §3.1, §3.3, §5.1, §10).*

## [lab 0.1.0] — 2026-09-13

**New: Kashshaf Lab**, a companion application for studying one text in depth
against the corpus — concordance, keyness, isnād extraction, text reuse and
Qurʾān detection. It installs and updates separately from Kashshaf and reads
the same corpus, without ever writing to it.

This first build is the foundation, not yet the analysis. It can:

- find your corpus and open it read-only, or work online against
  `api.kashshaf.com` when you have no local copy — and tell you which it is
  doing, and why, in the badge at the top right;
- browse and search every book in the corpus and choose one to work on;
- read that book page by page with full tashkil, click any word for its
  morphology, and select a range of words — the selection later features will
  act on.

Lab keeps its own data in `KashshafLab` beside Kashshaf's, so deleting
Kashshaf's local corpus never touches your analyses.

The analysis panels — Stats, Isnād, Reuse, Qurʾān, Network, Poetry — are
listed and marked with the release each will arrive in.

*Spec sections implemented: §2.1 layout and versioning, §2.2 shared crates,
§2.3, §2.4 modes, §2.5 directories, §3.1 `BookSource`, §3.2 page model, §3.3
alignment contract and `verify_alignment`, §6 `analysis.db` bootstrap and
migrations, §7.1 shell, §7.2 reader.*

## [0.5.2] — 2026-09-13

**Fixed:** the corpus update prompt now distinguishes an optional update from a first install. If you have a working corpus and a newer one is available, you'll see what changed and can choose to update later.

**Fixed:** exporting results stopped at 250 rows. Export now pages through the search 250 rows at a time up to the 2,000-row limit.

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
