"""Rasterize images/icon.svg to images/icon.png, the Marketplace tile.

    uv run --with resvg-py scripts/make-icon.py     # or: npm run icon

The SVG is the source and the only file to edit; this exists because the manifest
cannot point at it. vsce rejects an SVG icon outright ("SVGs can't be used as
icons"), and the Marketplace refuses one in the README too unless it is served
from a host on its trust list. So the PNG is a build product that is nonetheless
committed: CI packages the extension, and a VSIX with no tile is a broken listing.

resvg rather than a drawing library, because the geometry now lives in the SVG
where it is reviewable in a diff. It is a Rust binding shipped as a wheel, so it
needs no cairo, no ImageMagick and no headless browser on the machine.

Rendered straight at 128 with no supersampling: resvg antialiases analytically
from the path, which is what the old Pillow version had to fake by drawing at 4x
and downsampling, since its polygon fill has no antialiasing of its own.
"""

import sys
from pathlib import Path

import resvg_py

# 128x128 is what the Marketplace asks for, and the tile is shown at 42px in
# search results, a third of that. Nothing here is legible at 42px by design.
SIZE = 128

images = Path(__file__).resolve().parent.parent / "images"
source, target = images / "icon.svg", images / "icon.png"

png = bytes(resvg_py.svg_to_bytes(svg_path=str(source), width=SIZE, height=SIZE))
if target.exists() and target.read_bytes() == png:
    print(f"{target.name} is already what {source.name} renders to")
    sys.exit(0)

target.write_bytes(png)
print(f"{target.name} written at {SIZE}x{SIZE}, {len(png)} bytes")
