# API server deployment

Everything the production API box needs, so the server is reproducible and
a deploy is a symlink switch. Nothing here is applied automatically except
by `.github/workflows/release.yml` (with `dry_run: false`).

| File | Purpose |
|---|---|
| `kashshaf-api.service` | systemd unit: user `kashshaf`, `ExecStart=/opt/kashshaf/api/bin/current`, environment (below) |
| `nginx-api.kashshaf.com.conf` | reverse proxy with TLS (certbot), 10 req/s burst 30 per IP, JSON 429, `/health` never limited |
| `install.sh` | one-time setup: packages, user, directories, sudoers rule, unit, optional nginx + certbot |
| `switch_release.sh` | run by the workflow over SSH: repoint `bin/current`, restart, wait for `/health.version` and `warm_cache == complete`, smoke test, roll back on failure, keep three binaries |
| `smoke.sh` | the post-deploy checks (also run from the runner against the public URL) |

## Layout on the server

```
/opt/kashshaf/
  api/
    bin/kashshaf-api-v0.4.1      previous binaries (three are kept)
    bin/kashshaf-api-v0.5.0
    bin/current -> bin/kashshaf-api-v0.5.0
    incoming/                    scp target of the workflow
    switch_release.sh, smoke.sh
  data/                          corpus.db, metadata.db, tantivy_index/  (rclone from R2)
```

## Environment (unit file)

| Variable | Value | Meaning |
|---|---|---|
| `KASHSHAF_DATA_DIR` | `/opt/kashshaf/data` | index and databases |
| `KASHSHAF_BIND` | `127.0.0.1:3000` | listen behind nginx only |
| `KASHSHAF_WARM_CACHE` | `1` | read the index and corpus.db once at startup; `/health.warm_cache` goes `pending` → `complete` (the deploy waits for it); unset = `disabled` |
| `KASHSHAF_RATE_LIMIT` | `1` | in-process limiter, 10 req/s burst 30 per client IP (`<per_second>[,<burst>]` to change; unset/`0` off) |
| `KASHSHAF_MAX_CONCURRENT_WALKS` | `4` | detached verified walks running at once (default would be `nproc - 2`); `KASHSHAF_MAX_WALKS` is an alias |
| `RUST_LOG` | `info` | tracing filter |

## Binary

`release.yml` builds `kashshaf-api` as a **static musl** binary
(`x86_64-unknown-linux-musl`), so the server's glibc version does not
matter. `rusqlite` (bundled SQLite) and Tantivy's zstd both build with
`musl-tools`; the workflow fails the `build-api` job if `ldd` reports a
dynamic executable. If a musl build ever stops linking, change `build-api`
to run in `container: ubuntu:<the server's release from /etc/os-release>`
and build with glibc instead; never on a newer runner image than the server.

## A deploy, step by step

1. `release.yml` (`dry_run: false`) scp's `kashshaf-api-vX.Y.Z`, `switch_release.sh` and `smoke.sh` to `incoming/`.
2. Over SSH: move the binary to `bin/`, `sudo ./switch_release.sh vX.Y.Z`.
3. `switch_release.sh`: repoint `bin/current`, `systemctl restart kashshaf-api`, wait for `/health.version == X.Y.Z` (120 s), wait for `warm_cache == complete` (600 s), run `smoke.sh` against `127.0.0.1:3000`; on any failure repoint to the previous binary, restart, exit 1 (the workflow fails and nothing is published).
4. The runner runs `scripts/check_release.py --post-deploy` and `smoke.sh` against `https://api.kashshaf.com`.
5. Only then does the `publish` job create the GitHub release; the `manifest` job updates `app_manifest.json` after that.

Redeploying an existing tag (hotfix, server rebuilt): run the workflow with `only_api: true`.

## Rollback by hand

```
sudo ln -sfn /opt/kashshaf/api/bin/kashshaf-api-v0.4.1 /opt/kashshaf/api/bin/current
sudo systemctl restart kashshaf-api
curl -s http://127.0.0.1:3000/health | jq .version
```

## First-time setup

```
sudo bash api/deploy/install.sh --with-nginx --with-certbot
rclone copy r2:<bucket>/corpus/4.0.0/ /opt/kashshaf/data/   # or scp
```

Then run the release workflow (or `only_api: true` for a tag that already exists).
