# Release Process — Analysis and Proposal

**Date:** 2026-09-10
**Scope:** everything between "code is ready" and "users have it": app installers, web app, API, website, corpus files, manifests, announcements.

---

## 1. What exists today

Five deliverables, three repos, one script, two workflows, and a lot of hand steps.

### 1.1 Desktop app (`kashshaf-app`)

| Step | How | Who |
|---|---|---|
| Bump version | `scripts/release.py X.Y.Z` edits `src-tauri/Cargo.toml`, `api/Cargo.toml`, `src-tauri/tauri.conf.json`, `package.json` | script |
| Release notes | typed interactively into `release.py` | human |
| `app_manifest.json` | `release.py` prepends an entry with **guessed** download URLs (`Kashshaf_{v}_x64_en-US.msi`, `Kashshaf_{v}_macos.dmg`, `kashshaf_{v}_amd64.AppImage`) | script |
| Commit, tag `vX.Y.Z`, push | `release.py` | script |
| Build Windows MSI, Linux AppImage + deb, macOS universal DMG (signed, notarized) | `.github/workflows/release.yml` on tag push, ~30–45 min | CI |
| Create GitHub release | `release.yml`, as a **draft** | CI |
| Publish the draft, paste notes again | GitHub UI | human |
| Upload `app_manifest.json` to R2 | `rclone` (remote `r2:` is configured locally) | human |
| Verify download links / update notification | RELEASE_REF checklist | human |

### 1.2 Web app (app.kashshaf.com)

Same repo, `npm run build:web` (Tauri imports stubbed), deployed by hand with `wrangler` (Cloudflare Pages; wrangler is installed and has local state). No workflow, no tie to the tag; the version badge comes from `package.json` at build time, so the web app can lag or lead the desktop release.

### 1.3 API (api.kashshaf.com)

`.github/workflows/deploy-api.yml`: on push to `main` touching `api/**`, SSH to the server, `git pull`, `cargo build --release` **on the server**, `systemctl restart kashshaf-api`. No health check, no rollback, no version pin (deploys whatever `main` is at that moment). The systemd unit, reverse proxy, TLS and rate-limit config are not in any repo.

### 1.4 Website (www.kashshaf.com, `kashshaf-web`)

Static Vite site, built and deployed by hand. The Download page already reads the GitHub Releases API, so it needs no edit per release. The About page hard-codes corpus statistics (7,176 books / 5,711,697 pages / 987,907,098 tokens) that must be edited by hand for every corpus release.

### 1.5 Corpus (`kashshaf-data-clean`)

Build per BUILD_CORPUS.md, then: stamp `db_info.corpus_version` with a SQL one-liner, `generate_manifest.py` (hashes ~12 GB), `rclone copy` the files and then the manifest to R2, edit `min_app_version` / `min_supported_version` by hand in two different manifests, keep old files for rollback by hand. A stale copy of `corpus_manifest.json` lives in `kashshaf-app/scripts/manifests/` and is not used by anything.

### 1.6 Announcements

`scripts/generate_announcement.py` edits `scripts/announcements/announcements.json` interactively; upload to `cdn.kashshaf.com/announcements.json` is by hand.

### 1.7 Version numbers to keep aligned

`src-tauri/Cargo.toml`, `api/Cargo.toml`, `engine/Cargo.toml` (new; **not bumped by `release.py`**), `src-tauri/tauri.conf.json`, `package.json`, `app_manifest.latest_version`, `app_manifest.min_supported_version`, `corpus_manifest.min_app_version`, and the tag. `/health` now reports the API version so drift is at least visible.

---

## 2. Problems, ranked

**P0 — will break the next release**
1. `deploy-api.yml` triggers on `api/**` only. The API now compiles the shared `engine/` crate, so an engine change merged alone never redeploys the API, and a later `api/` touch deploys engine changes nobody tested against the server. Add `engine/**` (and `Cargo.lock`) to the path filter.
2. `release.py` does not bump `engine/Cargo.toml`. Harmless for the build (path dependency), misleading for `/health` and for the workspace-version proposal below.

**P1 — manual steps that have already caused mistakes**
3. `app_manifest.json` URLs are guessed from a naming convention rather than read from the published release (0.1.0 shipped `Kashshaf-universal.dmg`; the convention changed to `Kashshaf_{v}_macos.dmg`). Nothing verifies the links before the manifest goes live, and every 0.4.x client reads that manifest at startup.
4. Draft release + manual publish + notes typed twice. Forgetting to publish leaves a tag with no downloads while the manifest points at them.
5. Ship order (API → app → corpus + manifest) exists only in prose.

**P2 — unnecessary toil**
6. Web app deploy is manual and unversioned.
7. Website statistics hard-coded per corpus release.
8. Corpus publish is four hand steps with a 12 GB upload and no post-upload verification.
9. Announcements upload by hand.
10. Server build: compiling the API on the production box means a 10-minute outage window if the build fails half-way, and no binary to roll back to.

---

## 3. Target flow

```
git tag vX.Y.Z  (release.py: bump, changelog-driven notes, tag, push)
        │
        ▼  release.yml
   ┌──────────┬──────────┬──────────┬──────────────┐
   │ windows  │  linux   │  macos   │ api (ubuntu) │   build in parallel
   └────┬─────┴────┬─────┴────┬─────┴──────┬───────┘
        └──────────┴──────────┘            │
                   ▼                       ▼
          publish GitHub release    deploy API binary via scp,
          (notes from changelog)    restart, curl /health == vX.Y.Z
                   │
                   ▼
          app_manifest.json from the *published* assets
          (HEAD-check every URL) → rclone → R2
                   │
                   ▼
          npm run build:web → wrangler pages deploy (app.kashshaf.com)
```

