#!/usr/bin/env python3
"""Render the Color Paper wallpaper (1080p stationery field).

GNOME loads wallpapers through glycin. A 4K indexed PNG was OOMing on this
machine (14GB RAM, swap full) and falling back to solid primary-color white.
Keep the asset at display size as RGB JPEG so mode switches stay reliable.
"""

from __future__ import annotations

import math
import random
from pathlib import Path

import cairo
from PIL import Image, ImageEnhance, ImageFilter

# Match a typical laptop panel. Higher than needed wastes glycin decode RAM.
W, H = 1920, 1080
ROOT = Path(__file__).resolve().parent
OUT_JPG = ROOT / "wallpaper.jpg"
OUT_PNG = ROOT / "wallpaper.png"  # kept as a preview/fallback sibling


def rgb(hex_color: str) -> tuple[float, float, float]:
    h = hex_color.lstrip("#")
    return tuple(int(h[i : i + 2], 16) / 255.0 for i in (0, 2, 4))


def blob(cr: cairo.Context, cx: float, cy: float, rx: float, ry: float, color: str, alpha: float) -> None:
    cr.save()
    cr.translate(cx, cy)
    cr.scale(rx, ry)
    pat = cairo.RadialGradient(0, 0, 0, 0, 0, 1)
    r, g, b = rgb(color)
    pat.add_color_stop_rgba(0.0, r, g, b, alpha)
    pat.add_color_stop_rgba(0.45, r, g, b, alpha * 0.5)
    pat.add_color_stop_rgba(1.0, r, g, b, 0.0)
    cr.set_source(pat)
    cr.rectangle(-1.05, -1.05, 2.1, 2.1)
    cr.fill()
    cr.restore()


def rounded_rect(cr: cairo.Context, x: float, y: float, w: float, h: float, rad: float) -> None:
    cr.move_to(x + rad, y)
    cr.arc(x + w - rad, y + rad, rad, -math.pi / 2, 0)
    cr.arc(x + w - rad, y + h - rad, rad, 0, math.pi / 2)
    cr.arc(x + rad, y + h - rad, rad, math.pi / 2, math.pi)
    cr.arc(x + rad, y + rad, rad, math.pi, 3 * math.pi / 2)
    cr.close_path()


def sheet(
    cr: cairo.Context,
    cx: float,
    cy: float,
    w: float,
    h: float,
    angle: float,
    fill: str,
    fill_a: float,
    stroke: str,
    stroke_a: float,
    radius: float | None = None,
) -> None:
    cr.save()
    cr.translate(cx, cy)
    cr.rotate(angle)
    rad = radius if radius is not None else min(w, h) * 0.045
    rounded_rect(cr, -w / 2, -h / 2, w, h, rad)
    r, g, b = rgb(fill)
    cr.set_source_rgba(r, g, b, fill_a)
    cr.fill_preserve()
    r, g, b = rgb(stroke)
    cr.set_source_rgba(r, g, b, stroke_a)
    cr.set_line_width(2.5)
    cr.stroke()
    cr.restore()


def render() -> Image.Image:
    surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, W, H)
    cr = cairo.Context(surface)
    cr.set_antialias(cairo.ANTIALIAS_BEST)

    # Scale art from the original 4K layout into 1080p.
    sx, sy = W / 3840.0, H / 2160.0
    cr.scale(sx, sy)

    # Laid linen — warm and soft, not printer-white.
    cr.set_source_rgb(*rgb("#E6D8C4"))
    cr.paint()

    # Soft pigment fields — pastel stationery washes.
    blob(cr, 3000, 420, 1700, 1300, "#B4C4CC", 0.55)
    blob(cr, 640, 1680, 1600, 1100, "#C4CEB6", 0.52)
    blob(cr, 1980, 1180, 1100, 800, "#E6D0C6", 0.32)
    blob(cr, 1680, 200, 900, 700, "#E8DDB8", 0.36)

    # Overlapping construction-paper sheets.
    sheet(cr, 1180, 980, 2500, 1760, -0.16, "#F4EADF", 0.78, "#D0C2AE", 0.42)
    sheet(cr, 2860, 760, 2280, 1680, 0.14, "#D0DCE3", 0.78, "#A8BAC4", 0.48)
    sheet(cr, 720, 1520, 2100, 1320, 0.10, "#D4DEC8", 0.76, "#A8B896", 0.45)
    sheet(cr, 2480, 1680, 1900, 1180, -0.11, "#ECDFBF", 0.72, "#D0B888", 0.42)
    sheet(cr, 1760, 620, 1320, 860, -0.05, "#ECD4CE", 0.52, "#D0AEA8", 0.38)

    # Index cards on top.
    sheet(cr, 2920, 1500, 1080, 700, -0.20, "#F8F3EA", 0.92, "#C0CDD4", 0.58, 48)
    sheet(cr, 3080, 1600, 1000, 640, 0.13, "#F2F5F6", 0.90, "#A8BAC4", 0.55, 48)
    sheet(cr, 2960, 1660, 940, 600, -0.03, "#FBF8F2", 0.94, "#D0C2AE", 0.52, 48)

    # Letterpress arcs.
    cr.save()
    cr.set_line_cap(cairo.LINE_CAP_ROUND)
    cr.set_source_rgba(*rgb("#6F8B97"), 0.32)
    for i, radius in enumerate((720, 1040, 1380, 1760, 2160)):
        cr.set_line_width(5.0 if i % 2 == 0 else 2.8)
        cr.arc(80, 2160 + 80, radius, math.pi * 1.02, math.pi * 1.58)
        cr.stroke()
    cr.set_source_rgba(*rgb("#B08948"), 0.22)
    for radius in (640, 1120, 1680):
        cr.set_line_width(3.2)
        cr.arc(3840 - 40, 80, radius, math.pi * 0.52, math.pi * 1.12)
        cr.stroke()
    cr.restore()

    # Dot grid.
    cr.set_source_rgba(*rgb("#7E6A50"), 0.18)
    step = 56
    for x in range(step, 3840, step):
        for y in range(step, 2160, step):
            cr.arc(x, y, 1.8, 0, math.pi * 2)
            cr.fill()

    buf = bytes(surface.get_data())
    img = Image.frombuffer("RGBA", (W, H), buf, "raw", "BGRA", 0, 1).convert("RGB")

    rng = random.Random(14)
    grain = Image.new("L", (W, H))
    grain.putdata([rng.randint(0, 255) for _ in range(W * H)])
    grain = grain.filter(ImageFilter.GaussianBlur(radius=0.4))
    grain_rgb = Image.merge("RGB", (grain, grain, grain))
    img = Image.blend(img, grain_rgb, 0.035)
    img = ImageEnhance.Color(img).enhance(0.82)
    img = ImageEnhance.Contrast(img).enhance(0.98)
    return img


def main() -> None:
    img = render()
    # JPEG RGB: smaller decode cost for glycin than 4K indexed PNG.
    img.save(OUT_JPG, "JPEG", quality=88, optimize=True)
    img.save(OUT_PNG, "PNG", optimize=True)
    print(f"Wrote {OUT_JPG} and {OUT_PNG} ({img.size[0]}x{img.size[1]})")


if __name__ == "__main__":
    main()
