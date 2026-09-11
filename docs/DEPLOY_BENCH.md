# Deployment bench

`bench --remote <url>` replays the query sets over HTTP against a running
`kashshaf-api` and reports, per case, the client wall-clock p50/p95 and the
server's own `elapsed_ms`, so network and JSON serialization show up as the
difference between the two. It is the same binary as the local bench, built
with the `remote` feature:

```
cargo build --release -p kashshaf-engine --features remote --bin bench
./target/release/bench --remote http://127.0.0.1:3000 \
    --queries engine/bench/queries.json --queries engine/bench/proximity.json \
    --runs 5 --concurrency 16 --check-compat --out engine/bench/reports/remote-<where>-<state>.json
```

| Flag | Meaning |
|---|---|
| `--remote <url>` | base URL of the API; no `--index` / `--corpus-db` needed |
| `--queries <file>` (repeatable) | default: `queries.json` and `proximity.json` |
| `--runs N` | requests per case (the first is reported separately as `first_ms`) |
| `--rps N` | pacing of the sequential cases (default 8/s) so the server's limiter, 10 req/s burst 30, never fires mid-measurement |
| `--concurrency N` | the three scenarios of CAPPED_WALKS_REPORT.md §6: N identical `الله ~10 lemma:قال`, N distinct distances, N distinct phrase walks (`قال ~d "رسول الله"`); a side thread polls `/health` and `/page` every 100 ms and reports their maxima, the peak of `walks_queued` / `walks_active`, and peak RSS |
| `--check-compat` | the post-deploy assertions of `api/deploy/smoke.sh`: `/search?q=قال` (hits > 0, < 500 ms), a proximity walk and its `/search/status`, `ابن ال*`, `/page/tokens` without `part_index` (0.4.x shim) → 200, a burst of 60 that must yield a JSON 429; exit 1 on any failure |

Every capped case (a walk: `was_capped` or `complete` in the response) gets a
second measurement, "page 20" (`offset` 4750), served from the server's
prefix cache. `results` / `highlights` are recorded like the local bench, so
`engine/bench/compare.py` can diff a remote report against a local one.

## States

The prefix cache and the OS page cache both persist across requests, so the
server state matters more than the client's location:

| State | Procedure (on the box, as root) |
|---|---|
| **cold** | `systemctl stop kashshaf-api; sync; echo 3 > /proc/sys/vm/drop_caches; KASHSHAF_WARM_CACHE=0 systemctl start kashshaf-api` (set the override with `systemctl set-environment` or a drop-in), then bench immediately |
| **warm** | `systemctl restart kashshaf-api` (unit has `KASHSHAF_WARM_CACHE=1`), wait until `/health.warm_cache == "complete"` (about 10 s for 8.3 GiB), then bench |

A restart also empties the prefix cache, so every walk case is measured
once as a fresh walk (`first_ms`) and then as cache hits. Do not run two
benches against the same server without restarting in between: the second
one measures cache hits only.

## Where to run

| Column | Client | Notes |
|---|---|---|
| on-box | on the server against `http://127.0.0.1:3000` | no network, no TLS, no nginx limiter; `--check-compat` still sees the in-process 429 |
| off-box | a laptop against `https://api.kashshaf.com` | adds TLS + RTT + the proxy; the sequential cases are paced under the limiter, the 60-request burst is expected to hit it |

Report the four combinations in one table (rows = cases, columns = on/off box
× cold/warm). The off-box/warm column is what users see and goes into
KASHSHAF_SPECIFICATION.md §21 as the measured numbers; keep the cold column
in the same table so startup behaviour is visible.

## Local rehearsal (what has been run so far)

The remote mode was exercised against a local server on
`127.0.0.1:3000` (Windows, full compound corpus, `KASHSHAF_RATE_LIMIT=1`,
`KASHSHAF_WARM_CACHE=1`, `KASHSHAF_MAX_CONCURRENT_WALKS=4`); report
`engine/bench/reports/remote-localhost-warm.json`. On-box/warm figures,
client wall-clock p50 (server `elapsed_ms` in brackets):

| Case | p50 |
|---|---|
| `surface_term_common` (3.7M hits) | 14 ms (12) |
| `lemma_term_common_qala` (4.7M) | 27 ms (25) |
| `wildcard_prefix أب*` (4.2M) | 42 ms (40) |
| `combined_and_or` | 35 ms (31) |
| `name_search_small` | 87 ms (85) |
| `variants_lemma_common` | 1.14 s (1.13 s) |
| `page_load_sequence` (10 pages) | 8.5 ms per page |
| proximity / phrase walks, page 1 and page 20 (cache hits after the first walk) | 0.3–3 ms |
| compat checks | all pass; 29 × 429 in a burst of 60 |

Network + serialization on the loopback is 1–4 ms for a 250-row page. The
production numbers (cold/warm × on/off box) are still to be measured after
the first real deploy; nothing has been run against `api.kashshaf.com`.
