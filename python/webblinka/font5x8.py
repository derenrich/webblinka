"""The 5x8 bitmap font ``adafruit_framebuf`` draws text with, carried inline.

``framebuf.text()`` does not embed a font. It ``open()``s ``font5x8.bin`` at
draw time -- Adafruit ship it beside the library and expect you to copy it onto
the board yourself -- so on a filesystem that has never seen it, every call to
``text()`` raises. The wheel does not contain it either, which is why installing
the package is not enough.

There is no filesystem here in the usual sense, and nothing to copy files onto,
so the font travels as base64 inside a module that the existing bundling
already carries, and is written out once on first use. 1282 bytes: a
one-byte width, a one-byte height, then five columns for each of 256 characters.

From Adafruit_CircuitPython_framebuf (MIT), examples/font5x8.bin.
"""

from __future__ import annotations

import base64
import os

#: Where the font is materialised. Absolute, and passed to ``text()``
#: explicitly, because the library resolves the default relative to the working
#: directory -- which is not something a driver should have to depend on.
FONT_PATH = "/webblinka/font5x8.bin"

_FONT_BASE64 = (
    "BQgAAAAAAD5bT1s+PmtPaz4cPnw+HBg8fjwYHFd9VxwcXn9eHAAYPBgA/+fD5/8AGCQYAP/n"
    "2+f/MEg6Bg4mKXkpJkB/BQUHQH8FJT9aPOc8Wn8+HBwICBwcPn8UIn8iFF9fAF9fBgl/AX8A"
    "ZomVamBgYGBglKL/opQIBH4ECBAgfiAQCAgqHAgIHCoICB4QEBAQDB4MHgwwOD44MAYOPg4G"
    "AAAAAAAAAF8AAAAHAAcAFH8UfxQkKn8qEiMTCGRiNklWIFAACAcDAAAcIkEAAEEiHAAqHH8c"
    "KggIPggIAIBwMAAICAgICAAAYGAAIBAIBAI+UUlFPgBCf0AAcklJSUYhQUlNMxgUEn8QJ0VF"
    "RTk8SklJMUEhEQkHNklJSTZGSUkpHgAAFAAAAEA0AAAACBQiQRQUFBQUAEEiFAgCAVkJBj5B"
    "XVlOfBIREnx/SUlJNj5BQUEif0FBQT5/SUlJQX8JCQkBPkFBUXN/CAgIfwBBf0EAIEBBPwF/"
    "CBQiQX9AQEBAfwIcAn9/BAgQfz5BQUE+fwkJCQY+QVEhXn8JGSlGJklJSTIDAX8BAz9AQEA/"
    "HyBAIB8/QDhAP2MUCBRjAwR4BANhWUlNQwB/QUFBAgQIECAAQUFBfwQCAQIEQEBAQEAAAwcI"
    "ACBUVHhAfyhERDg4REREKDhERCh/OFRUVBgACH4JAhikpJx4fwgEBHgARH1AACBAQD0AfxAo"
    "RAAAQX9AAHwEeAR4fAgEBHg4REREOPwYJCQYGCQkGPx8CAQECEhUVFQkBAQ/RCQ8QEAgfBwg"
    "QCAcPEAwQDxEKBAoREyQkJB8RGRUTEQACDZBAAAAdwAAAEE2CAACAQIEAjwmIyY8HqGhYRI6"
    "QEAgejhUVFVZIVVVeUEiVFR4QiFVVHhAIFRVeUAMHlJyEjlVVVVZOVRUVFk5VVRUWAAARXxB"
    "AAJFfUIAAUV8QH0SERJ98CglKPB8VFVFACBUVHxUfAoJf0kySUlJMjpEREQ6MkpISDA6QUEh"
    "ejpCQCB4AJ2goH09QkJCPT1AQEA9PCT/JCRIfklDZisv/C8r/wkp9iDAiH4JAyBUVHlBAABE"
    "fUEwSEhKMjhAQCJ6AHoKCnJ9DRkxfSYpKS8oJikpKSYwSE1AIDgICAgICAgICDgvEMisui8Q"
    "KDT6AAB7AAAIFCoUIiIUKhQIVQBVAFWqVapVqv9V/1X/AAAA/wAQEBD/ABQUFP8AEBD/AP8Q"
    "EPAQ8BQUFPwAFBT3AP8AAP8A/xQU9AT8FBQXEB8QEB8QHxQUFB8AEBAQ8AAAAAAfEBAQEB8Q"
    "EBAQ8BAAAAD/EBAQEBAQEBAQ/xAAAAD/FAAA/wD/AAAfEBcAAPwE9BQUFxAXFBT0BPQAAP8A"
    "9xQUFBQUFBT3APcUFBQXFBAQHxAfFBQU9BQQEPAQ8AAAHxAfAAAAHxQAAAD8FAAA8BDwEBD/"
    "EP8UFBT/FBAQEB8AAAAA8BD///////Dw8PDw////AAAAAAD//w8PDw8POEREOET8SkpKNH4C"
    "AgYGAn4CfgJjVUlBYzhERDwEQH4gHiAGAn4CApml56WZHCpJKhxMcgFyTDBKTU0wMEh4SDC8"
    "YlpGPT5JSUkAfgEBAX4qKioqKkREX0REQFFKREBAREpRQAAA/wED4ID/AAAICGtrCDYSNiQ2"
    "Bg8JDwYAABgYAAAAEBAAMED/AQEAHwEBHgAZHRcSADw8PDwAAAAAAA=="
)


def ensure_font(path: str = FONT_PATH) -> str:
    """Write the font out if it is not already there, and return its path."""
    if not os.path.exists(path):
        with open(path, "wb") as handle:
            handle.write(base64.b64decode(_FONT_BASE64))
    return path
