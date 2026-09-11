#!/usr/bin/env python
"""Compare two bench reports (engine/src/bin/bench.rs output).

    python engine/bench/compare.py baseline.json new.json [--p95-tolerance 0.10]
                                   [--allow-highlight-superset]

Fails (exit 1) when any case differs in result set, total_hits, or variants,
when highlight positions in `new` are not a superset of `baseline` (unless
positions are expected to shrink, which never happens in this plan), or when
p95 latency regresses by more than the tolerance (default 10%; cases faster
than 2 ms are compared with a 1 ms floor to avoid noise).
"""
import argparse
import json
import sys


def load(path):
    with open(path, encoding="utf-8") as f:
        rep = json.load(f)
    return rep, {c["name"]: c for c in rep["cases"]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("baseline")
    ap.add_argument("new")
    ap.add_argument("--p95-tolerance", type=float, default=0.10)
    ap.add_argument("--latency-floor-ms", type=float, default=1.0)
    ap.add_argument("--ignore-latency", action="store_true")
    ap.add_argument("--ignore-highlights", action="store_true")
    args = ap.parse_args()

    brep, base = load(args.baseline)
    nrep, new = load(args.new)
    print(f"baseline: {brep['index']}  docs={brep['docs']} segments={brep['segments']} reading_order={brep['reading_order']}")
    print(f"new:      {nrep['index']}  docs={nrep['docs']} segments={nrep['segments']} reading_order={nrep['reading_order']}")
    print()

    failures = []
    for name, b in base.items():
        n = new.get(name)
        if n is None:
            failures.append(f"{name}: missing in new report")
            continue
        if b.get("error") or n.get("error"):
            if b.get("error") != n.get("error"):
                failures.append(f"{name}: error mismatch: {b.get('error')!r} vs {n.get('error')!r}")
            continue
        if b["total_hits"] != n["total_hits"]:
            failures.append(f"{name}: total_hits {b['total_hits']} -> {n['total_hits']}")
        if [tuple(x) for x in b["results"]] != [tuple(x) for x in n["results"]]:
            failures.append(f"{name}: result set/order differs "
                            f"({len(b['results'])} vs {len(n['results'])} rows)")
        if b["variants"] != n["variants"]:
            failures.append(f"{name}: variants differ")
        if not args.ignore_highlights:
            for i, (hb, hn) in enumerate(zip(b["highlights"], n["highlights"])):
                if not set(hb).issubset(set(hn)):
                    failures.append(f"{name}: highlights row {i} not a superset ({hb} -> {hn})")
                    break
        if not args.ignore_latency:
            allowed = max(b["p95_ms"] * (1 + args.p95_tolerance), b["p95_ms"] + args.latency_floor_ms)
            if n["p95_ms"] > allowed:
                failures.append(f"{name}: p95 {b['p95_ms']:.2f} ms -> {n['p95_ms']:.2f} ms (allowed {allowed:.2f})")
        delta = n["p95_ms"] - b["p95_ms"]
        print(f"{name:40} p95 {b['p95_ms']:8.2f} -> {n['p95_ms']:8.2f} ms ({delta:+.2f})  hits {b['total_hits']:>8} -> {n['total_hits']:>8}")

    for name in new:
        if name not in base:
            print(f"{name:40} (new case, no baseline)")

    print()
    if failures:
        print("FAIL")
        for f in failures:
            print("  " + f)
        return 1
    print("OK: result sets identical, highlights superset, latency within tolerance")
    return 0


if __name__ == "__main__":
    sys.exit(main())
