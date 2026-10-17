"""Draws the home-screen clock icon in app/icons/."""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "app" / "icons"


def icon(size):
    s = size * 4  # draw large, then shrink for smooth edges
    img = Image.new("RGB", (s, s), (31, 78, 121))
    d = ImageDraw.Draw(img)
    c, r = s / 2, s * 0.30
    w = int(s * 0.055)
    d.ellipse([c - r, c - r, c + r, c + r], outline="white", width=w)
    d.line([c, c, c, c - r * 0.62], fill="white", width=w)
    d.line([c, c, c + r * 0.45, c + r * 0.2], fill="white", width=w)
    d.ellipse([c - w, c - w, c + w, c + w], fill="white")
    return img.resize((size, size), Image.LANCZOS)


OUT.mkdir(parents=True, exist_ok=True)
for size in (180, 192, 512):
    icon(size).save(OUT / f"icon-{size}.png")
print("wrote icons to", OUT)
