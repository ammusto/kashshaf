#!/usr/bin/env python3
"""Release consistency checks. Exit code 0 = all good, 1 = a check failed.

Local (CI on every push, and before tagging):

    python scripts/check_release.py --local [--tag v0.5.0]

  * Cargo.toml [workspace.package].version == package.json version
    (== src-tauri/tauri.conf.json "version" when it is a literal; when it is
    a path such as "../package.json" the two are the same by construction)
  * every workspace crate uses version.workspace = true
  * the tag, when given, equals v<version>
  * docs/changelog.md has a "## [<version>]" section (Kashshaf's sections
    only; the release workflow takes the notes from the same file)

    python scripts/check_release.py --local --app lab [--tag lab-v0.10.0]

  * lab/src-tauri/Cargo.toml version == lab/package.json version
  * the tag, when given, equals lab-v<version>
  * docs/lab-changelog.md has a "## [lab <version>]" section

Post-deploy (the workflow after deploy-api, or by hand):

    python scripts/check_release.py --post-deploy --tag v0.5.0 \
        [--api https://api.kashshaf.com] \
        [--app-manifest https://cdn.kashshaf.com/app_manifest.json] \
        [--corpus-manifest https://cdn.kashshaf.com/corpus_manifest.json]

  * GET <api>/health: .version == tag version, status ok
  * every download URL of the releases a client can be offered (at or above
    min_supported_version, plus latest_version) answers 200 to HEAD; older
    entries are history and are reported in one "skipped" line
  * corpus_manifest.min_app_version <= app_manifest.latest_version
  * app_manifest.latest_version == tag version (unless --no-manifest-version)

--app-manifest / --corpus-manifest also accept local file paths, and
--api accepts a local server, so the post-deploy checks can be rehearsed
against ./publish-test/ and localhost:3000 without touching production.
Only GET/HEAD requests are made; nothing is modified anywhere.
"""
import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FAILURES: list[str] = []


def ok(msg: str) -> None:
    print("OK   " + msg)


def fail(msg: str) -> None:
    FAILURES.append(msg)
    print("FAIL " + msg)


def parse_version(v: str) -> tuple[int, int, int]:
    m = re.match(r"^v?(\d+)\.(\d+)\.(\d+)", v.strip())
    if not m:
        raise ValueError(f"not a version: {v!r}")
    return int(m.group(1)), int(m.group(2)), int(m.group(3))


def workspace_version() -> str | None:
    toml = ROOT / "Cargo.toml"
    if not toml.exists():
        return None
    text = toml.read_text(encoding="utf-8")
    if "[workspace.package]" not in text:
        return None
    tail = text[text.index("[workspace.package]"):]
    m = re.search(r'^version = "([^"]+)"', tail, flags=re.MULTILINE)
    return m.group(1) if m else None


def load_json(source: str) -> dict:
    """A URL or a local path."""
    if re.match(r"^https?://", source):
        req = urllib.request.Request(source, headers={"User-Agent": "kashshaf-check-release"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))
    return json.loads(Path(source).read_text(encoding="utf-8"))


def head_ok(url: str) -> tuple[bool, str]:
    if not re.match(r"^https?://", url):
        p = Path(url)
        return p.exists(), "local file" if p.exists() else "missing local file"
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "kashshaf-check-release"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status == 200, f"HTTP {r.status}"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001
        return False, str(e)


# ---------------------------------------------------------------- local

def check_local(tag: str | None) -> None:
    ws = workspace_version()
    if ws is None:
        fail("Cargo.toml has no [workspace.package] version")
        return
    ok(f"workspace version {ws}")

    pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8")).get("version")
    if pkg == ws:
        ok(f"package.json version {pkg}")
    else:
        fail(f"package.json version {pkg} != workspace {ws}")

    conf = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
    tv = conf.get("version")
    if isinstance(tv, str) and tv.endswith("package.json"):
        ok(f"tauri.conf.json version = {tv} (follows package.json)")
    elif tv == ws:
        ok(f"tauri.conf.json version {tv}")
    else:
        fail(f"tauri.conf.json version {tv} != workspace {ws}")

    for crate in ("engine", "src-tauri", "api"):
        text = (ROOT / crate / "Cargo.toml").read_text(encoding="utf-8")
        if re.search(r"^version\.workspace = true", text, flags=re.MULTILINE):
            ok(f"{crate}/Cargo.toml uses version.workspace")
        else:
            m = re.search(r'^version = "([^"]+)"', text, flags=re.MULTILINE)
            fail(f"{crate}/Cargo.toml has its own version {m.group(1) if m else '?'}; use version.workspace = true")

    if tag is not None:
        if tag == f"v{ws}":
            ok(f"tag {tag} matches")
        else:
            fail(f"tag {tag} != v{ws}")

    check_changelog("docs/changelog.md", ws)


def check_changelog(rel: str, heading: str) -> None:
    """The app's changelog has the section its notes come from."""
    changelog = ROOT / rel
    if changelog.exists() and re.search(rf"^## \[{re.escape(heading)}\]", changelog.read_text(encoding="utf-8"), flags=re.MULTILINE):
        ok(f"{rel} has a [{heading}] section")
    else:
        fail(f"{rel} has no ## [{heading}] section (release notes come from it)")


