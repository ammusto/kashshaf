# Changelog

Changes to Kashshaf and to Kashshaf Lab. The two are released separately:
`## [X.Y.Z]` is Kashshaf, `## [lab X.Y.Z]` is Lab. Dates are build dates.
Nothing below has been published yet.

---

## [lab 0.6.0] - 2026-09-14

Lab is now arranged around the text you are reading rather than around its
features.

**A workspace.** Lab opens on the texts you are working on. Search the corpus
by title or author, filter by death year, genre or source, and add a text to
the workspace. Each one gets a folder on disk holding the isnāds you
confirmed, your reuse and Qurʾān verdicts, your notes, and where you left off.
Ctrl+S writes everything out. Ctrl+W goes back to the workspace. Settings and
About moved to a menu bar at the top.

**A Read panel.** Pages are named the way the book names them: `24` in a
one-part text, `1:24` in a multi-part one. Type a part and page to jump, or
use the arrow keys. Ctrl+T opens the table of contents, nested as the headings
are, and it follows you as you read. Select a passage to annotate it or to
look for reuse.

**Search this text.** The Kashshaf search box, narrowed to the open book, with
surface, lemma and root modes. Click a result to read it in place.

**Reuse.** The reader fills the left half, so you look for reuse while you
read. Results are one row per match: whose book, the words with their
context, the page. Click a row to open that page in the other book.

**Statistics.** The Sections tab is gone; every tab can now be limited to one
section instead. The concordance fills the pane and reads right to left. A root
works typed either way: `قول`, or `ق.#.ل` as results show it.

**Isnāds.** A chain that starts with a bare عن is now found. Extraction can be
limited to a section or a range of pages, and results appear as it goes.

**Qurʾān.** Quotations are listed in the order the book reads them.

**Network.** Draws the chains you have confirmed and redraws as you confirm
more. A transmitter you have not linked to a person appears as a hollow node.

**Long runs** show progress with Pause and Cancel, and ask first if they would
read more than 300,000 words or 2,000 pages. Both limits are in Settings.

Requires corpus 4.2.0 for the table of contents. An older corpus still works.

## [lab 0.5.0] - 2026-09-14

### Fixed

- Chains and matns that crossed a page break were cut short. Lab now reads the
  book as one stream, and marks the break where a chain runs on.
- An opening link was missed when a word stood between the verb and the name,
  and a place name was swallowed into the transmitter's name.
- Reuse found nothing for passages made of common words. It now looks for the
  rarest phrase rather than the rarest words, and finds 30 of the 31 passages
  in our test set, up from 26.
- Counting the corpus for keyness took an hour. It takes 40 seconds, and
  happens by itself the first time it is needed.
- A phrase that occurs in several āyāt was reported as one. It is now marked
  ambiguous with every reading listed.

### New

- **Network.** The transmission network of the current book, built from the
  isnāds you confirmed. Click a person for their neighbourhood. Export as CSV
  or GraphML.
- **Poetry (experimental).** Finds verse candidates and, where the text is
  vowelled, their meter. Never guesses.

### Also

- Clicking a transmitter opens the reader at that occurrence; clicking a name
  in the text selects its row.
- Isnād and Qurʾān settings moved behind a gear and are remembered.
- The Qurʾān table drops the volume prefix for single-volume books and trades
  four columns for details on demand.

## [lab 0.4.0] - 2026-09-14

### New: Reuse

Find where a passage of the current book appears elsewhere in the corpus.

- Select a passage and Lab lists the matches by book, each scored and typed as
  verbatim, inflected, paraphrase, weak or formulaic. See the matching words
  side by side.
- On a local corpus, analyse the whole book: a time estimate first, progress
  as it runs, and a Cancel that keeps what is done.
- The score threshold and the type filter re-sort what is found without
  running again. Formulaic matches are hidden by default.
- Confirm or reject each match. Export a run as CSV or JSON.

### New: Qurʾān

Finds Qurʾānic quotations across the book, exact or inflected, with or without
brackets or a cue, and lists them by sūra and āya. Confirm or reject; your
decisions survive a re-run. The Qurʾān ships inside Lab, so this needs no
corpus.

## [lab 0.3.0] - 2026-09-14

### New: the Isnād workbench

Lab finds the chains of transmission in the current book and gives you a place
to check them.

- **Extract** marks every candidate chain with a confidence score and the
  reasons behind it. It can be cancelled and never discards your decisions.
