# Paper modes

Three toggleable looks for GNOME on Ubuntu: your normal desktop, a black-and-white e-ink grade, and a warm stationery “color paper” theme.

The compositor helper grades the whole screen (windows, icons, and chrome). Color paper also swaps GTK, dock, wallpaper, and icons. Regular puts your saved Ubuntu appearance back.

## Requirements

- Ubuntu with **GNOME Shell 50** (Wayland)
- `python3`, `gsettings`, and a session that can load user extensions

Hardware color-transform is not required. Grayscale and the paper wash run as a Mutter `GLSLEffect`.

## Install

```bash
git clone https://github.com/3t1-1aN/paper-modes.git ~/paper-modes
~/paper-modes/mode.sh install
```

That links `paper-mode` into `~/.local/bin`, enables the `paper-modes@local` helper, and binds **Super+Shift+P** to cycle looks.

Log out and back in once so GNOME loads the helper. After that, switches apply immediately.

```bash
paper-mode uninstall   # restore regular, remove helper and shortcut
```

Files in `~/paper-modes` stay on disk.

## Usage

```text
paper-mode                 # current mode
paper-mode status
paper-mode regular         # normal Ubuntu
paper-mode ink             # e-ink, black and white
paper-mode color-paper     # warm stationery desktop
paper-mode cycle           # regular → ink → color-paper → regular
paper-mode toggle          # last paper look ↔ regular
```

A tray icon on the top bar switches the same three modes. **Super+Shift+P** cycles.

## Looks

**Regular** restores the snapshot taken when you first left it (GTK theme, icons, accent, wallpaper, dock, night light).

**Ink** is a Carta-style e-ink grade: no saturation, slightly soft contrast, charcoal blacks, paper whites, a handful of gray levels, and light Bayer dither. Night light is turned off so it does not fight the grade.

**Color paper** is a light stationery UI (Yaru, slate accent, paper dock and wallpaper) plus a mild warm wash so leftover app chrome and icons pick up the same pigment.

Mode switches wash from one look into the next instead of snapping. Wallpaper, icons, and GTK move with that wash.

## Config

Edit `config` in this directory, then run `paper-mode` again (or pick the mode from the tray).

| Knob | Role |
| --- | --- |
| `TRANSITION_MS` | Wash duration in milliseconds |
| `CYCLE_ORDER` | Cycle sequence |
| `KEYBINDING` | Cycle shortcut |
| `INK_*` | E-ink grade (`SATURATION`, `CONTRAST`, `BLACK`, `WHITE`, `LEVELS`, `GRAIN`) |
| `COLOR_*` | Color-paper wash |

Ink stays strictly gray: a warm temperature after desaturation would re-tint midtones (canvas fills, photos). Keep `INK_SATURATION=0` and `INK_TEMPERATURE=6500`.

Lower `INK_CONTRAST` / raise `INK_BLACK` for a milkier panel; the reverse for denser pigment. `INK_LEVELS=16` is crunchier; `24` is smoother.

## Notes

- GNOME does not reload extension JavaScript on disable/enable under Wayland. After you change `extension/`, log out once.
- Existing GTK windows may need a restart to pick up color-paper CSS.
- Blur my Shell is compatible; ink grades straight color then puts alpha back so glass panels do not go extra-transparent.
- State lives in `~/.local/state/paper-modes/` (`active.json`, appearance snapshot, night-light flag).
