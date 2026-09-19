# Kashshāf

Desktop application for searching  Arabic texts (pre-1930) with token-level morphological data. Features and documentation at [kashshaf.com](https://www.kashshaf.com/).

## Features

- **Lemma search**: all inflected forms of a word
- **Root search**: every derivation of a triconsonantal root
- **Surface search**: exact forms, with optional clitic expansion
- **Proximity search**: terms within N words of each other
- **Name search**: pattern generation for kunya, nasab, and nisba
- **Wildcards**: prefix, suffix, and infix patterns (`أب*`, `*رف`, `أح*مد`)
- **Boolean queries**: AND/OR combinations
- **Token overlay**: click any word for lemma, root, POS, and features
- **Table of contents**: chapter structure for every text that has one
- **Filtering**: period, author, genre, or chosen texts
- **Export**: results and metadata to CSV

Morphological analysis uses CAMeL Tools with the MSA database. Archaic vocabulary and rare classical forms may receive inaccurate lemmas or tags.

## Architecture

| Layer | Technology |
|---|---|
| UI | React 18, Tailwind CSS |
| Desktop | Tauri 2 (Rust) |
| Search | Tantivy (local) or REST API (remote), sharing one engine crate |
| Storage | SQLite (tokens, metadata, contents), Tantivy index |

**Offline**: full corpus on disk (8.8 GB). **Online**: queries go to the API; no download.

## Platforms

Windows, macOS (Intel and Apple Silicon), Linux (AppImage, deb).

## Development

Node 20+, stable Rust, and Tauri's platform prerequisites.

```bash
npm install
npm run tauri dev
npm run tauri build
```

The workspace also contains `api/` (the server), `engine/` (shared search), and `lab/` (Kashshaf Lab, in development).

## Corpus

Version 4.2.0.

| | |
|---|---|
| Texts | 7,199 |
| Pages | 5,728,205 |
| Tokens | 991,616,029 |
| Distinct surface/lemma/root triples | 2,993,181 |
| Download | 8.8 GB |

Sources: al-Maktaba al-Shāmila (4,679 texts), OpenITI/KITAB (2,451), Nuṣūṣ (69). All texts are from authors who died before 1348/1930.

### Pipeline

```
sources → canonical JSON → clean → CAMeL BERT morphology → corpus.db + Tantivy index
```

1. **Convert**: Shamela JSON, OpenITI mARkdown, and Nuṣūṣ TEI to one page-level JSON format. Long unpaginated pages are split; endnotes and footnotes removed.
2. **Clean**: markup, control tokens, and stray Latin removed; entities decoded; chapter headings preserved as `<title>` tags.
3. **Analyse**: CAMeL Tools with BERT disambiguation assigns surface, lemma, root, POS, features, and clitics to every token.
4. **Build**: token definitions deduplicated into a triple table; page token streams stored as compressed id blobs; a single-segment Tantivy index in reading order; table of contents and frequency tables as sidecars.

Pipeline code and metadata are in the separate `kashshaf-data` repository.

### Files

| File | Size | Contents |
|---|---|---|
| `corpus.db` | 2.9 GB | token streams, definitions, triples |
| `tantivy_index/` | 6.0 GB | full-text index and page bodies |
| `toc.db` | 253 MB | chapter structure |
| `triples.bin` | 168 MB | surface/lemma/root maps |
| `metadata.db` | 41 MB | texts, authors, genres |
| `lemma_freq.bin`, `root_freq.bin` | 30 MB | corpus frequencies |

## License

MIT

## Acknowledgments

[Shamela](https://shamela.ws/), [OpenITI](https://openiti.org/), and [Nuṣūṣ](https://www.nusus.net/) for the texts. [CAMeL Lab](https://camel-lab.com/) for the Arabic NLP tools.
