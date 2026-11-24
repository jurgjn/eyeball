"""Draw media/icon.png: an eye whose iris is a small table."""
from pathlib import Path

from PIL import Image, ImageDraw

S = 1024  # draw large, then downsample for anti-aliasing
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# rounded square background
d.rounded_rectangle([40, 40, S - 40, S - 40], radius=200, fill=(30, 58, 95, 255))

# almond-shaped eye: intersection of two large circles
eye = Image.new("L", (S, S), 0)
m1 = Image.new("L", (S, S), 0)
m2 = Image.new("L", (S, S), 0)
r = 560
ImageDraw.Draw(m1).ellipse([S / 2 - r, S / 2 - r + 330, S / 2 + r, S / 2 + r + 330], fill=255)
ImageDraw.Draw(m2).ellipse([S / 2 - r, S / 2 - r - 330, S / 2 + r, S / 2 + r - 330], fill=255)
eye.paste(m1, mask=m2)
img.paste((245, 247, 250, 255), mask=eye)

# iris with a table grid
cx, cy, ri = S / 2, S / 2, 200
iris = Image.new("L", (S, S), 0)
ImageDraw.Draw(iris).ellipse([cx - ri, cy - ri, cx + ri, cy + ri], fill=255)
layer = Image.new("RGBA", (S, S), (46, 160, 140, 255))
ld = ImageDraw.Draw(layer)
# header band and grid lines
ld.rectangle([cx - ri, cy - ri, cx + ri, cy - ri + 120], fill=(24, 110, 98, 255))
for x in range(int(cx - ri), int(cx + ri), 100):
    ld.line([x, 0, x, S], fill=(230, 245, 240, 255), width=14)
for y in range(int(cy - ri + 120), int(cy + ri), 70):
    ld.line([0, y, S, y], fill=(230, 245, 240, 255), width=14)
mask = Image.new("L", (S, S), 0)
mask.paste(iris, mask=eye)
img.paste(layer, mask=mask)
# pupil highlight
d = ImageDraw.Draw(img)
d.ellipse([cx + 70, cy - 150, cx + 140, cy - 80], fill=(255, 255, 255, 230))

out = Path(__file__).with_name("icon.png")
img.resize((256, 256), Image.LANCZOS).save(out)
print("wrote", out)