- **Review** each one in the text, with the chain laid out above the page.
  Confirm or reject, move the isnād and matn boundary, split or merge a
  transmitter, retag a word. After the same correction three times, Lab offers
  to remember it.
- **Transmitters** are listed with their parts, how often they occur, and the
  person they belong to. A likely match is suggested, never applied for you.
- **The authority file** links transmitters to persons: rename, merge, add a
  death year, split apart. Undo with Ctrl+Z.
- **Export** isnāds and the authority file as CSV or JSON.

Keyboard: `c` confirm, `x` reject, `j` and `k` to move, `l` to link.

## [lab 0.2.0] - 2026-09-14

### New: the Stats panel

Six views of the current book, on the surface, lemma or root layer, with or
without stop words, for the whole book or one section.

- **Frequencies**, with the corpus count and rank alongside.
- **Concordance**, with the same matching as a Kashshaf search. Click a line to
  read it.
- **Keyness**: what this book uses more, and less, than the rest of the corpus,
  the same author, genre or century, or books you choose.
- **Dispersion**: where a word falls across the book, with a per-section
  breakdown.
- **Collocations** and **n-grams**.
- **Sections**: the table of contents with each section's length.

Every table sorts and exports to CSV or JSON.

Online mode now loads whole books, so every tab works without a local corpus.
Keyness needs corpus word counts that newer corpora ship; without them Lab says
so rather than guessing. Loading a book is 22 times faster.

## [lab 0.1.0] - 2026-09-13

### New: Kashshaf Lab

A companion application for studying one text in depth against the corpus. It
installs and updates separately from Kashshaf and reads the same corpus without
ever writing to it.

This first build can find your corpus and open it, or work online when you have
no local copy, and it tells you which it is doing. You can browse the corpus,
choose a book, read it with full tashkil, click a word for its morphology, and
select a passage.

Lab keeps its own data beside Kashshaf's, so deleting Kashshaf's corpus never
touches your work.

## [0.5.2] - 2026-09-13

- The corpus update prompt now tells an optional update apart from a first
  install. With a working corpus you can see what changed and update later.
- Exporting results stopped at 250 rows. It now pages through to the 2,000-row
  limit.

## [0.5.1] - 2026-09-12

Server and release fixes. No changes to the app.

## [0.5.0] - 2026-09-12

**Faster search.** Most searches are 2 to 10 times faster, and the corpus
download is about a third smaller.

**Accurate result counts.** Proximity and wildcard searches used to report
counts that were too low, sometimes by a lot. Counts are now exact, or marked
as a lower bound (`20,000+`) when a search matches too much to count quickly.
Working from local data, you can turn on exact counts for every search.

**Better wildcards.** Wildcards work anywhere in a word and you can use more
than one: `أب*`, `*رف`, `أح*مد`, `*قول*`, `مع*رف*`. Wide patterns like `ال*` no
longer fail. Wildcards are still surface-mode only and need at least two
letters.

**Scrolling results is instant.** The next page no longer re-runs the search.

**New:** a Settings window, an exact-counts option, and a panel showing where
your corpus lives.

### Fixed

- The corpus download failed on Windows when Kashshaf was installed to Program
  Files. The corpus and settings now go to `%APPDATA%\Kashshaf`.
- The download screen now shows where files will go and whether you have room.
- Wildcard searches were not running as wildcards; the `*` was being stripped.
- In 45 texts where page numbers restart each volume, the word popup could show
  words from the wrong volume.
- Root-mode highlighting was misplaced on about 9% of pages.
- Searching the same word twice (`الله الله`) was treated as one word.

### Requires

Corpus 4.0.0.

## [0.4.1] - 2026-05-08

- Lemma variants in display and search.

## [0.4.0] - 2026-05-07

- Citations in Chicago and MLA style, cleaner book metadata, sortable columns
  in the text browser.

## [0.3.1] - 2026-05-06

- Fixed a build error from a package version mismatch.

## [0.3.0] - 2026-05-06 (required update)

- Volume and page navigation, book metadata shipped with the corpus, results in
  reading order.

## [0.2.3] - 2026-01-12

- Page numbering per book, updated data.

## [0.2.2] - 2026-01-11

- Collections.

## [0.2.1] - 2026-01-11

- Fixed the desktop build announcement.

## [0.2.0] - 2026-01-10

- Full corpus release. Concordance removed. Matched words in a result capped at
  five.

## [0.1.5] - 2026-01-06

- Web build.

## [0.1.0] to [0.1.4] - 2026-01-05

- First release, updater, startup screens, fixes.
