# API server deployment

Everything the production API box needs, so the server is reproducible and
a deploy is a symlink switch. Nothing here is applied automatically except
by `.github/workflows/release.yml` (with `dry_run: false`).

| File | Purpose |
|---|---|
| `kashshaf-api.service` | systemd unit: user `kashshaf`, `ExecStart=/opt/kashshaf/api/bin/current`, environment (below); `ProtectSystem=full` and no `ReadOnlyPaths=` because the data directory is a symlink (see "Corpus layout") |
| `nginx-api.kashshaf.com.conf` | reverse proxy with TLS, 10 req/s burst 30 per IP (`limit_req` inside `location /`; `/health` has none, which is how nginx exempts a location), JSON 429. The `ssl_certificate` lines are live and point at certbot's paths, so the file passes `nginx -t` wherever the certificate exists; the TLS `server` block sits between `begin/end tls server` markers so `install.sh` can leave it out until certbot has run |
| `install.sh` | one-time setup: packages, user, directories, sudoers rule, unit, optional nginx + certbot. Without a certificate it installs the port-80 site only, runs `certbot certonly --nginx`, then installs the full site; with one it installs the full site directly |
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

## `/health` is never rate-limited, at either layer

`switch_release.sh` polls `/health` every 2 s for up to 120 s waiting for the
new version and then every 5 s for up to 600 s waiting for `warm_cache`, and an
uptime monitor or an open browser tab polls it too from other addresses. A 429
on `/health` would read as "not ready" and could end a good deploy with a
false rollback. So it is exempt twice:

- **nginx**: `location = /health` carries no `limit_req` (the limiter lives in
  `location /`; nginx has no `limit_req off`).
- **app**: in `api/src/main.rs` the `tower_governor` layer is applied to a
  router holding every other route, and `/health` is registered on a separate
  router merged in afterwards, outside the layer.

Verified with 60 sequential and 60 concurrent requests from one address:
`/health` answers 200 every time while `/genres` returns 429s after the burst
of 30. The two limiters' 429 bodies differ (`retry in 0 s` from the app,
`retry in 1 s` from nginx), which is how `smoke.sh` reports which one answered.

## Rollback by hand

```
sudo ln -sfn /opt/kashshaf/api/bin/kashshaf-api-v0.4.1 /opt/kashshaf/api/bin/current
sudo systemctl restart kashshaf-api
curl -s http://127.0.0.1:3000/health | jq .version
```

## First-time setup

```
sudo bash api/deploy/install.sh --with-nginx --with-certbot
sudo -u kashshaf rclone copy r2:<bucket>/corpus/4.0.0/ /opt/kashshaf/data-4.0.0/   # or scp
sudo ln -sfn data-4.0.0 /opt/kashshaf/data
```

Then run the release workflow (or `only_api: true` for a tag that already exists).

## Corpus layout: `/opt/kashshaf/data` is a symlink

`KASHSHAF_DATA_DIR=/opt/kashshaf/data` never points at a real directory. Each
corpus version lives in its own directory beside it and `data` is a relative
symlink to the live one:

```
/opt/kashshaf/
├── api/…
├── data -> data-4.0.0/
├── data-4.0.0/   corpus.db  metadata.db  triples.bin  tantivy_index/
└── data-3.0.0/   (previous, kept for rollback)
```

Swapping corpora is therefore the same shape as a binary deploy: unpack the
new version beside the old one, repoint the link, restart, and the old
version stays for rollback.

```
sudo -u kashshaf rclone copy --checksum r2:<bucket>/corpus/4.1.0/ /opt/kashshaf/data-4.1.0/
sudo ln -sfn data-4.1.0 /opt/kashshaf/data      # atomic: replaces the link, not the directory
sudo systemctl restart kashshaf-api
curl -s http://127.0.0.1:3000/health | jq '{version, corpus_version, warm_cache}'
# rollback: sudo ln -sfn data-4.0.0 /opt/kashshaf/data && sudo systemctl restart kashshaf-api
```

**Why the unit has no `ReadOnlyPaths=/opt/kashshaf/data`.** systemd's
`ReadOnlyPaths=` bind-mounts the given path into the service's mount
namespace without resolving a symlink there, so with the layout above the
process sees `/opt/kashshaf/data` as an empty or dangling mount and SQLite
fails at startup with `unable to open database file` (error 14). Confirmed
by elimination on the production box: `ProtectSystem=strict` and `full`
both work without `ReadOnlyPaths=`, and adding it in any form fails. The
unit uses `ProtectSystem=full` (`/usr`, `/boot`, `/efi`, `/etc` read-only)
and `ReadWritePaths=/opt/kashshaf/api`; the API only ever opens the data
files read-only anyway. Do not reintroduce `ReadOnlyPaths=` for the data
path, and do not replace the symlink with a real directory to "fix" it.
