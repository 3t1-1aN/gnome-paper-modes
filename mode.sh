#!/usr/bin/env bash
# paper-modes dispatcher
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck disable=SC1091
source "$ROOT/lib.sh"
paper_load_config

usage() {
    cat <<'EOF'
paper-mode — switch the desktop color look

Usage:
  paper-mode                    Show current mode
  paper-mode status
  paper-mode regular            Normal Ubuntu colors
  paper-mode ink                Black-and-white e-ink paper
  paper-mode color-paper        Warm, desaturated paper
  paper-mode cycle              regular → ink → color-paper → regular
  paper-mode toggle             Last paper look ↔ regular
  paper-mode install            Install compositor helper + Super+Shift+P
  paper-mode uninstall          Remove helper, binding, and restore regular
  paper-mode bind|unbind        Add or remove the cycle shortcut

Shortcuts:
  Super+Shift+P                 Cycle modes (after install)
EOF
}

paper_bind() {
    paper_load_config
    local binding="${KEYBINDING:-<Super><Shift>p}"
    python3 - "$PAPER_BIN" "$binding" <<'PY'
import ast, subprocess, sys

bin_path, binding = sys.argv[1], sys.argv[2]
wanted = f"{bin_path} cycle"
keys = "org.gnome.settings-daemon.plugins.media-keys"
item = "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding"

def gs(*args):
    return subprocess.check_output(["gsettings", *args], text=True).strip()

items = list(ast.literal_eval(gs("get", keys, "custom-keybindings")))
for path in items:
    try:
        command = gs("get", f"{item}:{path}", "command").strip("'")
    except subprocess.CalledProcessError:
        continue
    if command == wanted:
        print(f"Keybinding already installed ({binding}).")
        raise SystemExit(0)

n = 0
while True:
    path = f"/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom{n}/"
    if path not in items:
        break
    n += 1
    if n > 50:
        print("Could not find a free custom keybinding slot.", file=sys.stderr)
        raise SystemExit(1)

items.append(path)
formatted = "[" + ", ".join(f"'{p}'" for p in items) + "]"
subprocess.run(["gsettings", "set", keys, "custom-keybindings", formatted], check=True)
subprocess.run(["gsettings", "set", f"{item}:{path}", "name", "Cycle paper mode"], check=True)
subprocess.run(["gsettings", "set", f"{item}:{path}", "command", wanted], check=True)
subprocess.run(["gsettings", "set", f"{item}:{path}", "binding", binding], check=True)
print(f"Bound {binding} to paper-mode cycle.")
PY
}

paper_unbind() {
    python3 <<'PY'
import ast, subprocess

def gs(*args):
    return subprocess.check_output(["gsettings", *args], text=True).strip()

keys = "org.gnome.settings-daemon.plugins.media-keys"
item = "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding"
items = list(ast.literal_eval(gs("get", keys, "custom-keybindings")))
keep = []
removed = False
for path in items:
    try:
        command = gs("get", f"{item}:{path}", "command")
    except subprocess.CalledProcessError:
        keep.append(path)
        continue
    if "paper-mode" in command:
        for key in ("name", "command", "binding"):
            subprocess.run(["gsettings", "reset", f"{item}:{path}", key], check=False)
        removed = True
    else:
        keep.append(path)
if removed:
    formatted = "[" + ", ".join(f"'{p}'" for p in keep) + "]"
    subprocess.run(["gsettings", "set", keys, "custom-keybindings", formatted], check=True)
    print("Removed paper-mode keybinding.")
PY
}

paper_enable_in_gnome() {
    python3 - "$PAPER_EXT_UUID" <<'PY'
import ast, subprocess, sys
uuid = sys.argv[1]
raw = subprocess.check_output(
    ["gsettings", "get", "org.gnome.shell", "enabled-extensions"], text=True
).strip()
items = list(ast.literal_eval(raw))
if uuid not in items:
    items.append(uuid)
    formatted = "[" + ", ".join(f"'{x}'" for x in items) + "]"
    subprocess.run(
        ["gsettings", "set", "org.gnome.shell", "enabled-extensions", formatted],
        check=True,
    )
PY
    gnome-extensions enable "$PAPER_EXT_UUID" >/dev/null 2>&1 || true
}