def check_local_lab(tag: str | None) -> None:
    """Lab's version lives in lab/, apart from the workspace, and its notes in docs/lab-changelog.md."""
    toml = (ROOT / "lab/src-tauri/Cargo.toml").read_text(encoding="utf-8")
    m = re.search(r'^version = "([^"]+)"', toml, flags=re.MULTILINE)
    if not m:
        fail("lab/src-tauri/Cargo.toml has no version line")
        return
    lv = m.group(1)
    ok(f"lab version {lv}")

    pkg = json.loads((ROOT / "lab/package.json").read_text(encoding="utf-8")).get("version")
    if pkg == lv:
        ok(f"lab/package.json version {pkg}")
    else:
        fail(f"lab/package.json version {pkg} != lab/src-tauri/Cargo.toml {lv}")

    if tag is not None:
        if tag == f"lab-v{lv}":
            ok(f"tag {tag} matches")
        else:
            fail(f"tag {tag} != lab-v{lv}")

    check_changelog("docs/lab-changelog.md", f"lab {lv}")


# ---------------------------------------------------------------- post-deploy

def check_post_deploy(tag: str, api: str | None, app_manifest: str | None, corpus_manifest: str | None, check_manifest_version: bool) -> None:
    version = tag[1:] if tag.startswith("v") else tag

    if api:
        try:
            health = load_json(api.rstrip("/") + "/health")
        except Exception as e:  # noqa: BLE001
            fail(f"{api}/health unreachable: {e}")
            health = None
        if health is not None:
            if health.get("status") == "ok":
                ok(f"{api}/health status ok")
            else:
                fail(f"{api}/health status {health.get('status')!r}")
            if health.get("version") == version:
                ok(f"API version {health.get('version')} == {version}")
            else:
                fail(f"API version {health.get('version')} != {version}")
            wc = health.get("warm_cache")
            if wc in (None, "complete", "disabled"):
                ok(f"warm_cache = {wc}")
            else:
                fail(f"warm_cache = {wc} (not complete)")

    app = None
    if app_manifest:
        try:
            app = load_json(app_manifest)
        except Exception as e:  # noqa: BLE001
            fail(f"app manifest {app_manifest}: {e}")
        if app is not None:
            latest = app.get("latest_version")
            if not check_manifest_version:
                ok(f"app manifest latest_version {latest} (not compared)")
            elif latest == version:
                ok(f"app manifest latest_version {latest} == {version}")
            else:
                fail(f"app manifest latest_version {latest} != {version}")
            try:
                if parse_version(app.get("min_supported_version", "0.0.0")) <= parse_version(latest or "0.0.0"):
                    ok(f"min_supported_version {app.get('min_supported_version')} <= latest {latest}")
                else:
                    fail(f"min_supported_version {app.get('min_supported_version')} > latest {latest}")
            except ValueError as e:
                fail(str(e))
            # Only releases a client can be sent to are verified: every entry
            # at or above min_supported_version, plus latest_version. Older
            # entries stay in the manifest as history (their GitHub assets
            # may be gone — v0.3.0's are) and are reported in one line.
            try:
                floor = parse_version(app.get("min_supported_version") or "0.0.0")
            except ValueError:
                floor = (0, 0, 0)
            skipped: list[str] = []
            for rel in app.get("releases", []):
                rv = str(rel.get("version") or "")
                try:
                    live = rv == latest or parse_version(rv) >= floor
                except ValueError:
                    live = True  # unparseable version: check it rather than hide it
                if not live:
                    skipped.append(rv)
                    continue
                for platform, url in (rel.get("downloads") or {}).items():
                    good, why = head_ok(url)
                    (ok if good else fail)(f"{rv} {platform}: {why} {url}")
            if skipped:
                print(f"     skipped {len(skipped)} release{'s' if len(skipped) != 1 else ''} below min_supported_version "
                      f"{app.get('min_supported_version')} (history only, not offered to any client): {', '.join(skipped)}")

    if corpus_manifest:
        try:
            corpus = load_json(corpus_manifest)
        except Exception as e:  # noqa: BLE001
            fail(f"corpus manifest {corpus_manifest}: {e}")
            corpus = None
        if corpus is not None:
            min_app = corpus.get("min_app_version", "0.0.0")
            latest = (app or {}).get("latest_version") or version
            try:
                if parse_version(min_app) <= parse_version(latest):
                    ok(f"corpus {corpus.get('corpus_version')} min_app_version {min_app} <= app latest {latest}")
                else:
                    fail(f"corpus min_app_version {min_app} > app latest {latest}: clients would be told to update to a version that does not exist")
            except ValueError as e:
                fail(str(e))
            base = corpus.get("base_url")
            ok(f"corpus base_url {base!r}" if base else "corpus manifest has no base_url (flat layout)")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--local", action="store_true")
    ap.add_argument("--post-deploy", action="store_true")
    ap.add_argument("--app", choices=("kashshaf", "lab"), default="kashshaf",
                    help="which app's versions and changelog to check locally (default: kashshaf)")
    ap.add_argument("--tag", default=None, help="vX.Y.Z (lab-vX.Y.Z with --app lab)")
    ap.add_argument("--api", default=None, help="API base URL (post-deploy)")
    ap.add_argument("--app-manifest", default=None, help="URL or path of app_manifest.json (post-deploy)")
    ap.add_argument("--corpus-manifest", default=None, help="URL or path of corpus_manifest.json (post-deploy)")
    ap.add_argument("--no-manifest-version", action="store_true", help="do not require app_manifest.latest_version == tag")
    args = ap.parse_args()
    if not args.local and not args.post_deploy:
        ap.error("choose --local and/or --post-deploy")
    if args.local:
        (check_local_lab if args.app == "lab" else check_local)(args.tag)
    if args.post_deploy:
        if not args.tag:
            ap.error("--post-deploy needs --tag")
        check_post_deploy(args.tag, args.api, args.app_manifest, args.corpus_manifest, not args.no_manifest_version)
    if FAILURES:
        print(f"\n{len(FAILURES)} check(s) failed")
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
