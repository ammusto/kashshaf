#!/usr/bin/env python3
"""Validate scripts/announcements/announcements.json before it is published.

    python scripts/announcements/validate.py [path]

Checks: top-level schema_version (1), `announcements` and `archived` are
lists, every entry has a unique non-empty id, title, body, body_format in
{markdown, plain}, type in {info, warning, update, maintenance}, priority in
{low, normal, high}, target in {all, desktop, web}, ISO-8601 starts_at,
expires_at null or ISO-8601 and >= starts_at, min/max_app_version X.Y.Z or
null, dismissible / show_once booleans. Exit 1 on the first problem list.
"""
import json
import re
import sys
from datetime import datetime
from pathlib import Path

VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
ENUMS = {
    "body_format": {"markdown", "plain"},
    "type": {"info", "warning", "update", "maintenance"},
    "priority": {"low", "normal", "high"},
    "target": {"all", "desktop", "web"},
}


def parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def check_entry(e: dict, where: str, errors: list[str]) -> None:
    for key in ("id", "title", "body"):
        if not isinstance(e.get(key), str) or not e[key].strip():
            errors.append(f"{where}: {key} missing or empty")
    for key, allowed in ENUMS.items():
        if e.get(key) not in allowed:
            errors.append(f"{where}: {key}={e.get(key)!r} not in {sorted(allowed)}")
    for key in ("dismissible", "show_once"):
        if not isinstance(e.get(key), bool):
            errors.append(f"{where}: {key} must be a boolean")
    for key in ("min_app_version", "max_app_version"):
        v = e.get(key)
        if v is not None and not (isinstance(v, str) and VERSION_RE.match(v)):
            errors.append(f"{where}: {key}={v!r} is not X.Y.Z or null")
    starts = e.get("starts_at")
    try:
        start_dt = parse_iso(starts) if isinstance(starts, str) else None
        if start_dt is None:
            errors.append(f"{where}: starts_at missing or not a string")
    except ValueError:
        errors.append(f"{where}: starts_at {starts!r} is not ISO-8601")
        start_dt = None
    expires = e.get("expires_at")
    if expires is not None:
        try:
            exp_dt = parse_iso(expires)
            if start_dt is not None and (exp_dt.tzinfo is None) == (start_dt.tzinfo is None) and exp_dt < start_dt:
                errors.append(f"{where}: expires_at {expires} is before starts_at {starts}")
        except (ValueError, TypeError):
            errors.append(f"{where}: expires_at {expires!r} is not ISO-8601 or null")
    action = e.get("action")
    if action is not None and not (isinstance(action, dict) and isinstance(action.get("url"), str)):
        errors.append(f"{where}: action must be null or an object with a url")


def main() -> int:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent / "announcements.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        print(f"FAIL {path}: {e}")
        return 1
    errors: list[str] = []
    if data.get("schema_version") != 1:
        errors.append(f"schema_version={data.get('schema_version')!r}, expected 1")
    seen: set[str] = set()
    for section in ("announcements", "archived"):
        items = data.get(section)
        if not isinstance(items, list):
            errors.append(f"{section} must be a list")
            continue
        for i, e in enumerate(items):
            where = f"{section}[{i}]"
            if not isinstance(e, dict):
                errors.append(f"{where}: not an object")
                continue
            check_entry(e, where, errors)
            if isinstance(e.get("id"), str):
                if e["id"] in seen:
                    errors.append(f"{where}: duplicate id {e['id']!r}")
                seen.add(e["id"])
    if errors:
        print("\n".join("FAIL " + x for x in errors))
        return 1
    n = len(data.get("announcements", []))
    print(f"OK {path.name}: {n} active, {len(data.get('archived', []))} archived, ids unique, dates valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