Corpus and announcements stay separate (they are data releases, not code releases) but each becomes one command that ends with a verification step.

Humans do two things: run `release.py`, and approve the publish gate if you want one (GitHub "environment" protection rule on the `publish` job). Everything else is CI.

---

## 4. Changes, in order

### 4.1 Now (before the 0.5.0 release)
- `deploy-api.yml`: `paths: [api/**, engine/**, Cargo.lock]`. Add a post-restart `curl -fsS https://api.kashshaf.com/health | jq -e '.version=="…"'` step so a failed deploy fails the workflow.
- `release.py`: also bump `engine/Cargo.toml`; add `--notes-file` (default: the `## [X.Y.Z]` section of `docs/changelog.md`) so notes are written once, in the repo; add `--dry-run`.
- Delete `scripts/manifests/corpus_manifest.json` from the app repo (stale, unused) or replace it with a note pointing at R2.

### 4.2 Release workflow (`release.yml`)
- Add a `publish` job after the three builds: `softprops/action-gh-release` with `draft: false` and `body_path: RELEASE_NOTES.md` (extracted from the changelog in a previous step). Optional: attach the job to a protected environment so publishing requires one click of approval.
- Add a `manifest` job after `publish`: fetch the current `app_manifest.json` from R2 (`rclone copy` with `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ENDPOINT` secrets), list the release assets via the GitHub API, build the new entry from the **actual** asset URLs, set `latest_version` and (from a `workflow_dispatch` input or a `release.py --min-supported-version` marker file) `min_supported_version`, `HEAD` every URL, upload. This removes the naming-convention guess and the manual upload.
- Add a `web` job: `npm ci && npm run build:web`, then `cloudflare/wrangler-action` with `pages deploy dist --project-name <app project>` (secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`). The web app then always matches the tag.
- Add an `api` job: build `kashshaf-api` on `ubuntu-latest` (same toolchain as the server), `scp` the binary to `/opt/kashshaf/api/bin/kashshaf-api-vX.Y.Z`, symlink `current`, restart, health-check; keep the previous binary for rollback (`systemctl restart` after re-pointing the symlink). Retire the compile-on-server step. Also commit the systemd unit and proxy config under `api/deploy/` so the server is reproducible.

### 4.3 Corpus publish (`kashshaf-data-clean/publish_corpus.py`)
One command that: checks `check_order` passed and `--check` is clean; stamps `db_info.corpus_version` in both databases; runs `generate_manifest.py`; `rclone copy --checksum` the files to R2 (flat layout, as the downloader expects), copies the previous manifest to `archive/<old_version>/corpus_manifest.json`, uploads the new manifest **last**; downloads the manifest back and compares hashes and sizes; prints the `min_app_version` it set so the app manifest can be checked against it. Optionally writes `stats.json` (books, pages, tokens, version, built_at) next to the manifest for the website.

A later app change worth planning: a `base_url` field in `corpus_manifest.json`, so corpora can live under versioned prefixes (`corpus/3.0.0/…`) and a rollback is one manifest upload instead of re-copying 12 GB.

### 4.4 Website (`kashshaf-web`)
- Read statistics from `cdn.kashshaf.com/stats.json` (or from the API `/health` plus `/books`) instead of hard-coding them.
- Add a two-step workflow on push to `main`: build, `wrangler pages deploy`.

### 4.5 Announcements
- Workflow on push to `scripts/announcements/announcements.json`: validate JSON (`schema_version`, dates), `rclone copy` to R2. The generator script stays as the editor.

### 4.6 One version number
- Turn the app repo into a Cargo workspace (`Cargo.toml` at the root with `members = ["engine", "src-tauri", "api"]` and `[workspace.package] version = "0.5.0"`; each crate uses `version.workspace = true`). One line to bump for all three crates.
- Point Tauri at `package.json` for its version (`"version": "../package.json"` is supported by Tauri 2) so `tauri.conf.json` stops carrying its own copy.
- Result: two places (`Cargo.toml` workspace version, `package.json`) instead of five; `release.py` becomes trivial and can be replaced by a small `bump` step plus `git tag`.
- Add `scripts/check_release.py` (also run in CI): all versions equal; tag matches; `/health` reports the tag; every URL in the live `app_manifest.json` answers `200` to `HEAD`; `corpus_manifest.min_app_version ≤ app_manifest.latest_version`.

---

## 5. Secrets needed in GitHub

| Secret | Used by |
|---|---|
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET` | manifest, corpus, announcements uploads |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | web app and website deploys |
| `SERVER_SSH_KEY` (exists) | API deploy |
| Apple signing secrets (exist) | macOS build |

`gh` is not installed locally; none of the above needs it, but it would let `release.py` publish and inspect releases from the command line.

---

## 6. Effort

| Item | Size |
|---|---|
| 4.1 | an hour |
| 4.2 publish + manifest jobs | half a day |
| 4.2 web job | an hour |
| 4.2 API binary deploy + versioned config | half a day |
| 4.3 corpus publish script | half a day |
| 4.4, 4.5 | two hours |
| 4.6 workspace + check script | half a day |

About two working days end to end, of which 4.1 should happen before the 0.5.0 tag.
