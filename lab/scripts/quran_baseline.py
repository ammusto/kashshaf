#!/usr/bin/env python3
"""Run Quran_Detector (El-Beltagy, Python, offline) over 20 sample pages and
write the baseline fixture `lab/fixtures/quran_baseline.json` that
`tests/quran_baseline.rs` compares Lab's §4.4 detector against.

Dev-only: the fixture is committed; the Rust test never runs Python.

Usage:
    python lab/scripts/quran_baseline.py --detector <clone of SElBeltagy/Quran_Detector>
        [--deps <dir with the Levenshtein package>] [--sample <sample-mini dir>]

The detector reads its data files relative to the working directory, so the
script chdirs into the clone. Its results are verse identities (sūra name,
āya range) with its own word offsets; the fixture keeps the identities and
the matched text, which is what the comparison is on.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TAG_RE = re.compile(r"<[^>]+>")

# (book_id, page count wanted): cued books and uncued ones (§4.4 baseline).
BOOKS = [
    (5563, 4),  # Minḥat al-Bārī: ﴿ ﴾ everywhere
    (4382, 3),  # Iʿlām al-muwaqqiʿīn: ﴿ ﴾ and قال تعالى
    (6659, 2),  # Ṣiyānat al-insān
    (4697, 2),  # al-Takhwīf min al-nār
    (6038, 3),  # Riyāḍ al-sālikīn: قال تعالى, no brackets
    (2553, 2),  # Mukhtaṣar al-tabyīn: no brackets
    (2615, 2),  # Rasāʾil al-Ghazālī
    (527, 2),   # al-Zuhd: ḥadīth, few quotations
]


def strip_html(body: str) -> str:
    return TAG_RE.sub("", body.replace("<br>", "\n").replace("<br/>", "\n"))


def pick_pages(sample: Path):
    picked = []
    for book_id, want in BOOKS:
        path = sample / "processed" / f"{book_id}.jsonl"
        if not path.exists():
            print(f"skip {book_id}: no JSONL", file=sys.stderr)
            continue
        cued, uncued = [], []
        with path.open(encoding="utf-8") as f:
            for line in f:
                d = json.loads(line)
                body = d["body"]
                if len(d["tokens"]) < 80:
                    continue
                has_cue = "﴿" in body or "قال تعالى" in body or "قوله تعالى" in body
                (cued if has_cue else uncued).append(d)
        # Spread through the book: every k-th cued page, then uncued to fill.
        chosen = []
        if cued:
            step = max(1, len(cued) // want)
            chosen = cued[::step][:want]
        if len(chosen) < want and uncued:
            step = max(1, len(uncued) // (want - len(chosen)))
            chosen += uncued[::step][: want - len(chosen)]
        for d in chosen:
            picked.append({
                "book_id": book_id,
                "part_index": d["part_index"],
                "page_id": d["page_id"],
                "tokens": len(d["tokens"]),
                "text": strip_html(d["body"]),
            })
    return picked[:20]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--detector", type=Path, required=True)
    ap.add_argument("--deps", type=Path, default=None)
    ap.add_argument("--sample", type=Path, default=Path(os.environ.get("KASHSHAF_SAMPLE_DIR", "D:/DH Projects/kashshaf-data-clean/data/sample-mini")))
    ap.add_argument("--out", type=Path, default=HERE.parent / "fixtures" / "quran_baseline.json")
    args = ap.parse_args()

    if args.deps:
        sys.path.insert(0, str(args.deps))
    sys.path.insert(0, str(args.detector))
    os.chdir(args.detector)
    import QuranDetectorAnnotater as qd  # noqa: E402

    pages = pick_pages(args.sample)
    ann = qd.qMatcherAnnotater()
    out_pages = []
    total = 0
    for p in pages:
        recs = ann.matchAll(p["text"])
        matches = []
        for r in recs:
            matches.append({
                "sura_name": r["aya_name"],
                "aya_start": r["aya_start"],
                "aya_end": r["aya_end"],
                "verses": r["verses"],
                "errors": r["errors"],
            })
        total += len(matches)
        out_pages.append({
            "book_id": p["book_id"],
            "part_index": p["part_index"],
            "page_id": p["page_id"],
            "tokens": p["tokens"],
            "matches": matches,
        })
        print(f"{p['book_id']}:{p['part_index']}:{p['page_id']}  {len(matches)} matches")

    fixture = {
        "_comment": "Quran_Detector (SElBeltagy/Quran_Detector, matchAll defaults: findErr, findMissing, allowedErrPers 0.25, minMatch 3) on 20 sample pages. Dev-only baseline for tests/quran_baseline.rs; regenerate with lab/scripts/quran_baseline.py.",
        "detector": "Quran_Detector",
        "pages": out_pages,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(fixture, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {args.out}: {len(out_pages)} pages, {total} baseline matches")


if __name__ == "__main__":
    main()
