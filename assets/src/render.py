"""Render the README banner, GitHub social preview and OG card from the HTML sources in this folder.
Usage (Python with playwright installed): python assets/src/render.py"""
from pathlib import Path
from playwright.sync_api import sync_playwright
SRC = Path(__file__).resolve().parent
ROOT = SRC.parents[1]
JOBS = [('banner.html', 'assets/banner.png', 1280, 420, 2),
        ('social.html', 'assets/social-preview.png', 1280, 640, 1),
        ('og.html', 'public/brand/og.png', 1200, 630, 1)]
with sync_playwright() as p:
    browser = p.chromium.launch()
    for src, out, w, h, scale in JOBS:
        page = browser.new_page(viewport={'width': w, 'height': h}, device_scale_factor=scale)
        page.goto((SRC / src).as_uri())
        page.evaluate('document.fonts.ready')
        page.screenshot(path=str(ROOT / out), clip={'x': 0, 'y': 0, 'width': w, 'height': h})
        print(out, w * scale, 'x', h * scale)
        page.close()
    browser.close()
