#!/usr/bin/env python3
"""Apply or restore the Color Paper GTK/dock/wallpaper appearance."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path

HOME = Path.home()
ROOT = Path(__file__).resolve().parent
STATE = Path(HOME / ".local/state/paper-modes")
SAVED = STATE / "appearance.json"
MARKER = "paper-modes: color-paper"
GTK3 = HOME / ".config/gtk-3.0/gtk.css"
GTK4 = HOME / ".config/gtk-4.0/gtk.css"
WALLPAPER = ROOT / "wallpaper.png"

GSET = [
    ("org.gnome.desktop.interface", "gtk-theme"),
    ("org.gnome.desktop.interface", "icon-theme"),
    ("org.gnome.desktop.interface", "color-scheme"),
    ("org.gnome.desktop.interface", "accent-color"),
    ("org.gnome.settings-daemon.plugins.color", "night-light-enabled"),
    ("org.gnome.desktop.background", "picture-uri"),
    ("org.gnome.desktop.background", "picture-uri-dark"),
    ("org.gnome.desktop.background", "primary-color"),
    ("org.gnome.shell.extensions.dash-to-dock", "custom-background-color"),
    ("org.gnome.shell.extensions.dash-to-dock", "background-color"),
    ("org.gnome.shell.extensions.dash-to-dock", "background-opacity"),
    ("org.gnome.shell.extensions.dash-to-dock", "transparency-mode"),
    ("org.gnome.shell.extensions.dash-to-dock", "custom-theme-customize-running-dots"),
    ("org.gnome.shell.extensions.dash-to-dock", "custom-theme-running-dots-color"),
    ("org.gnome.shell.extensions.dash-to-dock", "apply-glossy-effect"),
]


def gs_get(schema: str, key: str) -> str:
    return subprocess.check_output(["gsettings", "get", schema, key], text=True).strip()


def gs_set(schema: str, key: str, value: str) -> None:
    subprocess.run(["gsettings", "set", schema, key, value], check=True)


def ours(path: Path) -> bool:
    try:
        return MARKER in path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return False


def write_css(dest: Path, src: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")


def save_appearance() -> None:
    STATE.mkdir(parents=True, exist_ok=True)
    if SAVED.exists():
        return
    data = {f"{s}:{k}": gs_get(s, k) for s, k in GSET}
    legacy = STATE / "saved-session"
    if legacy.exists():
        text = legacy.read_text(encoding="utf-8", errors="replace")
        if "NIGHT_LIGHT_ENABLED=true" in text:
            data["org.gnome.settings-daemon.plugins.color:night-light-enabled"] = "true"
        elif "NIGHT_LIGHT_ENABLED=false" in text:
            data["org.gnome.settings-daemon.plugins.color:night-light-enabled"] = "false"
    gtk3_backup = STATE / "gtk-3.css.bak"
    gtk4_backup = STATE / "gtk-4.css.bak"
    if GTK3.exists() and not ours(GTK3):
        shutil.copy2(GTK3, gtk3_backup)
        data["gtk3_backup"] = str(gtk3_backup)
    if GTK4.exists() and not ours(GTK4):
        shutil.copy2(GTK4, gtk4_backup)
        data["gtk4_backup"] = str(gtk4_backup)
    SAVED.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def apply_paper() -> None:
    save_appearance()
    already = ours(GTK3)
    write_css(GTK3, ROOT / "gtk-3.css")
    write_css(GTK4, ROOT / "gtk-4.css")
    gs_set("org.gnome.desktop.interface", "color-scheme", "prefer-light")
    gs_set("org.gnome.desktop.interface", "gtk-theme", "'Yaru'")
    gs_set("org.gnome.desktop.interface", "icon-theme", "'Yaru'")
    gs_set("org.gnome.desktop.interface", "accent-color", "slate")
    gs_set("org.gnome.settings-daemon.plugins.color", "night-light-enabled", "false")
    if WALLPAPER.exists():
        uri = f"'file://{WALLPAPER}'"
        gs_set("org.gnome.desktop.background", "picture-uri", uri)
        gs_set("org.gnome.desktop.background", "picture-uri-dark", uri)
        gs_set("org.gnome.desktop.background", "primary-color", "'#F7F1E8'")
    gs_set("org.gnome.shell.extensions.dash-to-dock", "custom-background-color", "true")
    gs_set("org.gnome.shell.extensions.dash-to-dock", "background-color", "'#F5EFE7'")
    gs_set("org.gnome.shell.extensions.dash-to-dock", "background-opacity", "0.94")
    gs_set("org.gnome.shell.extensions.dash-to-dock", "transparency-mode", "'FIXED'")
    gs_set(
        "org.gnome.shell.extensions.dash-to-dock",
        "custom-theme-customize-running-dots",
        "true",
    )
    gs_set(
        "org.gnome.shell.extensions.dash-to-dock",
        "custom-theme-running-dots-color",
        "'#D9E4EA'",
    )
    gs_set("org.gnome.shell.extensions.dash-to-dock", "apply-glossy-effect", "false")
    if not already:
        # Nudge GTK to reload the user stylesheet.
        gs_set("org.gnome.desktop.interface", "gtk-theme", "'Adwaita'")
        gs_set("org.gnome.desktop.interface", "gtk-theme", "'Yaru'")


def restore_css(path: Path, backup_key: str, data: dict) -> None:
    backup = data.get(backup_key)
    if backup and Path(backup).exists():
        shutil.copy2(backup, path)
        return
    if path.exists() and ours(path):
        path.unlink()


def restore(keep_save: bool) -> None:
    if not SAVED.exists():
        if GTK3.exists() and ours(GTK3):
            GTK3.unlink()
        if GTK4.exists() and ours(GTK4):
            GTK4.unlink()
        return
    data = json.loads(SAVED.read_text(encoding="utf-8"))
    restore_css(GTK3, "gtk3_backup", data)
    restore_css(GTK4, "gtk4_backup", data)
    for schema, key in GSET:
        raw = data.get(f"{schema}:{key}")
        if raw is None:
            continue
        gs_set(schema, key, raw)
    if not keep_save:
        SAVED.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("apply", "restore"))
    parser.add_argument("--keep-save", action="store_true")
    args = parser.parse_args()
    if args.command == "apply":
        apply_paper()
    else:
        restore(args.keep_save)


if __name__ == "__main__":
    main()
