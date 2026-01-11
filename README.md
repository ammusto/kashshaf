# Kashshāf

Desktop application for searching medieval Arabic texts (pre-750/1350) with token-level morphological data.

## Features

- **Lemma Search** - Find all inflected forms of a word automatically
- **Root Search** - Search by Arabic triconsonantal root across all derivations
- **Surface Search** - Exact word matching with optional clitic expansion
- **Proximity Search** - Find terms within N words of each other
- **Name Search** - Search Arabic personal names with pattern generation for kunyas, nasab, nisbas
- **Wildcard Search** - Prefix and infix patterns (e.g., `أب*`, `أح*مد`)
- **Boolean Queries** - Combine terms with AND/OR logic
- **Token Overlay** - Click any word to see morphological analysis (lemma, root, POS, features)
- **Filtering** - By period, author, genre, or specific texts
- **Export** - Results and metadata to CSV/Excel

> **NB:** Morphological analysis uses CAMeL Tools with the MSA morphological database. While MSA and Classical Arabic share core grammar, archaic vocabulary or rare classical forms may produce inaccurate lemmas or POS tags.

## Architecture

The application uses a dual-mode architecture with an API abstraction layer that allows  switching between local and remote data sources.

| Layer | Technology |
|-------|------------|
| UI | React 18, TailwindCSS |
| Desktop Runtime | Tauri 2.x (Rust) |
| Search Engine | Tantivy (local) / REST API (remote) |
| Database | SQLite (tokens, metadata, history) |

**Offline Mode** - Full corpus stored locally (~16 GB). Best performance, no internet required.

**Online Mode** - Query remote API. No download required, but needs internet connection.

## Platforms

- Windows
- macOS (Universal: Intel + Apple Silicon)
- Linux (AppImage, deb)

## Development

### Prerequisites

- Node.js 20+
- Rust toolchain (stable)
- Platform-specific dependencies for Tauri

### Setup

```bash
npm install
npm run tauri dev
```

### Build

```bash
npm run tauri build
```

## Data

### Corpus Statistics

| Metric | Value |
|--------|-------|
| Books | 6,917 |
| Pages | 5,495,060 |
| Tokens | 943,471,799 |
| Unique token definitions | 4,529,873 |
| Database size | ~16 GB |

### Data Pipeline

The corpus is built with texts from al-Maktaba al-Shamela (4679), the OpenITI/KITAB corpus (2169), and Nuṣūṣ (69)  through the following pipeline:

```
Shamela/OpenITI/Nuṣūṣ Sources
        │
        ▼
   Fix Pages ────────► Split long pages, remove editorial content (e.g. endnotes and footnotes)
        │
        ▼
   Clean Text ───────► Remove markup, normalize Arabic
        │
        ▼
   BERT Analysis ────► Morphological tokenization
        │
        ▼
   ┌────┴────┐
   ▼         ▼
SQLite    Tantivy
Tokens    Index
```

**Stage 1: Fix Pages** - For texts without pagination, splits pages >2000 tokens, removes endnotes and malformed markers

**Stage 2: Clean Text** - Strips HTML/XML, URLs, OpenITI tags; normalizes whitespace

**Stage 3: BERT Morphological Analysis and Lexical Features** - Uses CAMeL Tools with BERT disambiguation to extract:
- Surface form (normalized Arabic)
- Lemma (dictionary base form)
- Root (3-letter Semitic root)
- POS tag and grammatical features
- Clitics (attached particles)

> **NB:** Morphological analysis uses CAMeL Tools with the MSA morphological database. While MSA and Classical Arabic share core grammar, archaic vocabulary or rare classical forms may produce inaccurate lemmas or POS tags.

**Stage 4: Build SQLite Database** - Stores morphological and lexical feature data of 943M token occurrences but deduplicates definitions (4.5M unique) via foreign keys to shared lemma/root tables, achieving ~208x compression

**Stage 5: Build Tantivy Index** - Full-text search index with three searchable fields (surface, lemma, root) and contains full body text for page display

### Storage

| File | Size | Purpose |
|------|------|---------|
| corpus.db | ~5.2 GB | Token database (morphological data) and metadata content|
| tantivy_index/ | ~10.9 GB | Full-text search index and text content |


## License

MIT

## Acknowledgments

- [Shamela](https://shamela.ws/) for main source texts
- [OpenITI](https://openiti.org/) for additional source texts
- [Nusus](https://www.nusus.net/) for additional source texts
- [CAMeL Lab](https://camel-lab.com/) for Arabic NLP tools
