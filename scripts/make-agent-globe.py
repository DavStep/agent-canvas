"""Bake Garden Sim Dashboard's small homeOrb.js globe into a themeable CSS mask."""
from math import asin, cos, floor, pi, sin, sqrt, tau
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 60  # The 30px button at Retina resolution.
FRAMES = 240
GRID = 12  # The dashboard's compact pageBrief globe.
AA = 4


def noise(column, row, tick):
    value = sin(column * 127.1 + row * 311.7 + tick * 74.7) * 43758.5453
    return value - floor(value)


def surface():
    for row in range(GRID):
        y = (row + .5) / GRID * 2 - 1
        lat = asin(y)
        ring = sqrt(1 - y * y)
        count = round(pi * GRID * ring)
        for column in range(count):
            lon = column / count * tau
            wave = sin(lon + sin(lat * 2.6) * 1.3 + lat * .6) + sin(lon * 2 - lat * 1.7) * .3
            value = 1 if wave > 0 else .32 + sin(lon * 3 + lat * 4) * .07
            if abs(wave + sin(lat * 5 + lon * 3) * .06) < .2:
                value = .03
            yield column, row, lon, ring, y, value


def main():
    dots = list(surface())
    atlas = Image.new("L", (SIZE * FRAMES, SIZE * 2))
    radius = SIZE / 2 - 2
    tall = radius * 2 / GRID * .6
    for frame in range(FRAMES):
        angle = .6 + tau * frame / FRAMES
        tile = Image.new("L", (SIZE * AA, SIZE * 2 * AA))
        pen = ImageDraw.Draw(tile)
        for column, row, lon, ring, y, texture in dots:
            facing = cos(lon + angle)
            z = ring * facing
            wide = tall * facing
            if z <= .02 or wide < 1.2:
                continue
            x = ring * sin(lon + angle)
            light = max(0, x * -.42 + y * -.38 + z * .82)
            level = round(min(1, texture * (.18 + light * 1.35) * (.55 + z * .45)) * 8) / 8
            if not level:
                continue
            cx, cy = SIZE / 2 + x * radius, SIZE / 2 + y * radius
            # The lower strip holds sparks, tinted by the agent's current state.
            if noise(column, row, frame // 5) > .985:
                cy += SIZE
                level = 1
            pen.rectangle((round((cx - wide / 2) * AA), round((cy - tall / 2) * AA),
                           round((cx + wide / 2) * AA) - 1, round((cy + tall / 2) * AA) - 1),
                          fill=round(level * 255))
        atlas.paste(tile.resize((SIZE, SIZE * 2), Image.Resampling.BOX), (frame * SIZE, 0))
    mask = Image.new("RGBA", atlas.size, "white")
    mask.putalpha(atlas)
    target = Path(__file__).resolve().parents[1] / "web/src/agent/globe-mask.webp"
    mask.save(target, lossless=True, method=6)


if __name__ == "__main__":
    main()
