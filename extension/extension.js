import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {PaperIndicator} from './indicator.js';

const BUS_NAME = 'local.PaperModes';
const BUS_PATH = '/local/PaperModes';
const BUS_IFACE = 'local.PaperModes';

const DBUS_XML = `
<node>
  <interface name="${BUS_IFACE}">
    <method name="Reload"/>
    <method name="SetMode">
      <arg type="s" name="mode" direction="in"/>
    </method>
    <property name="Mode" type="s" access="read"/>
  </interface>
</node>`;

const IDENTITY = {
    mode: 'regular',
    saturation: 1,
    contrast: 1,
    black: 0,
    white: 1,
    temperature: 6500,
    levels: 1,
    grain: 0,
};

const VEIL = {
    ink: [0.91, 0.905, 0.89],
    'color-paper': [0.965, 0.942, 0.905],
    regular: [0.94, 0.938, 0.93],
};

// Dual grade plus a moving paper front. wash_style picks the geometry
// (0 down, 1 radial, 2 up). wipe blends a global lerp with that front.
// At rest mix_t=1, wash=1, veil=0 so this collapses to the destination.
const SHADER_DECL = `
uniform float sat_a;
uniform float sat_b;
uniform float contrast_a;
uniform float contrast_b;
uniform float black_a;
uniform float black_b;
uniform float white_a;
uniform float white_b;
uniform vec3 temp_a;
uniform vec3 temp_b;
uniform float mix_t;
uniform float wash;
uniform float veil;
uniform vec3 veil_rgb;
uniform vec2 resolution;
uniform float levels_a;
uniform float levels_b;
uniform float grain_a;
uniform float grain_b;
uniform float wipe;
uniform float wash_style;
`;

const SHADER_CODE = `
float alpha = cogl_color_out.a;
vec3 premul = cogl_color_out.rgb;
// Some blur passes can hand us very small alpha with non-trivial RGB.
// Guard the unpremultiply so those pixels cannot explode into a white veil.
vec3 src = alpha > 0.001 ? clamp(premul / alpha, 0.0, 1.0) : vec3(0.0);
float luma = dot(src, vec3(0.299, 0.587, 0.114));

// Saturate once. A second luma mix used to run after remap and crushed
// mild color-paper washes into grey (especially cool wallpaper pigments).
vec3 a = mix(vec3(luma), src, sat_a);
a = (a - 0.5) * contrast_a + 0.5;
a *= temp_a;
a = clamp(mix(vec3(black_a), vec3(white_a), clamp(a, 0.0, 1.0)), 0.0, 1.0);

vec3 b = mix(vec3(luma), src, sat_b);
b = (b - 0.5) * contrast_b + 0.5;
b *= temp_b;
b = clamp(mix(vec3(black_b), vec3(white_b), clamp(b, 0.0, 1.0)), 0.0, 1.0);

float yv = gl_FragCoord.y / max(resolution.y, 1.0);
float xv = gl_FragCoord.x / max(resolution.x, 1.0);
float aspect = resolution.x / max(resolution.y, 1.0);
float rad = length(vec2((xv - 0.5) * aspect, yv - 0.5));
float down = 1.0 - yv;
float up = yv;
float coord = down;
coord = mix(coord, rad * 1.28, step(0.5, wash_style) * (1.0 - step(1.5, wash_style)));
coord = mix(coord, up, step(1.5, wash_style));

float front = mix(-0.18, 1.18, wash);
float spatial = smoothstep(front - 0.22, front + 0.16, coord);
float reveal = clamp(mix(mix_t, 1.0 - spatial, wipe), 0.0, 1.0);
vec3 color = mix(a, b, reveal);

float wet = 1.0 - smoothstep(0.0, 0.14, abs(coord - front));
float paper = clamp(veil * 0.22 + veil * wet * 0.72, 0.0, 0.82);
color = mix(color, veil_rgb, paper);

// Resting ink must stay gray: skip the wash path when we are already there.
float rest = step(0.999, mix_t) * step(veil, 0.001);
color = mix(color, b, rest);

float sat = mix(sat_a, sat_b, reveal);
float inkness = 1.0 - smoothstep(0.02, 0.12, sat);
float g = dot(color, vec3(0.299, 0.587, 0.114));
vec2 bxy = mod(floor(gl_FragCoord.xy), 4.0);
float bayer = (
    mod(bxy.x, 2.0) * 8.0 +
    mod(bxy.y, 2.0) * 4.0 +
    mod(floor(bxy.x * 0.5), 2.0) * 2.0 +
    mod(floor(bxy.y * 0.5), 2.0)
) / 16.0;
float grain = mix(grain_a, grain_b, reveal);
float levels = mix(levels_a, levels_b, reveal);
g += (bayer - 0.47) * grain * inkness;
g = mix(g, floor(g * max(levels, 1.0) + 0.5) / max(levels, 1.0), step(1.5, levels));
color = mix(color, vec3(clamp(g, 0.0, 1.0)), inkness);

vec3 gradedPremul = clamp(color, 0.0, 1.0) * alpha;
// Keep translucent layers close to their original premul color to avoid
// random "see-through" artifacts when other extensions animate blur/focus.
float alphaGate = smoothstep(0.10, 0.24, alpha);
cogl_color_out.rgb = mix(premul, gradedPremul, alphaGate);
`;

