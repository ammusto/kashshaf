#!/usr/bin/env python3
"""Concurrency bench against a running kashshaf-api.

Fires N concurrent proximity requests (default: 16 x `الله ~10 lemma:قال`)
and, while they run, polls /health and /page every 100 ms from a side
thread. Reports first-window latency p50/p95, the peak of walks_queued and
walks_active seen on /health, peak RSS reported by /health, and the maximum
latency of /health and /page during the run.

    python engine/bench/api_concurrency.py --base http://127.0.0.1:3000 --n 16 [--distinct]

`--distinct` gives every request its own distance (1..N) so the requests
map to N different walks; without it they share one cache entry (the walk
runs once and the other requests wait on it).
"""
import argparse, json, statistics, sys, threading, time, urllib.request, urllib.error

def get(url, timeout=30):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))

def post(url, body, timeout=120):
    req = urllib.request.Request(url, data=json.dumps(body).encode('utf-8'),
                                 headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default='http://127.0.0.1:3000')
    ap.add_argument('--n', type=int, default=16)
    ap.add_argument('--distinct', action='store_true', help='distances 1..N instead of one shared query')
    ap.add_argument('--term1', default='الله')
    ap.add_argument('--term2', default='قال')
    ap.add_argument('--mode2', default='lemma')
    ap.add_argument('--out', default=None)
    args = ap.parse_args()

    health0 = get(f'{args.base}/health')
    # A page for the side poller (first result of a cheap search).
    probe = get(f'{args.base}/search?q=%D9%83%D8%AA%D8%A7%D8%A8&mode=lemma&limit=1')
    row = probe['results'][0]
    page_url = f"{args.base}/page?id={row['id']}&part_index={row['part_index']}&page_id={row['page_id']}"

    stop = threading.Event()
    side = {'health_ms': [], 'page_ms': [], 'queued_peak': 0, 'active_peak': 0, 'rss_peak': 0.0, 'samples': 0, 'errors': 0}

    def poller():
        while not stop.is_set():
            t = time.perf_counter()
            try:
                h = get(f'{args.base}/health', timeout=10)
                side['health_ms'].append((time.perf_counter() - t) * 1e3)
                side['queued_peak'] = max(side['queued_peak'], h.get('walks_queued', 0))
                side['active_peak'] = max(side['active_peak'], h.get('walks_active', 0))
                side['rss_peak'] = max(side['rss_peak'], h.get('peak_rss_mb', 0.0))
                t = time.perf_counter()
                get(page_url, timeout=10)
                side['page_ms'].append((time.perf_counter() - t) * 1e3)
                side['samples'] += 1
            except Exception:
                side['errors'] += 1
            time.sleep(0.1)

    lat = [None] * args.n
    resp = [None] * args.n
    errs = [None] * args.n

    def worker(i):
        d = (i % 100) + 1 if args.distinct else 10
        body = {'term1': {'query': args.term1, 'mode': 'surface'},
                'term2': {'query': args.term2, 'mode': args.mode2},
                'distance': d, 'limit': 250, 'offset': 0}
        t = time.perf_counter()
        try:
            resp[i] = post(f'{args.base}/search/proximity', body)
        except urllib.error.HTTPError as e:
            errs[i] = f'HTTP {e.code}: {e.read().decode("utf-8", "replace")[:200]}'
        except Exception as e:
            errs[i] = str(e)
        lat[i] = (time.perf_counter() - t) * 1e3

    th = threading.Thread(target=poller, daemon=True)
    th.start()
    time.sleep(0.3)
    workers = [threading.Thread(target=worker, args=(i,)) for i in range(args.n)]
    t_all = time.perf_counter()
    for w in workers:
        w.start()
    for w in workers:
        w.join()
    wall_ms = (time.perf_counter() - t_all) * 1e3
    # Keep polling until the detached walks have finished.
    for _ in range(100):
        h = get(f'{args.base}/health')
        if h.get('walks_active', 0) == 0 and h.get('walks_queued', 0) == 0:
            break
        time.sleep(0.1)
    stop.set()
    th.join(timeout=5)
    health1 = get(f'{args.base}/health')

    ok = [l for l, e in zip(lat, errs) if e is None]
    ok.sort()
    def pct(v, p):
        return v[min(len(v) - 1, int(round((len(v) - 1) * p)))] if v else float('nan')
    report = {
        'n': args.n, 'distinct': args.distinct, 'wall_ms': wall_ms,
        'errors': [e for e in errs if e],
        'first_window_ms': {'p50': pct(ok, 0.5), 'p95': pct(ok, 0.95), 'min': ok[0] if ok else None, 'max': ok[-1] if ok else None},
        'totals': sorted({(r['total_hits'], bool(r.get('was_capped')), r.get('complete')) for r in resp if r}, key=str),
        'walks_queued_peak': side['queued_peak'], 'walks_active_peak': side['active_peak'],
        'max_concurrent_walks': health1.get('max_concurrent_walks'),
        'health_ms_max': max(side['health_ms']) if side['health_ms'] else None,
        'health_ms_p50': statistics.median(side['health_ms']) if side['health_ms'] else None,
        'page_ms_max': max(side['page_ms']) if side['page_ms'] else None,
        'page_ms_p50': statistics.median(side['page_ms']) if side['page_ms'] else None,
        'side_samples': side['samples'], 'side_errors': side['errors'],
        'rss_mb_before': health0.get('rss_mb'), 'peak_rss_mb_after': health1.get('peak_rss_mb'),
        'private_mb_after': health1.get('private_mb'),
        'prefix_cache_entries': health1.get('prefix_cache_entries'), 'prefix_cache_bytes': health1.get('prefix_cache_bytes'),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
    return 0 if not report['errors'] else 1

if __name__ == '__main__':
    sys.exit(main())
