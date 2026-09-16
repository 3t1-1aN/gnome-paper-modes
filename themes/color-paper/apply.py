#!/usr/bin/env python3
"""Apply or restore the Color Paper GTK/dock/wallpaper appearance."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

HOME = Path.home()
ROOT = Path(__file__).resolve().parent
STATE = Path(HOME / ".local/state/paper-modes")
SAVED = STATE / "appearance.json"
MARKER = "paper-modes: color-paper"
GTK3 = HOME / ".config/gtk-3.0/gtk.css"
GTK4 = HOME / ".config/gtk-4.0/gtk.css"
# Prefer the lean JPEG; PNG remains as a generated sibling.
WALLPAPER_SRC = ROOT / "wallpaper.jpg"
WALLPAPER_SRC_FALLBACK = ROOT / "wallpaper.png"
# Stable path under the backgrounds dir GNOME already watches.
WALLPAPER_DST = HOME / ".local/share/backgrounds/paper-modes-color-paper.jpg"
PAPER_PRIMARY = "#F7F1E8"

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


def ensure_wallpaper_asset() -> Path:
    """Return a wallpaper file path, regenerating the lean JPEG if needed."""
    if WALLPAPER_SRC.exists() and WALLPAPER_SRC.stat().st_size > 10_000:
        return WALLPAPER_SRC
    gen = ROOT / "generate_wallpaper.py"
    if gen.exists():
        subprocess.run([sys.executable, str(gen)], check=False)
    if WALLPAPER_SRC.exists():
        return WALLPAPER_SRC
    if WALLPAPER_SRC_FALLBACK.exists():
        return WALLPAPER_SRC_FALLBACK
    raise FileNotFoundError(f"missing wallpaper at {WALLPAPER_SRC}")


def install_wallpaper() -> Path:
    """Copy into ~/.local/share/backgrounds so GNOME has a stable, small file."""
    src = ensure_wallpaper_asset()
    WALLPAPER_DST.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, WALLPAPER_DST)
    return WALLPAPER_DST


def set_wallpaper(path: Path) -> None:
    """Point both light/dark URIs at the paper wallpaper and force a reload.

    If glycin fails to decode (OOM), GNOME keeps showing primary-color — which
    for color-paper is cream/white. Setting the URI alone is not enough when
    the previous URI was already the same file after a failed load, so we
    bounce primary-color and re-apply the URI once after a short delay.
    """
    uri = f"file://{path}"
    quoted = f"'{uri}'"
    gs_set("org.gnome.desktop.background", "picture-options", "'zoom'")
    gs_set("org.gnome.desktop.background", "color-shading-type", "'solid'")
    # Temporary non-paper primary so a failed decode is obvious/dark, then paper.
    gs_set("org.gnome.desktop.background", "primary-color", "'#1a1a1a'")
    gs_set("org.gnome.desktop.background", "picture-uri", quoted)
    gs_set("org.gnome.desktop.background", "picture-uri-dark", quoted)
    gs_set("org.gnome.desktop.background", "primary-color", f"'{PAPER_PRIMARY}'")

    # Deferred re-set: mode switches often coincide with peak memory (blur,
    # shell effects). A second apply after glycin settles fixes white desktops.
    retry = f"""
import subprocess, time
time.sleep(1.2)
uri = {quoted!r}
for key in ("picture-uri", "picture-uri-dark"):
    subprocess.run(["gsettings", "set", "org.gnome.desktop.background", key, uri], check=False)
subprocess.run(
    ["gsettings", "set", "org.gnome.desktop.background", "primary-color", "'{PAPER_PRIMARY}'"],
    check=False,
)
"""
    subprocess.Popen(
        [sys.executable, "-c", retry],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


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
    # Keep the user's app light/dark preference and GTK theme unchanged.
    # Color paper should come from compositor grade + wallpaper + dock chrome.
    prefers_dark = "prefer-dark" in gs_get("org.gnome.desktop.interface", "color-scheme")
    if prefers_dark:
        write_css(GTK3, ROOT / "gtk-3-dark.css")
        write_css(GTK4, ROOT / "gtk-4-dark.css")
    else:
        if GTK3.exists() and ours(GTK3):
            GTK3.unlink()
        if GTK4.exists() and ours(GTK4):
            GTK4.unlink()
    gs_set("org.gnome.desktop.interface", "icon-theme", "'Yaru'")
    gs_set("org.gnome.desktop.interface", "accent-color", "slate")
    gs_set("org.gnome.settings-daemon.plugins.color", "night-light-enabled", "false")

    try:
        installed = install_wallpaper()
        set_wallpaper(installed)
    except Exception as exc:  # noqa: BLE001 - surface in journal via stderr
        print(f"paper-modes: wallpaper apply failed: {exc}", file=sys.stderr)

    # Dock chrome follows the same light/dark paper split as GTK.
    if prefers_dark:
        dock_bg = "'#30343A'"
        dock_dots = "'#8FA3AE'"
    else:
        dock_bg = "'#F5EFE7'"
        dock_dots = "'#D9E4EA'"
    gs_set("org.gnome.shell.extensions.dash-to-dock", "custom-background-color", "true")
    gs_set("org.gnome.shell.extensions.dash-to-dock", "background-color", dock_bg)
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
        dock_dots,
    )
    gs_set("org.gnome.shell.extensions.dash-to-dock", "apply-glossy-effect", "false")


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
