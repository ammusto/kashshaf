# Kashshaf Lab changelog — Lab is versioned and released separately from Kashshaf; its sections are `## [lab X.Y.Z]`.

## [lab 0.10.0] - 2026-09-15

### Search

A phrase split by a page break is found (corpus 4.3.0). The hit says at its edge where the rest is, and the reader marks the edge of the page the highlight runs off. A phrase of more than 21 words is still searched but may miss a break; the form says so.

### Name disambiguator

One man is written a dozen ways across a book. The isnād panel has a Name
disambiguator: every name in the text with its count on the left, and on the
right the names that might be the same person.

A name is offered only if every part the two names share agrees: ism with
ism, first ancestor with first ancestor, nisba with nisba. A part that only
one of them has is ignored, because that is a name written short. Nothing is
compared letter by letter, so جابر and جاحظ are two men and أحمد بن علي and
أحمد بن علي بن جعفر are one.

Names that agree except for a pair that is easily confused, الحسن for
الحسين or سعد for سعيد, are listed separately under Commonly confused. They
are never mixed in with the rest.

The list is ordered by how often the two keep the same company in a chain: a
name that receives from the same teacher and passes to the same student is
usually one man. Each row says which parts agree, who stood on either side,
and a page that opens in the reader, so you can decide without reading five
chains first.

Same person merges every occurrence of the chosen names and can be undone.
Not the same is remembered, and that pair is never suggested again.

Link, Same person and Accept all suggestions have left the isnād table. Use
the disambiguator. Retagging stays, and Remove tag is next to it.

### Reader

Click a word for its lemma, root and part of speech, as in Kashshaf.

Clicking a result from Stats, Search, Qurʾān, Poetry, the annotations list
or the isnād list now scrolls to the highlighted words. They used to be
marked somewhere below the fold.

The contents are drawn as a tree, each level stepped in from the last.
Only the rows in view are drawn, so a book with ten thousand headings opens
its contents as fast as one with ten.

### Annotations

The note is shown once in the box you type it into, the contents list shows
the note rather than the Arabic it sits on, and the strip across the foot of
the reader is gone. The highlight in the text is how you reach an
annotation.

### Concordance

The words before and after the hit now sit against it instead of drifting to
the edges of the table. Headings are centred.

### Reuse

Find in selection, Find in section, Find in whole text. Opening a result
shows the two texts aligned word by word straight away.

### Network

Direct Sources of Author, with its count, and the single-person view is
headed Node Network of that person. Sources drawn on the canvas are coloured
in the list.

## [lab 0.9.0] - 2026-09-15

### Annotations

Annotations now show in the text, as a coloured highlight behind the words
they are on. Hover to read the note, click to edit it. Pick one of six
colours when you write it, and mark words in the note bold or underlined.

The contents pane has an Annotations list at the bottom, closed until you
open it. It gives the page, the words and the first line of each note, in
reading order, and takes you there.

The annotation box now says where you are the way the rest of Lab does:
volume and page, and the volume only when the text has more than one.

### Cite

A Cite button in the reader gives the text's citation in Chicago or MLA,
with the page you are on, and copies it. Same citations as Kashshaf.

### Metadata

A Metadata panel above Read, showing everything the corpus knows about the
open text: the same record the workspace browser shows, without the buttons.

### Network

Clicking a person used to quietly replace the whole graph with that person
and their neighbours, which looked like a graph with almost nothing in it.
It now says so, with the numbers, and offers the way back. A direct source
with no link to draw is marked instead of silently missing, the number of
sources is on the heading, and the number of unlinked names is on screen,
with a word about what linking them does.

## [lab 0.8.0] - 2026-09-15

### Panels fill the window

Isnad, Qur'an, Poetry and Stats drew themselves in a narrow column with dead
space to the right and below. All four had the same fault in their outermost
element. Fixed once, for every panel, with a test that keeps it fixed.

### Contents

Entries with sections under them now carry a triangle. Click it to open the
subtree, click the title to go to the page. Everything below the top level
starts closed, so a long book opens as a list of chapters rather than a wall
of headings. Paging into a section opens the way down to it.

### Network

The graph fills the panel instead of sitting in a fixed square. Scroll or
pinch to zoom, drag to move, and use the buttons for a step at a time, Fit,
or back to full size; the percentage is always on screen. The layout is no
longer squeezed into a box, so crowded graphs spread out instead of piling
up on the edge. Names shrink with the graph and disappear when they would be
too small to read. A search box finds a person and centres on them.

### Reuse

A result now opens the other book in its own reader beside yours, in place of
the table. Your text stays where it is with your words marked in green; the
other text opens at the matching page with its words in red. Both read like
the reader everywhere else: pages, contents, headings. Back to results brings
the table back and leaves your place alone. The word by word alignment is
still a toggle above the two texts.

## [lab 0.7.0] - 2026-09-15

### Fixed

- The Network panel went white on opening, for any text with a transmitter
  you had not linked yet, which is every text before you start. Every panel
  now fails on its own: you get the message and the rest of the app keeps
  working.
- Page text ran together as one paragraph. Line breaks in the source are kept,
  in the reader, in Reuse and in the Qurʾān details. Headings look like
  headings instead of running into the prose after them.
- Selecting several lines in Reuse pushed the text over the results.
- Poetry meter was found for almost nothing. Two faults: a verse carrying its
  number in Arabic-Indic digits was unreadable to the scansion, and a word
  ending in tanwīn fatḥa was counted a syllable long. Meters found went up by
  a fifth. Most verse in the corpus still has too little tashkil to scan, and
  is reported unknown rather than guessed.

### Read and Search are one panel

The search form sits down the left, the text fills the middle, results appear
underneath, and the contents stay on the right. Drag the divider to give
either more room. Click a result and the text above moves to that page with
the hit marked. Your results, your place in the text and the form all survive
a trip to another panel.

The text now selects like text: drag to select, copy, no overlay in the way.
Annotate and Find reuse on this page are buttons in the reader's toolbar.

### Reuse

Three buttons where the dead end was: Analyse selected, Analyse section,
Analyse whole text. Section and whole text show what they will read and
roughly how long it will take before they start, and can be cancelled at any
point, including while they are working that out.

Results read Page, Text, Book, at a size you can read. Hovering the title
gives the author and death year. Clicking a result opens that page in the
reader on the left, where a page belongs, with a way back.

### Appearance

Body text is black, and there is one grey instead of three. Matched words are
red, the same red everywhere. English placeholders in Arabic boxes read left
to right again. The workspace pane is wider, sorts from a proper header, and
you can drag its edge; the width is remembered. Stats fills its panel and its
layer control looks like a control.

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
