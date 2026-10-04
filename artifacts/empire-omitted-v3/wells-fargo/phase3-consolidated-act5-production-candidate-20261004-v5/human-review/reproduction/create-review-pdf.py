import os
import sys
from PIL import Image, ImageDraw, ImageFont

root = sys.argv[1]
def io_path(p):
    p = os.path.abspath(p)
    if os.name == "nt" and not p.startswith("\\\\?\\"):
        return "\\\\?\\" + p
    return p
items = [
    ("ACT5_B009 — approved years 2013–2023", os.path.join(root, "ACT5_B009-compiled-review.png")),
    ("ACT5_B015 — compiled; human visual review pending", os.path.join(root, "ACT5_B015-compiled-review.png")),
]
canvas = Image.new("RGB", (1600, 1180), "#eeeeea")
d = ImageDraw.Draw(canvas)
font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 30)
small = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 19)
d.text((56, 32), "Empire Omitted V3 — consolidated ACT5 graphic review", fill="#171615", font=font)
y = 100
for title, filename in items:
    d.text((60, y), title, fill="#171615", font=small)
    y += 36
    im = Image.open(io_path(filename)).convert("RGB")
    im.thumbnail((1480, 475), Image.Resampling.LANCZOS)
    canvas.paste(im, ((1600-im.width)//2, y))
    y += 500
    d.line(((60, y), (1540, y)), fill="#c8a24a", width=2)
    y += 20
contact = os.path.join(root, "act5-graphic-contact-sheet.v2.png")
canvas.crop((0, 0, 1600, min(y, 1180))).save(io_path(contact), format="PNG", compress_level=9)
pdf = os.path.join(root, "act5-graphic-review.v2.pdf")
first = Image.open(io_path(contact)).convert("RGB")
first.save(io_path(pdf), "PDF", resolution=144.0)
print("contact-sheet-and-pdf-created")
