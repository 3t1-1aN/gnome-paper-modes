# Shared helpers for paper-modes. Sourced, not executed.

PAPER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAPER_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/paper-modes"
PAPER_ACTIVE="$PAPER_STATE_DIR/active.json"
PAPER_SAVED="$PAPER_STATE_DIR/saved-session"
PAPER_EXT_UUID="paper-modes@local"
PAPER_EXT_SRC="$PAPER_ROOT/extension"
PAPER_EXT_DST="$HOME/.local/share/gnome-shell/extensions/$PAPER_EXT_UUID"
PAPER_BIN="$HOME/.local/bin/paper-mode"

paper_load_config() {
    # shellcheck disable=SC1091
    source "$PAPER_ROOT/config"
}

paper_mkdirs() {
    mkdir -p "$PAPER_STATE_DIR"
}

paper_current_mode() {
    python3 - "$PAPER_ACTIVE" <<'PY'
import json, sys
path = sys.argv[1]
try:
    with open(path, encoding="utf-8") as f:
        print(json.load(f).get("mode", "regular"))
except FileNotFoundError:
    print("regular")
except Exception:
    print("regular")
PY
}

paper_write_active() {
    local mode="$1"
    python3 - "$PAPER_ACTIVE" "$mode" \
        "${saturation:-1}" "${contrast:-1}" "${black:-0}" "${white:-1}" "${temperature:-6500}" \
        "${levels:-1}" "${grain:-0}" <<'PY'
import json, os, sys
path, mode, sat, contrast, black, white, temp, levels, grain = sys.argv[1:10]
os.makedirs(os.path.dirname(path), exist_ok=True)
data = {
    "mode": mode,
    "saturation": float(sat),
    "contrast": float(contrast),
    "black": float(black),
    "white": float(white),
    "temperature": int(float(temp)),
    "levels": float(levels),
    "grain": float(grain),
}
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
PY
}

paper_save_session_if_needed() {
    # Remember the user's night light only when leaving regular the first time
    # in this paper stretch, so regular can restore it.
    local current
    current="$(paper_current_mode)"
    if [[ "$current" == "regular" || ! -f "$PAPER_SAVED" ]]; then
        {
            echo "NIGHT_LIGHT_ENABLED=$(gsettings get org.gnome.settings-daemon.plugins.color night-light-enabled)"
        } > "$PAPER_SAVED"
    fi
}

paper_restore_session() {
    if [[ -f "$PAPER_SAVED" ]]; then
        # shellcheck disable=SC1090
        source "$PAPER_SAVED"
        gsettings set org.gnome.settings-daemon.plugins.color night-light-enabled \
            "${NIGHT_LIGHT_ENABLED:-true}"
    fi
}

paper_disable_night_light() {
    gsettings set org.gnome.settings-daemon.plugins.color night-light-enabled false
}

paper_reload_extension() {
    gdbus call --session \
        --dest local.PaperModes \
        --object-path /local/PaperModes \
        --method local.PaperModes.Reload \
        >/dev/null 2>&1 || true
}

paper_notify() {
    local title="$1"
    local body="$2"
    paper_load_config
    if [[ "${NOTIFY:-1}" == "1" ]] && command -v notify-send >/dev/null; then
        notify-send --app-name="Paper modes" --expire-time=1800 "$title" "$body" || true
    fi
}

paper_extension_enabled() {
    gnome-extensions list --enabled 2>/dev/null | grep -Fxq "$PAPER_EXT_UUID"
}

paper_params_for() {
    local requested="$1"
    paper_load_config
    case "$requested" in
        regular)
            PAPER_MODE="regular"
            saturation=1
            contrast=1
            black=0
            white=1
            temperature=6500
            levels=1
            grain=0
            ;;
        ink)
            PAPER_MODE="ink"
            saturation="$INK_SATURATION"
            contrast="$INK_CONTRAST"
            black="$INK_BLACK"
            white="$INK_WHITE"
            temperature="$INK_TEMPERATURE"
            levels="${INK_LEVELS:-18}"
            grain="${INK_GRAIN:-0.03}"
            ;;
        color-paper|color)
            PAPER_MODE="color-paper"
            saturation="$COLOR_SATURATION"
            contrast="$COLOR_CONTRAST"
            black="$COLOR_BLACK"
            white="$COLOR_WHITE"
            temperature="$COLOR_TEMPERATURE"
            levels=1
            grain=0
            ;;
        *)
            echo "unknown mode: $requested" >&2
            return 1
            ;;
    esac
}

paper_theme_tool() {
    echo "$PAPER_ROOT/themes/color-paper/apply.py"
}

paper_apply() {
    paper_mkdirs
    paper_params_for "$1" || return 1

    if [[ "$PAPER_MODE" == "regular" ]]; then
        paper_write_active regular
        paper_reload_extension
        paper_restore_session
        python3 "$(paper_theme_tool)" restore || true
    elif [[ "$PAPER_MODE" == "ink" ]]; then
        paper_save_session_if_needed
        printf '%s\n' "$PAPER_MODE" > "$PAPER_STATE_DIR/last-paper"
        paper_write_active "$PAPER_MODE"
        paper_reload_extension
        paper_disable_night_light
        python3 "$(paper_theme_tool)" restore --keep-save || true
    else
        paper_save_session_if_needed
        printf '%s\n' "$PAPER_MODE" > "$PAPER_STATE_DIR/last-paper"
        paper_write_active "$PAPER_MODE"
        paper_reload_extension
        python3 "$(paper_theme_tool)" apply || true
    fi

    case "$PAPER_MODE" in
        regular) paper_notify "Paper: regular" "Ubuntu colors restored." ;;
        ink) paper_notify "Paper: ink" "Black-and-white e-ink paper." ;;
        color-paper) paper_notify "Paper: color paper" "Warm stationery desktop." ;;
    esac

    if [[ "$PAPER_MODE" != "regular" ]] && ! paper_extension_enabled; then
        echo "Wrote '$PAPER_MODE'. Log out once so GNOME can load the paper-modes helper," >&2
        echo "then run: paper-mode $PAPER_MODE" >&2
    fi
}
