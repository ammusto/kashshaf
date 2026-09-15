# Kashshaf Lab

A desktop application for studying one premodern Arabic text against the
Kashshaf corpus. In development; not released.

## Build

Node 20+ and a stable Rust toolchain. Lab has its own `node_modules`, so run
these from `lab/`.

```sh
npm install        # once
npm run tauri dev  # development, Vite on 5174
npm run tauri build
```

## Test

```sh
cargo test -p kashshaf-lab   # from the repository root
cd lab && npm test
```

Some suites need a sample corpus and skip without one. Point them at it and
use `--release`, since they read every page:

```sh
export KASHSHAF_SAMPLE_DIR=/path/to/sample-mini
cargo test -p kashshaf-lab --release --test alignment
```

The same applies to `mode_parity`, `isnad_gold`, `banality_probe`,
`quran_baseline` and `pos_audit`. `mode_parity` also needs a running
`kashshaf-api` on the same corpus. `freq_snapshot` needs `KASHSHAF_FREQ_DIR`
pointing at tables built by `build_lab_freq.py`.

## Layout

```
lab/
├── fixtures/    gold sets and the Qurʾān detector baseline
├── src/         React frontend
├── src-tauri/   Rust backend
│   ├── src/     source, lexicons and the embedded Qurʾān
│   └── tests/   the corpus-gated suites
└── scripts/     developer tools, Python
```

## Spec

`dev-docs/KASHSHAF_LAB_SPEC.md` is the contract Lab is built against. That
directory is gitignored, so the file is local to each machine and not in the
repository.
