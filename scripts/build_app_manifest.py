#!/usr/bin/env python3
"""Build the next app_manifest.json from a base manifest and the *actual*
assets of a GitHub release (no naming-convention guessing).

    python scripts/build_app_manifest.py --base live_app_manifest.json \
        --tag v0.5.0 --assets assets.json --notes-file RELEASE_NOTES.md \
        [--min-supported-version 0.5.0] [--no-head] --out app_manifest.json

`assets.json` is a list of {"name", "browser_download_url"} (the shape of
`gh api repos/O/R/releases/tags/T --jq '.assets | map({name, browser_download_url})'`).
Platform mapping: *.msi → windows, *.dmg → macos, *.AppImage → linux
(*.deb is recorded under "linux_deb"). Every URL gets a HEAD request unless
--no-head. Exit 1 when a platform is missing or a HEAD fails.

Writes nothing but --out; uploading is the workflow's job.
"""
import argparse
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

PLATFORMS = {".msi": "windows", ".dmg": "macos", ".AppImage": "linux", ".deb": "linux_deb"}
REQUIRED = ("windows", "macos", "linux")


def head(url: str) -> tuple[bool, str]:
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "kashshaf-build-app-manifest"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status == 200, f"HTTP {r.status}"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001
        return False, str(e)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", required=True, help="current live manifest (path)")
    ap.add_argument("--tag", required=True)
    ap.add_argument("--assets", required=True, help="assets.json (path)")
    ap.add_argument("--notes-file", required=True)
    ap.add_argument("--min-supported-version", default=None)
    ap.add_argument("--required", action="store_true", help='mark the release "required": true')
    ap.add_argument("--no-head", action="store_true", help="skip HEAD checks (dry run)")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    version = args.tag[1:] if args.tag.startswith("v") else args.tag
    base = json.loads(Path(args.base).read_text(encoding="utf-8"))
    assets = json.loads(Path(args.assets).read_text(encoding="utf-8"))
    notes = Path(args.notes_file).read_text(encoding="utf-8").strip()

    downloads: dict[str, str] = {}
    for a in assets:
        name, url = a["name"], a["browser_download_url"]
        for ext, platform in PLATFORMS.items():
            if name.endswith(ext) and platform not in downloads:
                downloads[platform] = url
    missing = [p for p in REQUIRED if p not in downloads]
    if missing:
        print(f"missing assets for: {', '.join(missing)}; have {sorted(downloads)}")
        return 1

    failed = False
    for platform, url in downloads.items():
        if args.no_head:
            print(f"{platform:9} {url} (HEAD skipped)")
            continue
        good, why = head(url)
        print(f"{platform:9} {why} {url}")
        failed |= not good
    if failed:
        return 1

    entry = {
        "version": version,
        "released_at": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "required": bool(args.required),
        "notes": notes,
        "downloads": downloads,
    }
    releases = [r for r in base.get("releases", []) if r.get("version") != version]
    releases.insert(0, entry)
    manifest = dict(base)
    manifest["latest_version"] = version
    if args.min_supported_version:
        manifest["min_supported_version"] = args.min_supported_version
    manifest.setdefault("min_supported_version", version)
    manifest["releases"] = releases
    Path(args.out).write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {args.out}: latest_version={version} min_supported_version={manifest['min_supported_version']} releases={len(releases)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