paper_disable_in_gnome() {
    gnome-extensions disable "$PAPER_EXT_UUID" >/dev/null 2>&1 || true
    python3 - "$PAPER_EXT_UUID" <<'PY'
import ast, subprocess, sys
uuid = sys.argv[1]
raw = subprocess.check_output(
    ["gsettings", "get", "org.gnome.shell", "enabled-extensions"], text=True
).strip()
items = [x for x in ast.literal_eval(raw) if x != uuid]
formatted = "[" + ", ".join(f"'{x}'" for x in items) + "]"
subprocess.run(
    ["gsettings", "set", "org.gnome.shell", "enabled-extensions", formatted],
    check=True,
)
PY
}

paper_install() {
    mkdir -p "$(dirname "$PAPER_EXT_DST")" "$(dirname "$PAPER_BIN")"
    ln -sfn "$PAPER_EXT_SRC" "$PAPER_EXT_DST"
    ln -sfn "$ROOT/mode.sh" "$PAPER_BIN"
    # GNOME reports the extension path as the symlink location, so a
    # sibling mode.sh keeps the currently loaded tray helper working.
    ln -sfn "$ROOT/mode.sh" "$HOME/.local/share/gnome-shell/extensions/mode.sh"
    paper_enable_in_gnome
    paper_bind
    echo "Installed $PAPER_BIN"
    if paper_extension_enabled; then
        echo "Compositor helper is enabled."
        paper_reload_extension
    else
        echo "Compositor helper will load after you log out and back in once."
    fi
}

paper_uninstall() {
    paper_apply regular || true
    paper_disable_in_gnome || true
    paper_unbind || true
    rm -f "$PAPER_EXT_DST" "$PAPER_BIN" \
        "$HOME/.local/share/gnome-shell/extensions/mode.sh"
    echo "Uninstalled paper-modes helper. Files remain in $ROOT"
}

paper_cycle() {
    paper_load_config
    local current next found=0
    current="$(paper_current_mode)"
    # shellcheck disable=SC2206
    local order=(${CYCLE_ORDER:-regular ink color-paper})
    for i in "${!order[@]}"; do
        if [[ "${order[$i]}" == "$current" ]]; then
            next="${order[$(( (i + 1) % ${#order[@]} ))]}"
            found=1
            break
        fi
    done
    if [[ "$found" -eq 0 ]]; then
        next="${order[0]}"
    fi
    paper_apply "$next"
}

paper_toggle() {
    local current last="ink"
    current="$(paper_current_mode)"
    if [[ "$current" == "regular" ]]; then
        [[ -f "$PAPER_STATE_DIR/last-paper" ]] && last="$(<"$PAPER_STATE_DIR/last-paper")"
        last="${last//$'\n'/}"
        [[ "$last" == "regular" || -z "$last" ]] && last="ink"
        paper_apply "$last"
    else
        paper_apply regular
    fi
}

paper_status() {
    local current helper="disabled"
    current="$(paper_current_mode)"
    paper_extension_enabled && helper="enabled"
    echo "mode: $current"
    echo "helper: $helper"
    if [[ -f "$PAPER_ACTIVE" ]]; then
        echo "active: $PAPER_ACTIVE"
        python3 -m json.tool "$PAPER_ACTIVE"
    fi
}

cmd="${1:-status}"
case "$cmd" in
    -h|--help|help) usage ;;
    status) paper_status ;;
    regular|ink|color-paper|color) paper_apply "$cmd" ;;
    cycle) paper_cycle ;;
    toggle) paper_toggle ;;
    install) paper_install ;;
    uninstall) paper_uninstall ;;
    bind) paper_bind ;;
    unbind) paper_unbind ;;
    *)
        echo "Unknown command: $cmd" >&2
        usage >&2
        exit 1
        ;;
esac
