#!/usr/bin/env python3
"""Render the Color Paper wallpaper (3840x2160 stationery field)."""

from __future__ import annotations

import math
import random
from pathlib import Path

import cairo
from PIL import Image, ImageEnhance, ImageFilter

W, H = 3840, 2160
OUT = Path(__file__).resolve().parent / "wallpaper.png"


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
    cr.set_line_width(4.0)
    cr.stroke()
    cr.restore()


def render() -> Image.Image:
    surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, W, H)
    cr = cairo.Context(surface)
    cr.set_antialias(cairo.ANTIALIAS_BEST)

    # Laid linen — visibly warm, not printer-white.
    cr.set_source_rgb(*rgb("#E4D5C2"))
    cr.paint()

    # Broad pigment fields so the desk is colored even after the paper wash.
    blob(cr, 3000, 420, 1700, 1300, "#9EB6C2", 0.72)
    blob(cr, 640, 1680, 1600, 1100, "#B7C8A4", 0.70)
    blob(cr, 1980, 1180, 1100, 800, "#E2C4B6", 0.42)
    blob(cr, 1680, 200, 900, 700, "#E6D39A", 0.48)

    # Overlapping construction-paper sheets.
    sheet(cr, 1180, 980, 2500, 1760, -0.16, "#F2E6D2", 0.78, "#C9B79A", 0.55)
    sheet(cr, 2860, 760, 2280, 1680, 0.14, "#C5D6DF", 0.88, "#8FA8B4", 0.70)
    sheet(cr, 720, 1520, 2100, 1320, 0.10, "#C9D6B6", 0.86, "#8FA57A", 0.65)
    sheet(cr, 2480, 1680, 1900, 1180, -0.11, "#EBD7A8", 0.80, "#C4A96A", 0.60)
    sheet(cr, 1760, 620, 1320, 860, -0.05, "#E8C9C4", 0.62, "#C49A94", 0.50)

    # Index cards on top, actually opaque this time.
    sheet(cr, 2920, 1500, 1080, 700, -0.20, "#F7F0E4", 0.92, "#B7C5CC", 0.80, 48)
    sheet(cr, 3080, 1600, 1000, 640, 0.13, "#EEF3F5", 0.90, "#8FA8B4", 0.75, 48)
    sheet(cr, 2960, 1660, 940, 600, -0.03, "#FBF7F0", 0.94, "#C9B79A", 0.70, 48)

    # Letterpress arcs, thick enough to read from the desk.
    cr.save()
    cr.set_line_cap(cairo.LINE_CAP_ROUND)
    cr.set_source_rgba(*rgb("#6F8B97"), 0.32)
    for i, radius in enumerate((720, 1040, 1380, 1760, 2160)):
        cr.set_line_width(5.0 if i % 2 == 0 else 2.8)
        cr.arc(80, H + 80, radius, math.pi * 1.02, math.pi * 1.58)
        cr.stroke()
    cr.set_source_rgba(*rgb("#B08948"), 0.22)
    for radius in (640, 1120, 1680):
        cr.set_line_width(3.2)
        cr.arc(W - 40, 80, radius, math.pi * 0.52, math.pi * 1.12)
        cr.stroke()
    cr.restore()

    # Dot grid on the paper, stronger on the linen.
    cr.set_source_rgba(*rgb("#7E6A50"), 0.18)
    step = 56
    for x in range(step, W, step):
        for y in range(step, H, step):
            cr.arc(x, y, 1.8, 0, math.pi * 2)
            cr.fill()

    buf = bytes(surface.get_data())
    img = Image.frombuffer("RGBA", (W, H), buf, "raw", "BGRA", 0, 1).convert("RGB")

    rng = random.Random(14)
    grain = Image.new("L", (W, H))
    grain.putdata([rng.randint(0, 255) for _ in range(W * H)])
    grain = grain.filter(ImageFilter.GaussianBlur(radius=0.55))
    grain_rgb = Image.merge("RGB", (grain, grain, grain))
    img = Image.blend(img, grain_rgb, 0.045)
    img = ImageEnhance.Color(img).enhance(1.12)
    img = ImageEnhance.Contrast(img).enhance(1.08)
    return img


def main() -> None:
    img = render()
    indexed = img.quantize(colors=64, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
    indexed.save(OUT, "PNG", optimize=True)
    print(f"Wrote {OUT} ({img.size[0]}x{img.size[1]})")


if __name__ == "__main__":
    main()