function kelvinToRgb(kelvin) {
    const t = Math.max(1000, Math.min(12000, kelvin)) / 100;
    let r, g, b;
    if (t <= 66) {
        r = 255;
        g = 99.4708025861 * Math.log(t) - 161.1195681661;
        b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447926307;
    } else {
        r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
        g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
        b = 255;
    }
    return [
        Math.max(0, Math.min(1, r / 255)),
        Math.max(0, Math.min(1, g / 255)),
        Math.max(0, Math.min(1, b / 255)),
    ];
}

function temperatureGains(kelvin) {
    const c = kelvinToRgb(kelvin);
    const d = kelvinToRgb(6500);
    return [c[0] / d[0], c[1] / d[1], c[2] / d[2]];
}

function gradingTemp(look) {
    // Ink is saturation 0. A warm white-point after that re-tints
    // midtones (Excalidraw fills, photos) so they look colored again.
    if ((look.saturation ?? 1) <= 0.02)
        return [1, 1, 1];
    return temperatureGains(look.temperature ?? 6500);
}

function lookKey(look) {
    return `${look.mode}|${look.saturation}|${look.contrast}|${look.black}|${look.white}|${look.temperature}|${look.levels ?? 1}|${look.grain ?? 0}`;
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function paperGate(to) {
    if (to.mode === 'color-paper') {
        // Soft warm soak — keep chroma so the wallpaper does not flash grey.
        return {
            ...to,
            saturation: Math.max(0.72, (to.saturation ?? 1) * 0.85),
            contrast: 0.94,
            black: 0.03,
            white: 0.98,
            temperature: Math.min(to.temperature ?? 5600, 5400),
            levels: 1,
            grain: 0,
        };
    }
    return {
        ...IDENTITY,
        saturation: 0.18,
        contrast: 0.90,
        black: 0.045,
        white: 0.96,
        levels: 1,
        grain: 0,
    };
}

function lerpLook(from, to, t) {
    return {
        mode: t >= 1 ? to.mode : from.mode,
        saturation: lerp(from.saturation, to.saturation, t),
        contrast: lerp(from.contrast, to.contrast, t),
        black: lerp(from.black, to.black, t),
        white: lerp(from.white, to.white, t),
        temperature: lerp(from.temperature, to.temperature, t),
        levels: lerp(from.levels ?? 1, to.levels ?? 1, t),
        grain: lerp(from.grain ?? 0, to.grain ?? 0, t),
    };
}

function smootherstep(t) {
    const x = Math.min(1, Math.max(0, t));
    return x * x * x * (x * (x * 6 - 15) + 10);
}

function veilRgb(mode) {
    return VEIL[mode] ?? VEIL.regular;
}

function stageSize() {
    const stage = global.stage;
    return [Math.max(1, stage.width), Math.max(1, stage.height)];
}

const PaperEffect = GObject.registerClass(
class PaperEffect extends Shell.GLSLEffect {
    constructor(params) {
        super(params);
        this._satA = this.get_uniform_location('sat_a');
        this._satB = this.get_uniform_location('sat_b');
        this._contrastA = this.get_uniform_location('contrast_a');
        this._contrastB = this.get_uniform_location('contrast_b');
        this._blackA = this.get_uniform_location('black_a');
        this._blackB = this.get_uniform_location('black_b');
        this._whiteA = this.get_uniform_location('white_a');
        this._whiteB = this.get_uniform_location('white_b');
        this._tempA = this.get_uniform_location('temp_a');
        this._tempB = this.get_uniform_location('temp_b');
        this._mixLoc = this.get_uniform_location('mix_t');
        this._washLoc = this.get_uniform_location('wash');
        this._veilLoc = this.get_uniform_location('veil');
        this._veilRgbLoc = this.get_uniform_location('veil_rgb');
        this._resLoc = this.get_uniform_location('resolution');
        this._levelsA = this.get_uniform_location('levels_a');
        this._levelsB = this.get_uniform_location('levels_b');
        this._grainA = this.get_uniform_location('grain_a');
        this._grainB = this.get_uniform_location('grain_b');
        this._wipeLoc = this.get_uniform_location('wipe');
        this._washStyleLoc = this.get_uniform_location('wash_style');
        this._key = '';
    }

    vfunc_build_pipeline() {
        const hook = Cogl.SnippetHook
            ? Cogl.SnippetHook.FRAGMENT
            : Shell.SnippetHook.FRAGMENT;
        this.add_glsl_snippet(hook, SHADER_DECL, SHADER_CODE, false);
    }

    applyLooks(from, to, mixT, extras) {
        this._key = '';
        this.set_uniform_float(this._satA, 1, [from.saturation]);
        this.set_uniform_float(this._satB, 1, [to.saturation]);
        this.set_uniform_float(this._contrastA, 1, [from.contrast]);
        this.set_uniform_float(this._contrastB, 1, [to.contrast]);
        this.set_uniform_float(this._blackA, 1, [from.black]);
        this.set_uniform_float(this._blackB, 1, [to.black]);
        this.set_uniform_float(this._whiteA, 1, [from.white]);
        this.set_uniform_float(this._whiteB, 1, [to.white]);
        this.set_uniform_float(this._tempA, 3, gradingTemp(from));
        this.set_uniform_float(this._tempB, 3, gradingTemp(to));
        this.set_uniform_float(this._mixLoc, 1, [mixT]);
        this.set_uniform_float(this._washLoc, 1, [extras.wash]);
        this.set_uniform_float(this._veilLoc, 1, [extras.veil]);
        this.set_uniform_float(this._veilRgbLoc, 3, extras.veilRgb);
        this.set_uniform_float(this._resLoc, 2, extras.resolution);
        this.set_uniform_float(this._levelsA, 1, [from.levels ?? 1]);
        this.set_uniform_float(this._levelsB, 1, [to.levels ?? 1]);
        this.set_uniform_float(this._grainA, 1, [from.grain ?? 0]);
        this.set_uniform_float(this._grainB, 1, [to.grain ?? 0]);
        this.set_uniform_float(this._wipeLoc, 1, [extras.wipe ?? 0]);
        this.set_uniform_float(this._washStyleLoc, 1, [extras.washStyle ?? 0]);
        this.queue_repaint();
    }

    applyLook(look) {
        const key = lookKey(look);
        if (key === this._key)
            return;
        this.applyLooks(look, look, 1, {
            wash: 1,
            veil: 0,
            veilRgb: veilRgb(look.mode),
            resolution: stageSize(),
            wipe: 0,
            washStyle: 0,
        });
        this._key = key;
    }
});

export default class PaperModesExtension extends Extension {
    enable() {
        this._mode = 'regular';
        this._lastKey = '';
        this._visualLook = null;
        this._effect = null;
        this._fallback = null;
        this._unredirect = false;
        this._dbus = null;
        this._ownerId = 0;
        this._monitor = null;
        this._debounceId = 0;
        this._monitorsId = 0;
        this._indicator = null;
        this._timeline = null;
        this._themeId = 0;
        this._themeDone = true;
        this._fromLook = null;
        this._toLook = null;
        this._windowEffects = new Map();
        this._windowsHooked = false;

        const stateDir = GLib.build_filenamev([GLib.get_user_state_dir(), 'paper-modes']);
        this._activePath = GLib.build_filenamev([stateDir, 'active.json']);

        this._watchState();
        this._monitorsId = Main.layoutManager.connect(
            'monitors-changed', () => this._onMonitorsChanged());
        this._exportDbus();
        this._writeCaps();
        this._indicator = new PaperIndicator(this);
        this._applyFromDisk();
    }

    disable() {
        this._clearDebounce();
        this._stopTransition(false);
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._unexportDbus();
        this._unwatchState();
        this._dropPipeline();
        this._clearWindowInk();
        this._unhookWindows();
        this._setPaperChrome(false);
        this._setUnredirect(false);
        this._clearCaps();
        this._visualLook = null;
    }

    Reload() {
        this._lastKey = '';
        this._applyFromDisk();
    }

    SetMode(mode) {
        this.switchMode(mode);
    }

    get Mode() {
        return this._mode;
    }

    switchMode(mode) {
        const look = this._lookFor(mode);
        this._writeLook(look);
        this._lastKey = '';
        this._applyFromDisk();
    }

    _runThemeTool(mode) {
        const tool = GLib.build_filenamev([
            this._rootDir(), 'themes', 'color-paper', 'apply.py']);
        let argv;
        if (mode === 'color-paper')
            argv = ['python3', tool, 'apply'];
        else if (mode === 'ink')
            argv = ['python3', tool, 'restore', '--keep-save'];
        else
            argv = ['python3', tool, 'restore'];
        try {
            Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        } catch (e) {
            console.warn(`[paper-modes] theme tool failed: ${e}`);
        }
    }

    _hasConfig(dir) {
        if (!dir)
            return false;
        return Gio.File.new_for_path(
            GLib.build_filenamev([dir, 'config'])).query_exists(null);
    }

    _rootFromState() {
        try {
            const file = Gio.File.new_for_path(
                GLib.build_filenamev([GLib.get_user_state_dir(), 'paper-modes', 'root']));
            const [, bytes] = file.load_contents(null);
            return new TextDecoder().decode(bytes).trim();
        } catch (e) {
            return '';
        }
    }

    _rootFromExtension() {
        const ext = Gio.File.new_for_path(this.path);
        try {
            const info = ext.query_info(
                'standard::is-symlink,standard::symlink-target',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            if (info.get_is_symlink()) {
                const target = info.get_symlink_target();
                const resolved = target.startsWith('/')
                    ? Gio.File.new_for_path(target)
                    : ext.get_parent().resolve_relative_path(target);
                return resolved.get_parent().get_path();
            }
        } catch (e) {
            // fall through
        }
        return ext.get_parent().get_path();
    }

    _rootDir() {
        const fromExt = this._rootFromExtension();
        if (this._hasConfig(fromExt))
            return fromExt;

        const fromState = this._rootFromState();
        if (this._hasConfig(fromState))
            return fromState;

        const homeRoot = GLib.build_filenamev([GLib.get_home_dir(), 'paper-modes']);
        if (this._hasConfig(homeRoot))
            return homeRoot;

        return fromExt || homeRoot;
    }

    _parseConfig() {
        const file = Gio.File.new_for_path(
            GLib.build_filenamev([this._rootDir(), 'config']));
        const out = {};
        try {
            const [, bytes] = file.load_contents(null);
            for (const line of new TextDecoder().decode(bytes).split('\n')) {
                const m = line.match(/^([A-Z_]+)=([^\s#]+)/);
                if (m)
                    out[m[1]] = m[2];
            }
        } catch (e) {
            console.warn(`[paper-modes] could not read config: ${e}`);
        }
        return out;
    }

    _num(cfg, key, fallback) {
        const n = Number(cfg[key]);
        return Number.isFinite(n) ? n : fallback;
    }

    _lookFor(mode) {
        const cfg = this._parseConfig();
        if (mode === 'ink') {
            return {
                mode: 'ink',
                saturation: this._num(cfg, 'INK_SATURATION', 0),
                contrast: this._num(cfg, 'INK_CONTRAST', 0.92),
                black: this._num(cfg, 'INK_BLACK', 0.04),
                white: this._num(cfg, 'INK_WHITE', 0.96),
                temperature: this._num(cfg, 'INK_TEMPERATURE', 6500),
                levels: this._num(cfg, 'INK_LEVELS', 18),
                grain: this._num(cfg, 'INK_GRAIN', 0.03),
            };
        }
        if (mode === 'color-paper' || mode === 'color') {
            return {
                mode: 'color-paper',
                saturation: this._num(cfg, 'COLOR_SATURATION', 0.84),
                contrast: this._num(cfg, 'COLOR_CONTRAST', 0.96),
                black: this._num(cfg, 'COLOR_BLACK', 0.015),
                white: this._num(cfg, 'COLOR_WHITE', 0.99),
                temperature: this._num(cfg, 'COLOR_TEMPERATURE', 5600),
                levels: 1,
                grain: 0,
            };
        }
        return {...IDENTITY};
    }

    _writeLook(look) {
        const dir = Gio.File.new_for_path(GLib.path_get_dirname(this._activePath));
        try {
            dir.make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                throw e;
        }
        const json = `${JSON.stringify(look, null, 2)}\n`;
        this._stateFile().replace_contents(
            new TextEncoder().encode(json),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        if (look.mode !== 'regular') {
            Gio.File.new_for_path(
                GLib.build_filenamev([GLib.get_user_state_dir(), 'paper-modes', 'last-paper'])
            ).replace_contents(
                new TextEncoder().encode(`${look.mode}\n`),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        }
    }

    _colorSettings() {
        return new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.color'});
    }

    _savedSessionFile() {
        return Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_state_dir(), 'paper-modes', 'saved-session']));
    }

    _captureNightLight() {
        const settings = this._colorSettings();
        const saved = this._savedSessionFile();
        const flag = settings.get_boolean('night-light-enabled') ? 'true' : 'false';
        saved.replace_contents(
            new TextEncoder().encode(`NIGHT_LIGHT_ENABLED=${flag}\n`),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }

    _snapDisplayTemperature(kelvin) {
        const settings = this._colorSettings();
        const saved = settings.get_uint('night-light-temperature');
        try {
            Gio.DBus.session.call_sync(
                'org.gnome.SettingsDaemon.Color',
                '/org/gnome/SettingsDaemon/Color',
                'org.freedesktop.DBus.Properties',
                'Set',
                new GLib.Variant('(ssv)', [
                    'org.gnome.SettingsDaemon.Color',
                    'Temperature',
                    new GLib.Variant('u', kelvin),
                ]),
                null,
                Gio.DBusCallFlags.NONE,
                150,
                null
            );
        } catch (e) {
            // gsd may not be running
        }
        if (saved && saved !== kelvin)
            settings.set_uint('night-light-temperature', saved);
    }

    _syncNightLight(mode) {
        const settings = this._colorSettings();
        if (mode !== 'regular') {
            this._snapDisplayTemperature(6500);
            settings.set_boolean('night-light-enabled', false);
            return;
        }

        let enabled = true;
        try {
            const [, bytes] = this._savedSessionFile().load_contents(null);
            const m = new TextDecoder().decode(bytes).match(/NIGHT_LIGHT_ENABLED=(true|false)/);
            if (m)
                enabled = m[1] === 'true';
        } catch (e) {
            // keep default
        }
        settings.set_boolean('night-light-enabled', enabled);
    }

    _target() {
        return Main.layoutManager.uiGroup;
    }

    _prefersDark() {
        try {
            const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            return iface.get_string('color-scheme') === 'prefer-dark';
        } catch (e) {
            return false;
        }
    }

    _setPaperChrome(on) {
        const cls = 'paper-color';
        const darkCls = 'paper-color-dark';
        const dark = on && this._prefersDark();
        const actors = [Main.layoutManager.uiGroup, Main.panel];
        for (const actor of actors) {
            if (!actor)
                continue;
            if (on)
                actor.add_style_class_name(cls);
            else
                actor.remove_style_class_name(cls);
            if (dark)
                actor.add_style_class_name(darkCls);
            else
                actor.remove_style_class_name(darkCls);
        }
    }

    _capsFile() {
        return Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_state_dir(), 'paper-modes', 'helper-caps']));
    }

    _writeCaps() {
        try {
            this._capsFile().replace_contents(
                new TextEncoder().encode('transition\n'),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.warn(`[paper-modes] could not write helper caps: ${e}`);
        }
    }

    _clearCaps() {
        try {
            this._capsFile().delete(null);
        } catch (e) {
            // missing is fine
        }
    }

    _stateFile() {
        return Gio.File.new_for_path(this._activePath);
    }

    _watchState() {
        const file = this._stateFile();
        const parent = file.get_parent();
        try {
            parent.make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                console.warn(`[paper-modes] could not create state dir: ${e}`);
        }

        try {
            this._monitor = parent.monitor_directory(
                Gio.FileMonitorFlags.WATCH_MOVES, null);
        } catch (e) {
            this._monitor = parent.monitor_directory(
                Gio.FileMonitorFlags.NONE, null);
        }
        this._monitor.connect('changed', (_m, changedFile) => {
            const path = changedFile?.get_path();
            if (!path || !path.endsWith('active.json'))
                return;
            this._debounceReload();
        });
    }

    _unwatchState() {
        this._monitor?.cancel();
        this._monitor = null;
    }

    _debounceReload() {
        this._clearDebounce();
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
            this._debounceId = 0;
            this._applyFromDisk();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearDebounce() {
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = 0;
        }
    }

    _onMonitorsChanged() {
        if (this._timeline)
            this._tickTransition(this._timeline.get_progress());
        else if (this._mode !== 'regular') {
            this._lastKey = '';
            this._applyFromDisk();
        }
    }

    _readLook() {
        try {
            const [ok, bytes] = this._stateFile().load_contents(null);
            if (!ok)
                return {...IDENTITY};
            const data = JSON.parse(new TextDecoder().decode(bytes));
            return {
                mode: data.mode || 'regular',
                saturation: Number(data.saturation ?? 1),
                contrast: Number(data.contrast ?? 1),
                black: Number(data.black ?? 0),
                white: Number(data.white ?? 1),
                temperature: Number(data.temperature ?? 6500),
                levels: Number(data.levels ?? (data.mode === 'ink' ? 18 : 1)),
                grain: Number(data.grain ?? (data.mode === 'ink' ? 0.03 : 0)),
            };
        } catch (e) {
            return {...IDENTITY};
        }
    }

    _applyFromDisk() {
        const look = this._readLook();
        const key = lookKey(look);
        if (key === this._lastKey)
            return;

        const from = this._visualLook;
        if (from && lookKey(from) === key) {
            this._mode = look.mode;
            this._lastKey = key;
            this._commitLook(look, false);
            return;
        }

        if (from?.mode === 'regular' && look.mode !== 'regular')
            this._captureNightLight();

        this._mode = look.mode;
        this._lastKey = key;
        this._indicator?.setMode(this._mode);
        this._dbus?.emit_property_changed('Mode', new GLib.Variant('s', this._mode));
        this._dbus?.flush();

        if (!from) {
            this._commitLook(look, false);
            return;
        }

        let duration = this._transitionMs();
        if (duration <= 8) {
            this._themeDone = false;
            this._commitLook(look, true);
            return;
        }
        if (look.mode === 'color-paper' || from.mode === 'color-paper')
            duration = Math.round(duration * 1.22);

        this._startTransition(from, look, duration);
    }

    _transitionMs() {
        const cfg = this._parseConfig();
        let ms = this._num(cfg, 'TRANSITION_MS', 1100);
        try {
            const st = St.Settings.get();
            if (st.enable_animations === false)
                return 1;
            if (st.slow_down_factor > 0)
                ms *= st.slow_down_factor;
        } catch (e) {
            // keep configured duration
        }
        return Math.max(1, Math.round(ms));
    }

    _startTransition(from, to, duration) {
        this._stopTransition(false);
        this._fromLook = from;
        this._toLook = to;
        this._themeDone = false;

        this._setUnredirect(true);
        this._attachPipeline();
        this._applyMidChrome(to);
        this._tickTransition(0);

        const actor = this._target();
        try {
            this._timeline = new Clutter.Timeline({
                duration,
                actor,
            });
        } catch (e) {
            console.warn(`[paper-modes] timeline unavailable: ${e}`);
            this._commitLook(to, true);
            return;
        }
        this._timeline.connect('new-frame', () => {
            if (this._timeline)
                this._tickTransition(this._timeline.get_progress());
        });
        this._timeline.connect('completed', () => {
            this._timeline = null;
            this._commitLook(to, true);
        });

        this._timeline.start();
    }

    _tickTransition(progress) {
        const from = this._fromLook;
        const to = this._toLook;
        if (!from || !to)
            return;

        const plan = this._washPlan(from, to, progress);
        this._visualLook = lerpLook(from, to, smootherstep(progress));
        this._paintBlend(plan.gradeA, plan.gradeB, plan.mixT, {
            wash: plan.wash,
            veil: plan.veil,
            veilRgb: plan.veilRgb,
            resolution: stageSize(),
            wipe: plan.wipe,
            washStyle: plan.washStyle,
        });
    }

    _washPlan(from, to, progress) {
        const p = Math.min(1, Math.max(0, progress));
        const destVeil = veilRgb(to.mode);

        // Keep the original ink sheet. That motion already reads.
        if (to.mode === 'ink') {
            const t = smootherstep(p);
            return {
                gradeA: from,
                gradeB: to,
                mixT: t,
                wash: t,
                wipe: 0.22,
                washStyle: 0,
                veil: Math.sin(p * Math.PI) * 0.08,
                veilRgb: destVeil,
            };
        }

        // Color-paper is a close grade, so a global lerp disappears.
        // Soak like ink first, then bloom pigment from the center.
        if (to.mode === 'color-paper' || from.mode === 'color-paper') {
            const gate = paperGate(to);
            const split = 0.42;
            if (p < split) {
                const local = smootherstep(p / split);
                return {
                    gradeA: from,
                    gradeB: gate,
                    mixT: local,
                    wash: local,
                    wipe: 1,
                    washStyle: 0,
                    veil: Math.sin(local * Math.PI) * 0.22,
                    veilRgb: destVeil,
                };
            }
            const local = smootherstep((p - split) / (1 - split));
            return {
                gradeA: gate,
                gradeB: to,
                mixT: local,
                wash: local,
                wipe: 1,
                washStyle: 1,
                veil: Math.sin(local * Math.PI) * 0.16,
                veilRgb: destVeil,
            };
        }

        // Leaving ink for regular: color climbs back up the page.
        const t = smootherstep(p);
        return {
            gradeA: from,
            gradeB: to,
            mixT: t,
            wash: t,
            wipe: 1,
            washStyle: 2,
            veil: Math.sin(p * Math.PI) * 0.14,
            veilRgb: destVeil,
        };
    }

    _stopTransition(commit = true) {
        if (this._themeId) {
            GLib.source_remove(this._themeId);
            this._themeId = 0;
        }
        if (this._timeline) {
            const timeline = this._timeline;
            this._timeline = null;
            try {
                timeline.stop();
            } catch (e) {
                // already finished
            }
        }
        if (commit && this._toLook && !this._themeDone)
            this._applyMidChrome(this._toLook);
    }

    _applyMidChrome(look) {
        if (this._themeDone)
            return;
        this._themeDone = true;
        this._setPaperChrome(look.mode === 'color-paper');
        this._runThemeTool(look.mode);
        this._syncNightLight(look.mode);
        this._syncWindowInk(false);
    }

    _commitLook(look, applyTheme) {
        this._stopTransition(false);
        this._fromLook = null;
        this._toLook = null;
        this._visualLook = {...look};
        if (applyTheme)
            this._applyMidChrome(look);
        else
            this._setPaperChrome(look.mode === 'color-paper');

        if (look.mode === 'regular') {
            this._syncWindowInk(false);
            this._detachPipeline();
            this._setUnredirect(false);
            return;
        }

        this._setUnredirect(true);
        this._attachPipeline();
        this._paintLook(look);
        this._syncWindowInk(false);
    }

    _hookWindows() {
        if (this._windowsHooked)
            return;
        this._windowsHooked = true;
        this._windowAddedId = global.window_group.connect(
            'actor-added', () => this._syncWindowInk(this._mode === 'ink'));
        this._windowRemovedId = global.window_group.connect(
            'actor-removed', (_g, actor) => this._dropWindowEffect(actor));
        try {
            this._windowCreatedId = global.display.connect(
                'window-created', () => this._syncWindowInk(this._mode === 'ink'));
        } catch (e) {
            this._windowCreatedId = 0;
        }
    }

    _unhookWindows() {
        if (this._windowAddedId) {
            global.window_group.disconnect(this._windowAddedId);
            this._windowAddedId = 0;
        }
        if (this._windowRemovedId) {
            global.window_group.disconnect(this._windowRemovedId);
            this._windowRemovedId = 0;
        }
        if (this._windowCreatedId) {
            global.display.disconnect(this._windowCreatedId);
            this._windowCreatedId = 0;
        }
        this._windowsHooked = false;
    }

    _syncWindowInk(on) {
        if (on)
            this._hookWindows();

        const wanted = new Set();
        if (on) {
            for (const actor of global.get_window_actors())
                wanted.add(actor);
        }

        for (const actor of this._windowEffects.keys()) {
            if (!wanted.has(actor))
                this._dropWindowEffect(actor);
        }
        for (const actor of wanted) {
            if (this._windowEffects.has(actor))
                continue;
            try {
                const effect = new Clutter.DesaturateEffect({factor: 1.0});
                actor.add_effect_with_name('paper-ink', effect);
                this._windowEffects.set(actor, effect);
            } catch (e) {
                console.warn(`[paper-modes] window ink failed: ${e}`);
            }
        }
    }

    _dropWindowEffect(actor) {
        const effect = this._windowEffects.get(actor);
        this._windowEffects.delete(actor);
        if (!effect)
            return;
        try {
            if (effect.actor)
                effect.actor.remove_effect(effect);
        } catch (e) {
            // actor already gone
        }
    }

    _clearWindowInk() {
        for (const actor of [...this._windowEffects.keys()])
            this._dropWindowEffect(actor);
    }

    _attachPipeline() {
        const group = this._target();
        if (!group)
            return;

        if (!this._effect && !this._fallback) {
            try {
                this._effect = new PaperEffect();
            } catch (e) {
                console.warn(`[paper-modes] GLSL unavailable, desaturate-only fallback: ${e}`);
                this._effect = null;
                this._fallback = new Clutter.DesaturateEffect();
            }
        }

        const effect = this._effect || this._fallback;
        if (!effect)
            return;
        if (effect.actor === group)
            return;
        if (effect.actor)
            effect.actor.remove_effect(effect);
        group.add_effect(effect);
    }

    _paintBlend(from, to, mixT, extras) {
        if (this._effect) {
            this._effect.applyLooks(from, to, mixT, extras);
            return;
        }
        if (this._fallback)
            this._fallback.set_factor(1.0 - lerp(from.saturation, to.saturation, mixT));
    }

    _paintLook(look) {
        if (this._effect) {
            this._effect.applyLook(look);
            return;
        }
        if (this._fallback)
            this._fallback.set_factor(1.0 - look.saturation);
    }

    _detachPipeline() {
        for (const effect of [this._effect, this._fallback]) {
            if (effect?.actor)
                effect.actor.remove_effect(effect);
        }
        if (this._effect)
            this._effect._key = '';
    }

    _dropPipeline() {
        this._detachPipeline();
        this._effect = null;
        this._fallback = null;
        this._lastKey = '';
    }

    _setUnredirect(disable) {
        if (disable === this._unredirect)
            return;
        const compositor = global.compositor;
        if (!compositor?.disable_unredirect || !compositor?.enable_unredirect)
            return;
        try {
            if (disable)
                compositor.disable_unredirect();
            else
                compositor.enable_unredirect();
            this._unredirect = disable;
        } catch (e) {
            console.warn(`[paper-modes] unredirect toggle failed: ${e}`);
        }
    }

    _exportDbus() {
        this._dbus = Gio.DBusExportedObject.wrapJSObject(DBUS_XML, this);
        this._dbus.export(Gio.DBus.session, BUS_PATH);
        this._ownerId = Gio.bus_own_name(
            Gio.BusType.SESSION,
            BUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            null,
            null,
            null
        );
    }

    _unexportDbus() {
        try {
            this._dbus?.unexport();
        } catch (e) {
            // already gone
        }
        this._dbus = null;
        if (this._ownerId) {
            Gio.bus_unown_name(this._ownerId);
            this._ownerId = 0;
        }
    }
}
