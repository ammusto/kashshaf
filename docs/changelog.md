# Changelog

## [0.7.0] — unreleased

**Search.** A phrase or a proximity pair split by a page break is found. Such a result sits on the page holding more of it and says at its edge *continues on p. 11* or *continues from p. 10*; in the reader a mark at the card's edge shows where the highlight runs on. Needs corpus 4.3.0. A phrase of more than 21 words is still searched but may miss a break, and the form says so.

## [0.6.0] — 2026-09-19

**Reading.** Pages scroll continuously and look like pages. Search highlights follow you as you scroll.

**Table of contents.** New pane on the right; follows your position, jumps on click. Ctrl+T.

**Search.** Sidebar folds away when you search; Ctrl+B brings it back with your query intact.

**Fixed.** Export returns the full 2,000 rows; the corpus update prompt no longer says "must" for optional updates.

**Web.** Scrolling a book no longer trips the server's rate limit: a page is one request (text, tokens and highlights together), only the pages in view and the next one are fetched, and if the server does ask the app to wait it waits quietly and carries on. The server gives the reader its own, larger allowance; searches keep the strict one.

## [0.5.3] - 2026-09-18

- The reader shows the book as one scrolling column of pages, each drawn as
  a page with its number at the corner. Reading on past the foot of a page
  needs no click; clicking a result places its page at the top and marks
  the hits on every page you scroll to. The Prev and Next buttons are gone:
  scroll, or type a page and press Go.
- A table of contents beside the text (Ctrl+T, or the Contents button). It
  follows the page you are on, and clicking a heading places its page. Its
  width is dragged from its edge. Needs corpus 4.2.0; online, the current
  server serves it.
- The search sidebar folds when a search runs, so the results and the text
  take the width; Ctrl+B or its button opens it again with your terms still
  in it.
- Opening a long book from a result no longer freezes the app: Tārīkh
  Dimashq (33,204 pages) opens in under 150 ms where it took seconds, and
  its contents pane draws only the headings in view.

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
