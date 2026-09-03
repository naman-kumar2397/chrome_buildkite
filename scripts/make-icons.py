#!/usr/bin/env python3
"""Generate icons/icon{16,48,128}.png with only the Python standard library.

Draws a green rounded square with a white bell. Rendered at 512px with
per-pixel geometry, then box-downsampled to the target sizes for smooth edges.
"""
import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "icons"
SRC = 768  # divisible by 128, 48 and 16
GREEN = (20, 204, 128)
WHITE = (255, 255, 255)


def rounded_square(x, y, size, radius):
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    return math.hypot(x - cx, y - cy) <= radius


def bell(x, y, size):
    """Bell silhouette in a unit-ish coordinate space centred on the icon."""
    u = (x - size / 2) / size  # -0.5 .. 0.5
    v = (y - size / 2) / size
    # dome: circle centred slightly above middle
    if math.hypot(u, v + 0.08) <= 0.19 and v + 0.08 <= 0:
        return True
    # body: flares out from dome to a lip
    if -0.08 <= v <= 0.15:
        t = (v + 0.08) / 0.23
        half = 0.19 + 0.10 * t * t
        if abs(u) <= half:
            return True
    # lip
    if 0.15 < v <= 0.19 and abs(u) <= 0.31:
        return True
    # clapper
    if math.hypot(u, v - 0.245) <= 0.055:
        return True
    # knob on top
    if math.hypot(u, v + 0.28) <= 0.04:
        return True
    return False


def render(size):
    px = []
    radius = size * 0.22
    for y in range(size):
        row = []
        for x in range(size):
            cx, cy = x + 0.5, y + 0.5
            if not rounded_square(cx, cy, size, radius):
                row.append((0, 0, 0, 0))
            elif bell(cx, cy, size):
                row.append(WHITE + (255,))
            else:
                row.append(GREEN + (255,))
        px.append(row)
    return px


def downsample(px, factor):
    src = len(px)
    dst = src // factor
    out = []
    for y in range(dst):
        row = []
        for x in range(dst):
            r = g = b = a = 0
            for dy in range(factor):
                for dx in range(factor):
                    pr, pg, pb, pa = px[y * factor + dy][x * factor + dx]
                    r += pr * pa
                    g += pg * pa
                    b += pb * pa
                    a += pa
            n = factor * factor
            if a == 0:
                row.append((0, 0, 0, 0))
            else:
                row.append((r // a, g // a, b // a, a // n))
        out.append(row)
    return out


def write_png(path, px):
    size = len(px)
    raw = bytearray()
    for row in px:
        raw.append(0)  # filter: none
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    path.write_bytes(png)


def main():
    OUT.mkdir(exist_ok=True)
    big = render(SRC)
    for target in (128, 48, 16):
        img = downsample(big, SRC // target)
        write_png(OUT / f"icon{target}.png", img)
        print(f"wrote icons/icon{target}.png")


if __name__ == "__main__":
    main()
