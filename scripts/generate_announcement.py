#!/usr/bin/env python3
"""
Announcement Generator CLI Tool

Creates and manages announcements for the Kashshaf app CDN.
Reads/creates announcements.json and provides an interactive CLI for adding,
listing, removing, and archiving announcements.

Usage:
    python generate_announcement.py              # Interactive mode to add announcement
    python generate_announcement.py --list       # List all announcements with status
    python generate_announcement.py --remove ID  # Remove announcement by ID
    python generate_announcement.py --archive    # Move expired to archived array
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional


# Default output path relative to current working directory
DEFAULT_OUTPUT_DIR = Path("announcements")
DEFAULT_OUTPUT_FILE = DEFAULT_OUTPUT_DIR / "announcements.json"

ANNOUNCEMENT_TYPES = ["info", "warning", "critical"]
PRIORITIES = ["normal", "important", "forced"]
TARGETS = ["all", "desktop", "web"]
BODY_FORMATS = ["text", "markdown"]


def slugify(text: str) -> str:
    """Convert text to a URL-friendly slug."""
    # Remove non-alphanumeric characters (except spaces and hyphens)
    text = re.sub(r"[^\w\s-]", "", text.lower())
    # Replace spaces with hyphens
    text = re.sub(r"[\s_]+", "-", text)
    # Remove leading/trailing hyphens
    text = text.strip("-")
    return text[:50]  # Limit length


def parse_relative_date(date_str: str, base: datetime = None) -> Optional[datetime]:
    """
    Parse a date string that can be:
    - ISO format: 2024-01-15
    - Relative: +7d, +2w, +1m
    - 'now' for current time
    - Empty string for None
    """
    if not date_str or date_str.strip() == "":
        return None

    date_str = date_str.strip().lower()
    base = base or datetime.now()

    if date_str == "now":
        return base

    # Check for relative format
    match = re.match(r"^\+(\d+)([dwm])$", date_str)
    if match:
        amount = int(match.group(1))
        unit = match.group(2)

        if unit == "d":
            return base + timedelta(days=amount)
        elif unit == "w":
            return base + timedelta(weeks=amount)
        elif unit == "m":
            return base + timedelta(days=amount * 30)  # Approximate month

    # Try ISO format
    try:
        return datetime.fromisoformat(date_str)
    except ValueError:
        return None


def get_multiline_input(prompt: str) -> str:
    """Get multiline input from user. Empty line to finish."""
    print(prompt)
    print("  (Enter text, empty line to finish)")
    lines = []
    while True:
        line = input()
        if line == "":
            break
        lines.append(line)
    return "\n".join(lines)


def prompt_choice(prompt: str, choices: list, default: str = None) -> str:
    """Prompt user to select from choices."""
    choices_str = "/".join(choices)
    default_str = f" [{default}]" if default else ""

    while True:
        response = input(f"{prompt} ({choices_str}){default_str}: ").strip().lower()

        if response == "" and default:
            return default

        if response in choices:
            return response

        print(f"  Invalid choice. Please enter one of: {choices_str}")


def prompt_bool(prompt: str, default: bool = True) -> bool:
    """Prompt user for yes/no."""
    default_str = "Y/n" if default else "y/N"
    response = input(f"{prompt} [{default_str}]: ").strip().lower()

    if response == "":
        return default

    return response in ("y", "yes", "true", "1")


def prompt_optional(prompt: str, default: str = "") -> Optional[str]:
    """Prompt for optional string input."""
    default_str = f" [{default}]" if default else ""
    response = input(f"{prompt}{default_str}: ").strip()

    if response == "":
        return default if default else None

    return response


def load_announcements(filepath: Path) -> dict:
    """Load announcements from JSON file or create default structure."""
    if filepath.exists():
        with open(filepath, "r", encoding="utf-8") as f:
            return json.load(f)

    return {
        "schema_version": 1,
        "announcements": [],
        "archived": []
    }


def save_announcements(filepath: Path, data: dict) -> None:
    """Save announcements to JSON file."""
    # Ensure directory exists
    filepath.parent.mkdir(parents=True, exist_ok=True)
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"\nSaved to {filepath}")


def get_announcement_status(announcement: dict) -> str:
    """Get the current status of an announcement."""
    now = datetime.now()
    starts_at = datetime.fromisoformat(announcement["starts_at"])
    expires_at = None
    if announcement.get("expires_at"):
        expires_at = datetime.fromisoformat(announcement["expires_at"])

    if now < starts_at:
        return "scheduled"
    elif expires_at and now > expires_at:
        return "expired"
    else:
        return "active"


def list_announcements(data: dict) -> None:
    """List all announcements with their status."""
    announcements = data.get("announcements", [])
    archived = data.get("archived", [])

    if not announcements and not archived:
        print("No announcements found.")
        return

    print("\n=== Active Announcements ===\n")

    if not announcements:
        print("  (none)")
    else:
        for ann in announcements:
            status = get_announcement_status(ann)
            status_symbol = {
                "active": "[*]",
                "scheduled": "[ ]",
                "expired": "[x]"
            }.get(status, "[?]")

            print(f"  {status_symbol} {ann['id']}")
            print(f"      Title: {ann['title']}")
            print(f"      Type: {ann['type']} | Priority: {ann['priority']} | Target: {ann['target']}")
            print(f"      Starts: {ann['starts_at']} | Expires: {ann.get('expires_at', 'never')}")
            print(f"      Status: {status}")
            print()

    if archived:
        print("\n=== Archived Announcements ===\n")
        for ann in archived:
            print(f"  [archived] {ann['id']}")
            print(f"      Title: {ann['title']}")
            print()


def remove_announcement(data: dict, announcement_id: str) -> bool:
    """Remove an announcement by ID."""
    announcements = data.get("announcements", [])

    for i, ann in enumerate(announcements):
        if ann["id"] == announcement_id:
            removed = announcements.pop(i)
            print(f"Removed announcement: {removed['title']}")
            return True

    print(f"Announcement with ID '{announcement_id}' not found.")
    return False


def archive_expired(data: dict) -> int:
    """Move expired announcements to archived array."""
    announcements = data.get("announcements", [])
    archived = data.setdefault("archived", [])

    now = datetime.now()
    to_archive = []
    remaining = []

    for ann in announcements:
        expires_at = ann.get("expires_at")
        if expires_at:
            if datetime.fromisoformat(expires_at) < now:
                to_archive.append(ann)
                continue
        remaining.append(ann)

    data["announcements"] = remaining
    data["archived"].extend(to_archive)

    if to_archive:
        print(f"Archived {len(to_archive)} expired announcement(s):")
        for ann in to_archive:
            print(f"  - {ann['id']}: {ann['title']}")
    else:
        print("No expired announcements to archive.")

    return len(to_archive)


def create_announcement_interactive() -> dict:
    """Interactively create a new announcement."""
    print("\n=== Create New Announcement ===\n")

    # Title (required)
    title = ""
    while not title:
        title = input("Title: ").strip()
        if not title:
            print("  Title is required.")

    # Body (required, multiline)
    body = ""
    while not body:
        body = get_multiline_input("Body:")
        if not body:
            print("  Body is required.")

    # Body format
    body_format = prompt_choice("Body format", BODY_FORMATS, "text")

    # Type
    ann_type = prompt_choice("Type", ANNOUNCEMENT_TYPES, "info")

    # Priority
    priority = prompt_choice("Priority", PRIORITIES, "normal")

    # Target platform
    target = prompt_choice("Target platform", TARGETS, "all")

    # Version constraints
    min_version = prompt_optional("Min app version (e.g., 1.2.0)")
    max_version = prompt_optional("Max app version (e.g., 2.0.0)")

    # Dates
    print("\nDate formats: YYYY-MM-DD, 'now', or relative (+7d, +2w, +1m)")

    starts_at_str = prompt_optional("Starts at", "now")
    starts_at = parse_relative_date(starts_at_str)
    if not starts_at:
        starts_at = datetime.now()

    expires_at_str = prompt_optional("Expires at (empty for never)")
    expires_at = parse_relative_date(expires_at_str, starts_at)

    # Behavior flags
    dismissible = prompt_bool("Dismissible?", True)
    show_once = prompt_bool("Show once per user?", True)

    # Action button
    has_action = prompt_bool("Add action button?", False)
    action = None
    if has_action:
        action_label = input("  Action label: ").strip() or "Learn More"
        action_url = input("  Action URL: ").strip()
        if action_url:
            action = {"label": action_label, "url": action_url}

    # Generate ID
    date_prefix = starts_at.strftime("%Y%m%d")
    title_slug = slugify(title)
    announcement_id = f"{date_prefix}-{title_slug}"

    print(f"\nGenerated ID: {announcement_id}")
    custom_id = prompt_optional("Custom ID (or Enter to use generated)")
    if custom_id:
        announcement_id = custom_id

    # Build announcement object
    announcement = {
        "id": announcement_id,
        "title": title,
        "body": body,
        "body_format": body_format,
        "type": ann_type,
        "priority": priority,
        "target": target,
        "min_app_version": min_version,
        "max_app_version": max_version,
        "starts_at": starts_at.isoformat(),
        "expires_at": expires_at.isoformat() if expires_at else None,
        "dismissible": dismissible,
        "show_once": show_once,
        "action": action
    }

    # Preview
    print("\n=== Preview ===")
    print(json.dumps(announcement, indent=2, ensure_ascii=False))

    if not prompt_bool("\nAdd this announcement?", True):
        print("Cancelled.")
        return None

    return announcement


def main():
    parser = argparse.ArgumentParser(
        description="Generate and manage announcements for Kashshaf CDN"
    )
    parser.add_argument(
        "-f", "--file",
        default=DEFAULT_OUTPUT_FILE,
        help=f"Announcements JSON file (default: {DEFAULT_OUTPUT_FILE})"
    )
    parser.add_argument(
        "--list", "-l",
        action="store_true",
        help="List all announcements with status"
    )
    parser.add_argument(
        "--remove", "-r",
        metavar="ID",
        help="Remove announcement by ID"
    )
    parser.add_argument(
        "--archive", "-a",
        action="store_true",
        help="Move expired announcements to archived array"
    )

    args = parser.parse_args()
    filepath = Path(args.file)

    # Load existing data
    data = load_announcements(filepath)

    # Handle list mode
    if args.list:
        list_announcements(data)
        return

    # Handle remove mode
    if args.remove:
        if remove_announcement(data, args.remove):
            save_announcements(filepath, data)
        return

    # Handle archive mode
    if args.archive:
        count = archive_expired(data)
        if count > 0:
            save_announcements(filepath, data)
        return

    # Interactive mode - create new announcement
    announcement = create_announcement_interactive()
    if announcement:
        data["announcements"].append(announcement)
        save_announcements(filepath, data)
        print(f"\nAnnouncement '{announcement['id']}' added successfully!")


if __name__ == "__main__":
    main()
