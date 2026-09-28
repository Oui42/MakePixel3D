# Program icon: an isometric cube drawn at 16x16 px (no anti-aliasing), scaled up with hard edges.
# Output: assets/makepixel3d.ico (window, shortcut, taskbar), assets/makepixel3d.png and web/favicon.png.
#   .venv\Scripts\python tools\make_icon.py
from pathlib import Path

from PIL import Image, ImageDraw

PROJECT = Path(__file__).resolve().parent.parent
OUTLINE = (27, 16, 38, 255)
TOP, LEFT, RIGHT, SHINE = (190, 166, 255, 255), (122, 76, 255, 255), (72, 38, 168, 255), (240, 234, 255, 255)


def cube(size: int = 16) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c, m = 7.5, size - 1               # centre and last pixel
    top = [(c, 0), (m, 4), (c, 8), (0, 4)]
    left = [(0, 4), (c, 8), (c, m), (0, 11)]
    right = [(c, 8), (m, 4), (m, 11), (c, m)]
    d.polygon(left, fill=LEFT)
    d.polygon(right, fill=RIGHT)
    d.polygon(top, fill=TOP)
    d.line([(3, 4), (7, 2)], fill=SHINE)          # highlight on the top face
    for poly in (top, left, right):
        d.line(poly + [poly[0]], fill=OUTLINE)
    return img


def main():
    base = cube()
    assets = PROJECT / "assets"
    assets.mkdir(exist_ok=True)
    big = base.resize((256, 256), Image.NEAREST)
    big.save(assets / "makepixel3d.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    big.save(assets / "makepixel3d.png")
    base.resize((32, 32), Image.NEAREST).save(PROJECT / "web" / "favicon.png")
    print("assets/makepixel3d.ico, assets/makepixel3d.png, web/favicon.png")


if __name__ == "__main__":
    main()
