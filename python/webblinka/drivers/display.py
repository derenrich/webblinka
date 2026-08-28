"""Shared ground for small framebuffer displays.

Every one of these parts works the same way: a block of memory on the host is
drawn into with the same handful of primitives, then shipped to the panel whole.
So the patterns live here once, written against the ``framebuf`` API that every
Adafruit mono display shares, and a driver supplies only the part that differs
-- how to make the device, how big it is, and which of its registers are worth
exposing.

**A display is write-only, and that shapes the whole panel.** Over I2C the
SSD1306 has no read path: you cannot ask it what is on the screen, what size it
thinks it is, or even whether it is there beyond the address ACK. Every command
is fire-and-forget. So the preview this driver returns is emphatically not a
screenshot -- it is the host's copy of what was *sent*, and a screen that stays
dark while the preview looks perfect is the normal way this hardware fails.

That is exactly why the patterns are worth having, and why they are these
patterns. Each one is chosen so that its *appearance* names the fault:

* nothing at all, on a bus that ACKed every byte, is the charge pump -- these
  panels generate their own 7.5 V and are simply dark without it;
* a border missing its bottom edge is the wrong height, 32 driven as 64;
* page stripes that come out uneven are a page-addressing fault;
* and a ruler whose ends wrap is a column offset -- the SH1106 that gets sold
  as an SSD1306 has 132 columns of RAM and starts two in, so an SSD1306 driver
  puts everything two pixels across and wraps the edge.

None of that is visible in a register. It is only visible on the glass, which
is why the answer to "is it working" is a pattern and not a status byte.
"""

from __future__ import annotations

import base64
import time
from typing import Any

from ..font5x8 import ensure_font
from .base import Driver

#: What the panel offers, in the order it offers it. The first two answer "is
#: it alive at all"; the rest answer "is it the geometry I told it".
PATTERNS: list[dict[str, str]] = [
    {
        "key": "all_on",
        "label": "All on",
        "title": (
            "Every pixel lit. The first thing to try: a panel that stays dark "
            "through this, on a bus that acknowledged every byte, is almost "
            "always the charge pump — these generate their own 7.5 V and show "
            "nothing without it."
        ),
    },
    {
        "key": "all_off",
        "label": "All off",
        "title": "Every pixel dark. Finds pixels stuck on, and clears the glass.",
    },
    {
        "key": "border",
        "label": "Border",
        "title": (
            "A one-pixel frame around the whole panel. It is the geometry test: "
            "if the bottom edge is missing you are driving a 32-row panel as 64, "
            "and if an edge is cut off the width is wrong."
        ),
    },
    {
        "key": "pages",
        "label": "Page stripes",
        "title": (
            "Alternating eight-pixel bands, which is how the memory is actually "
            "organised — one byte is eight vertical pixels. Uneven bands mean a "
            "page addressing fault rather than a drawing one."
        ),
    },
    {
        "key": "checker",
        "label": "Checkerboard",
        "title": (
            "Single-pixel checks: the hardest thing for the charge pump to drive "
            "and the easiest place to see ghosting between neighbouring pixels."
        ),
    },
    {
        "key": "ruler",
        "label": "Column ruler",
        "title": (
            "Ticks every 8 columns, taller every 32, with both end columns "
            "marked. If the ends wrap around, the controller is an SH1106 rather "
            "than an SSD1306 — it has 132 columns of RAM and starts two in, so "
            "everything lands two pixels across."
        ),
    },
    {
        "key": "text",
        "label": "Text",
        "title": "The built-in 5×8 font, with the panel's own geometry written on it.",
    },
]


