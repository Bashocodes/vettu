#!/usr/bin/env python3
"""VETTU words card: white text with a soft shadow on a transparent PNG (Pillow).

Usage: words.py --text "WORDS" --out <png under VETTU_WORK> --width 1920 --size 72
The web server checks that --out lies under its work folder before spawning this script.
"""
import argparse
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"


def load_font(size):
    try:
        return ImageFont.truetype(FONT, size)
    except OSError:
        try:
            return ImageFont.load_default(size)
        except TypeError:
            return ImageFont.load_default()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--size", type=int, default=72)
    args = parser.parse_args()

    text = args.text.strip()[:80]
    if not text or not args.out.lower().endswith(".png"):
        return 2
    width = max(160, min(args.width, 3840))
    size = max(12, min(args.size, 300))
    font = load_font(size)

    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    box = probe.textbbox((0, 0), text, font=font)
    text_w, text_h = box[2] - box[0], box[3] - box[1]
    pad = size // 2
    height = text_h + pad * 2
    if text_w + pad * 2 > width:
        width = text_w + pad * 2
    x = (width - text_w) // 2 - box[0]
    y = pad - box[1]

    shadow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).text((x + 2, y + 3), text, font=font, fill=(0, 0, 0, 190))
    shadow = shadow.filter(ImageFilter.GaussianBlur(max(2, size // 14)))
    card = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    card.alpha_composite(shadow)
    ImageDraw.Draw(card).text((x, y), text, font=font, fill=(255, 255, 255, 255))
    card.save(args.out, "PNG")
    return 0


if __name__ == "__main__":
    sys.exit(main())
