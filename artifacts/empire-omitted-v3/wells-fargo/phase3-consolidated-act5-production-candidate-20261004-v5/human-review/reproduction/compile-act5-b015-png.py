"""Deterministic Pillow RGB build for ACT5_B015 under its approved spec."""
import hashlib
import json
import os
import sys
from PIL import Image, ImageDraw, ImageFont, __version__ as PILLOW_VERSION

EXPECTED_SPEC = "3acacb5642c058265278d4befbaaa57c3e4d7056076d1cac5faf7c30c230b6e5"
EXPECTED_APPROVAL = "76a7fef0ffc0ebe0f93d763395c1f667d87f78798f0f5c160b770e2a5c18773f"
EXPECTED_TIMING_APPROVAL = "ece9be52468fdd5c73882736c28f4c4acb2bed44c7662a9494ef0aeded29a909"
EXPECTED_FONT = "e8f4e3baf6cc35fed6fcce3a540e8b39e8f6cda1d22a28f2ec8f526fef7a43f5"
W, H = 1920, 1080

def sha(data):
    return hashlib.sha256(data).hexdigest()

def check(path, expected):
    with open(path, "rb") as f:
        data = f.read()
    if sha(data) != expected:
        raise ValueError("INPUT_HASH_MISMATCH:" + path)
    return data

def blend(hex_a, hex_b, t):
    a = tuple(int(hex_a[i:i+2], 16) for i in (1, 3, 5))
    b = tuple(int(hex_b[i:i+2], 16) for i in (1, 3, 5))
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))

def alpha_rect(base, box, color, alpha, radius=0, outline=None, outline_width=1):
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    fill = tuple(int(color[i:i+2], 16) for i in (1, 3, 5)) + (round(255 * alpha),)
    edge = None if not outline else tuple(int(outline[i:i+2], 16) for i in (1, 3, 5)) + (255,)
    if radius:
        d.rounded_rectangle(box, radius=radius, fill=fill, outline=edge, width=outline_width)
    else:
        d.rectangle(box, fill=fill, outline=edge, width=outline_width if edge else 1)
    base.alpha_composite(overlay)

def build(spec_path, approval_path, timing_path, font_path, out_path):
    spec_bytes = check(spec_path, EXPECTED_SPEC)
    check(approval_path, EXPECTED_APPROVAL)
    check(timing_path, EXPECTED_TIMING_APPROVAL)
    if sha(open(font_path, "rb").read()) != EXPECTED_FONT:
        raise ValueError("APPROVED_FONT_HASH_MISMATCH")
    spec = json.loads(spec_bytes)
    if spec["beatId"] != "ACT5_B015" or spec["reviewGraphicProposal"]["dimensions"] != {"width": W, "height": H}:
        raise ValueError("APPROVED_SPEC_SCOPE_MISMATCH")

    # Equivalent to the approved restrained diagonal charcoal gradient.
    pixels = bytearray(W * H * 3)
    start = (32, 35, 40)
    end = (18, 20, 22)
    for y in range(H):
        ty = y / H
        row = y * W * 3
        for x in range(W):
            t = (x / W + ty) / 2
            i = row + x * 3
            pixels[i:i+3] = bytes(round(start[c] + (end[c] - start[c]) * t) for c in range(3))
    base = Image.frombytes("RGB", (W, H), bytes(pixels)).convert("RGBA")

    # Fixed primitive coordinates copied from the approved composition.
    alpha_rect(base, (184, 203, 926, 703), "#090a0b", 0.38)
    alpha_rect(base, (170, 185, 912, 685), "#e4dfd3", 1.0, radius=8, outline="#bcb29f", outline_width=3)
    alpha_rect(base, (170, 185, 912, 201), "#c8a24a", 1.0)
    alpha_rect(base, (222, 244, 732, 259), "#79766f", 0.72, radius=7)
    for box in [(222,284,840,293),(222,315,796,324),(222,346,822,355),(222,405,840,414),(222,436,764,445),(222,467,812,476),(222,526,812,535),(222,557,832,566),(222,588,670,597)]:
        alpha_rect(base, box, "#aaa498", 1.0, radius=4)

    d = ImageDraw.Draw(base)
    d.line((1020, 425, 1135, 425), fill="#c8a24a", width=8)
    for x in (1020, 1135):
        d.ellipse((x-11, 414, x+11, 436), fill="#c8a24a")
    d.polygon([(1190, 334), (1450, 218), (1710, 334)], fill="#c8a24a")
    d.rectangle((1207, 338, 1693, 380), fill="#d7c69d")
    d.rectangle((1230, 380, 1670, 620), fill="#d7c69d")
    for x in (1260, 1360, 1460, 1560):
        d.rectangle((x, 392, x+48, 604), fill="#373a3d")
    d.rectangle((1200, 620, 1700, 650), fill="#c8a24a")
    d.rectangle((1174, 650, 1726, 672), fill="#d7c69d")
    d.rectangle((180, 764, 1740, 768), fill="#c8a24a")

    font = ImageFont.truetype(font_path, 68)
    title = "REGULATORS PUNISHED THE BANK"
    advances = [font.getlength(ch) for ch in title]
    letter_spacing = 1.5
    total = sum(advances) + letter_spacing * (len(title)-1)
    x = (W - total) / 2
    for char, advance in zip(title, advances):
        d.text((round(x), 884), char, font=font, fill="#f4f0e6", anchor="ls")
        x += advance + letter_spacing
    result = base.convert("RGB")
    result.save(out_path, format="PNG", compress_level=9, optimize=False)

    with open(out_path, "rb") as f:
        png = f.read()
    if png[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("PNG_SIGNATURE_INVALID")
    decoded = Image.open(out_path)
    if decoded.size != (W, H):
        raise ValueError("PNG_DIMENSIONS_INVALID")
    return {"path": os.path.basename(out_path), "bytes": len(png), "sha256": sha(png), "width": W, "height": H,
            "format": decoded.format, "pillowVersion": PILLOW_VERSION}

if __name__ == "__main__":
    if len(sys.argv) != 6:
        raise SystemExit("usage: compile-act5-b015-png.py SPEC APPROVAL TIMING_APPROVAL FONT OUTPUT")
    print(json.dumps(build(*sys.argv[1:]), sort_keys=True))