class MonoDisplay(Driver):
    """Base for one-bit-per-pixel framebuffer displays."""

    LABEL = "Display"

    def __init__(self, bus, address: int) -> None:
        super().__init__(bus, address)
        self._device = None
        self._pattern = ""
        self._last_show_ms = 0.0
        self._bytes_sent = 0

    # -- what a subclass supplies -----------------------------------------

    def make_device(self):
        """Construct and initialise the display. Returns the framebuf object."""
        raise NotImplementedError

    def geometry(self) -> dict[str, int]:
        """``width`` and ``height`` in pixels."""
        raise NotImplementedError

    def frame_bytes(self) -> bytes:
        """The host's copy of the pixels, in the panel's own memory layout."""
        raise NotImplementedError

    def controls(self) -> list[dict[str, Any]]:
        return []

    def details(self) -> list[dict[str, Any]]:
        return []

    # -- the shared work ---------------------------------------------------

    def start(self) -> dict[str, Any]:
        self._device = self.make_device()
        return {"address": self.address, "label": self.LABEL, **self.geometry()}

    def stop(self) -> None:
        self._device = None

    def command(self, name: str, args: list[Any]) -> Any:
        if name == "pattern":
            return self.draw(str(args[0]))
        return super().command(name, args)

    def draw(self, key: str) -> dict[str, Any]:
        device = self.require()
        width = self.geometry()["width"]
        height = self.geometry()["height"]

        device.fill(0)
        if key == "all_on":
            device.fill(1)
        elif key == "all_off":
            pass
        elif key == "border":
            device.rect(0, 0, width, height, 1)
        elif key == "pages":
            for page in range(0, height, 8):
                if (page // 8) % 2 == 0:
                    device.fill_rect(0, page, width, 8, 1)
        elif key == "checker":
            for y in range(height):
                for x in range(y % 2, width, 2):
                    device.pixel(x, y, 1)
        elif key == "ruler":
            _ruler(device, width, height)
        elif key == "text":
            # The font has to be passed explicitly. framebuf's default resolves
            # font5x8.bin relative to the working directory, which is not
            # something a driver should be depending on.
            font = ensure_font()
            device.text(f"{width}x{height}", 0, 0, 1, font_name=font)
            device.text(f"{self.LABEL}", 0, 10, 1, font_name=font)
            device.text("0123456789ABCDEF", 0, 20, 1, font_name=font)
        else:
            raise LookupError(f"no pattern {key!r}")

        self._pattern = key
        self.show()
        return self.poll()

    def show(self) -> None:
        """Ship the framebuffer and record what it cost.

        Worth recording because it is the whole expense of using one of these.
        A 128x64 panel is 1025 bytes with the data prefix, which Blinka chops
        into 60-byte chunks -- eighteen of them, plus the six commands that set
        the addressing window before it. That is not a poll, it is a transfer,
        and it is why this panel does not refresh on a timer like the others.
        """
        device = self.require()
        began = time.monotonic()
        device.show()
        self._last_show_ms = (time.monotonic() - began) * 1000
        self._bytes_sent = len(self.frame_bytes())

    def poll(self) -> dict[str, Any]:
        frame = self.frame_bytes()
        return {
            "label": self.LABEL,
            **self.geometry(),
            # Base64 rather than a list of a thousand integers: the same bytes
            # in a third of the JSON, and the panel has atob built in.
            "frame": base64.b64encode(frame).decode("ascii"),
            "pattern": self._pattern,
            "patterns": PATTERNS,
            "lastShowMs": self._last_show_ms,
            "bytesSent": self._bytes_sent,
            "controls": self.controls(),
            "details": self.details(),
            # Said on every reading, because it is the one thing about this
            # panel that is easy to forget while looking at a picture of it.
            "previewIsSent": True,
        }

    def require(self):
        if self._device is None:
            raise RuntimeError(f"{self.LABEL} not started")
        return self._device


def _ruler(device, width: int, height: int) -> None:
    """Ticks along the top, and both end columns marked full height.

    The end columns are the point. A controller whose RAM is wider than its
    glass -- the SH1106 is 132 columns against 128 of screen -- puts them
    somewhere other than the edges, and nothing else in a normal image makes
    that visible.
    """
    device.vline(0, 0, height, 1)
    device.vline(width - 1, 0, height, 1)
    for x in range(0, width, 8):
        tick = 8 if x % 32 == 0 else 4
        device.vline(x, 0, tick, 1)
        device.vline(x, height - tick, tick, 1)
