#!/usr/bin/env python3
"""Cut a Kashshaf release: bump every version file, write the release notes,
commit, tag, push. The tag is what triggers `.github/workflows/release.yml`
(which itself defaults to a dry run; the real release is a workflow_dispatch
with `dry_run: false`).

    python scripts/release.py 0.5.0 [--min-supported-version 0.5.0]
                                    [--notes-file docs/changelog.md]
                                    [--dry-run]

What it touches:
  * Cargo.toml (workspace version) — or, before the workspace exists,
    src-tauri/Cargo.toml, api/Cargo.toml and engine/Cargo.toml
  * package.json  (src-tauri/tauri.conf.json reads its version from there;
    older configs with a literal "version" are updated too)
  * scripts/manifests/app_manifest.json (local preview of the entry; the
    workflow's `manifest` job builds the live one from the actual assets)
  * .release/min_supported_version — marker read by the workflow's manifest
    job when --min-supported-version is passed

--dry-run prints every change and every git command without writing,
committing, tagging or pushing anything.
"""
import argparse
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
DRY = False


def say(msg: str) -> None:
    print(("[dry-run] " if DRY else "") + msg)


def run(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess:
    if DRY:
        say("$ " + " ".join(cmd))
        return subprocess.CompletedProcess(cmd, 0, "", "")
    return subprocess.run(cmd, check=check, cwd=ROOT, capture_output=True, text=True, encoding="utf-8")


def write_text(path: Path, content: str) -> None:
    if DRY:
        say(f"would write {path.relative_to(ROOT)} ({len(content)} bytes)")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    print(f"OK Updated {path.relative_to(ROOT)}")


# ---------------------------------------------------------------- checks

def check_preconditions() -> None:
    status = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True).stdout
    if status.strip():
        print("Error: working directory has uncommitted changes:\n" + status)
        if not DRY:
            sys.exit(1)
    branch = subprocess.run(["git", "branch", "--show-current"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    if branch != "main":
        print(f"Error: not on main (currently on '{branch}')")
        if not DRY:
            sys.exit(1)
    print("OK Pre-flight checks passed" if not status.strip() and branch == "main" else "! pre-flight problems ignored in dry run")


# ---------------------------------------------------------------- version files

def bump_toml_version(path: Path, version: str, key_regex: str) -> bool:
    if not path.exists():
        return False
    content = path.read_text(encoding="utf-8")
    new, n = re.subn(key_regex, lambda m: m.group(1) + f'"{version}"', content, count=1, flags=re.MULTILINE)
    if n == 0:
        return False
    write_text(path, new)
    return True


def update_cargo_versions(version: str) -> None:
    root_toml = ROOT / "Cargo.toml"
    if root_toml.exists() and "[workspace.package]" in root_toml.read_text(encoding="utf-8"):
        # Single source of truth: the workspace version.
        content = root_toml.read_text(encoding="utf-8")
        a = content.index("[workspace.package]")
        head, tail = content[:a], content[a:]
        tail, n = re.subn(r'^(version = )"[^"]*"', lambda m: m.group(1) + f'"{version}"', tail, count=1, flags=re.MULTILINE)
        if n != 1:
            print("Error: Cargo.toml has [workspace.package] but no version line")
            sys.exit(1)
        write_text(root_toml, head + tail)
        return
    for rel in ("src-tauri/Cargo.toml", "api/Cargo.toml", "engine/Cargo.toml"):
        if not bump_toml_version(ROOT / rel, version, r'^(version = )"[^"]*"'):
            print(f"Warning: {rel} not found or has no version line")


def update_package_json(version: str) -> None:
    path = ROOT / "package.json"
    config = json.loads(path.read_text(encoding="utf-8"))
    config["version"] = version
    write_text(path, json.dumps(config, indent=2) + "\n")


def update_tauri_conf(version: str) -> None:
    path = ROOT / "src-tauri/tauri.conf.json"
    config = json.loads(path.read_text(encoding="utf-8"))
    current = config.get("version")
    if isinstance(current, str) and current.endswith("package.json"):
        print(f"OK {path.relative_to(ROOT)} takes its version from {current}; nothing to do")
        return
    config["version"] = version
    write_text(path, json.dumps(config, indent=2) + "\n")


# ---------------------------------------------------------------- notes

def notes_from_changelog(path: Path, version: str) -> str | None:
    """The body of the `## [X.Y.Z]` section of a Keep-a-Changelog file."""
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8")
    m = re.search(rf"^## \[{re.escape(version)}\][^\n]*\n(.*?)(?=^## \[|\Z)", text, flags=re.MULTILINE | re.DOTALL)
    if not m:
        return None
    body = m.group(1).strip()
    return body or None


def read_notes(notes_file: Path | None, version: str) -> str:
    if notes_file is not None and notes_file.suffix.lower() == ".md" and notes_file.name.lower() == "changelog.md":
        notes = notes_from_changelog(notes_file, version)
        if notes:
            print(f"OK Release notes: section [{version}] of {notes_file}")
            return notes
        print(f"!! {notes_file} has no ## [{version}] section")
    elif notes_file is not None and notes_file.exists():
        print(f"OK Release notes: {notes_file}")
        return notes_file.read_text(encoding="utf-8").strip()
    if DRY:
        return "(dry run: no release notes)"
    print("\nEnter release notes (press Enter twice to finish):")
    lines = []
    while True:
        line = input()
        if line == "":
            break
        lines.append(line)
    return "\n".join(lines) if lines else "Bug fixes and improvements"


# ---------------------------------------------------------------- manifest preview + marker

def generate_app_manifest(version: str, notes: str, min_supported: str | None) -> None:
    """Local preview of the app manifest entry. The live manifest is built by
    the workflow's `manifest` job from the real release assets; this file is
    only a convenience (scripts/manifests/ is gitignored)."""
    new_release = {
        "version": version,
        "released_at": datetime.now().strftime("%Y-%m-%d"),
        "required": False,
        "notes": notes,
        "downloads": {
            "windows": f"https://github.com/ammusto/kashshaf/releases/download/v{version}/Kashshaf_{version}_x64_en-US.msi",
            "macos": f"https://github.com/ammusto/kashshaf/releases/download/v{version}/Kashshaf_{version}_macos.dmg",
            "linux": f"https://github.com/ammusto/kashshaf/releases/download/v{version}/Kashshaf_{version}_amd64.AppImage",
        },
    }
    manifest_path = ROOT / "scripts/manifests/app_manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["latest_version"] = version
        if min_supported is not None:
            manifest["min_supported_version"] = min_supported
        manifest["releases"] = [r for r in manifest["releases"] if r.get("version") != version]
        manifest["releases"].insert(0, new_release)
    else:
        manifest = {
            "latest_version": version,
            "min_supported_version": min_supported if min_supported is not None else version,
            "releases": [new_release],
        }
    write_text(manifest_path, json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(f"  -> preview only; the workflow builds the live manifest (min_supported_version: {manifest['min_supported_version']})")


def write_marker(min_supported: str | None) -> None:
    marker = ROOT / ".release/min_supported_version"
    if min_supported is None:
        if marker.exists():
            say(f"would remove stale marker {marker.relative_to(ROOT)}" if DRY else f"removing stale marker {marker.relative_to(ROOT)}")
            if not DRY:
                marker.unlink()
        return
    write_text(marker, min_supported + "\n")
    print(f"  -> the workflow's manifest job sets min_supported_version = {min_supported}")


# ---------------------------------------------------------------- git

def git_commands(version: str) -> None:
    tag = f"v{version}"
    existing = subprocess.run(["git", "tag", "-l", tag], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    if existing == tag:
        print(f"Error: tag {tag} already exists")
        if not DRY:
            sys.exit(1)
    run(["git", "add", "-A"])
    run(["git", "commit", "-m", f"{tag} release"], check=False)
    run(["git", "push", "origin", "main"])
    run(["git", "tag", tag])
    run(["git", "push", "origin", tag])
    say(f"created and pushed tag {tag}")


def main() -> int:
    global DRY
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("version", help="Release version in X.Y.Z form (e.g. 0.5.0)")
    parser.add_argument("--min-supported-version", dest="min_supported_version", default=None,
                        help="Minimum app version still allowed by the app manifest; written to "
                             ".release/min_supported_version for the workflow. Omit to keep the current value.")
    parser.add_argument("--notes-file", type=Path, default=ROOT / "docs/changelog.md",
                        help="Release notes: a changelog.md (its ## [X.Y.Z] section is used) or any text file "
                             "(default: docs/changelog.md)")
    parser.add_argument("--dry-run", action="store_true", help="Print what would change; touch nothing")
    parser.add_argument("--yes", action="store_true", help="Skip the confirmation prompt")
    args = parser.parse_args()
    DRY = args.dry_run

    version = args.version
    if not VERSION_RE.match(version):
        print(f"Error: invalid version '{version}', use X.Y.Z")
        return 1
    if args.min_supported_version is not None and not VERSION_RE.match(args.min_supported_version):
        print(f"Error: invalid --min-supported-version '{args.min_supported_version}', use X.Y.Z")
        return 1

    print(f"\nReleasing Kashshaf v{version}{' (dry run)' if DRY else ''}\n")
    check_preconditions()
    notes = read_notes(args.notes_file, version)

    update_cargo_versions(version)
    update_package_json(version)
    update_tauri_conf(version)
    generate_app_manifest(version, notes, args.min_supported_version)
    write_marker(args.min_supported_version)

    if not DRY and not args.yes:
        response = input(f"\nReady to commit and tag v{version}. Continue? [y/N] ").strip().lower()
        if response != "y":
            print("Aborted. Local files have been modified; run 'git checkout .' to revert.")
            return 0
    git_commands(version)

    print(f"\nRelease v{version} {'would be' if DRY else 'is'} tagged.")
    print("Next: the tag push runs release.yml as a DRY RUN (builds, no side effects).")
    print(f"To publish for real: Actions -> Release -> Run workflow -> tag v{version}, dry_run = false.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
