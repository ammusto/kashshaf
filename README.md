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
- **Concordance Mode** - KWIC (keyword in context) display
- **Token Overlay** - Click any word to see morphological analysis (lemma, root, POS, features)
- **Filtering** - By period, author, genre, or specific texts
- **Export** - Results and metadata to CSV/Excel

## Architecture

The application uses a dual-mode architecture with an API abstraction layer that allows  switching between local and remote data sources.

| Layer | Technology |
|-------|------------|
| UI | React 18, TailwindCSS, TanStack Virtual |
| Desktop Runtime | Tauri 2.x (Rust) |
| Search Engine | Tantivy (local) / REST API (remote) |
| Database | SQLite (tokens, metadata, history) |

**Offline Mode** - Full corpus stored locally (~8 GB). Best performance, no internet required.

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

The corpus includes medieval Arabic texts from OpenITI, processed with CAMeL Tools for morphological analysis. Each token includes:

- Surface form (normalized)
- Lemma (base form)
- Root (triconsonantal)
- Part of speech
- Grammatical features
- Clitics

## License

MIT

## Acknowledgments

- [Shamela](https://shamela.ws/) for main source texts
- [OpenITI](https://openiti.org/) for additional source texts
- [CAMeL Lab](https://camel-lab.com/) for Arabic NLP tools
