"""SSD1306 OLED, on the stock adafruit_ssd1306 library.

The generic 0.96-inch modules sold as "SSD1306 I2C IIC SPI Serial" are this
part, usually 128x64 at address 0x3C, sometimes 128x32, and sometimes an SH1106
that answers to the same address and is not quite the same controller.

**The geometry is a setting, not a discovery.** There is nothing to read: the
I2C interface is write-only, so the driver cannot ask the panel how many rows it
has, and getting it wrong does not fail. Tell a 32-row module it has 64 and
every write succeeds -- the multiplex ratio is set past the end of the glass and
the image comes out stretched or half-blank. So height is a control, and the
border pattern is how you find out which one is right.

**Nothing here is confirmed by the bus.** The address ACK is the only feedback
of any kind. Beyond that, a panel with its charge pump disabled, its power off
or its contrast at zero accepts every byte in exactly the same way as one
showing a picture.
"""

from __future__ import annotations

from typing import Any

from .base import register
from .display import MonoDisplay

#: SA0 low and SA0 high. Most modules are strapped to 0x3C with no jumper.
DEFAULT_ADDRESS = 0x3C
ADDRESSES = (0x3C, 0x3D)

#: The panels these modules actually use. Both are 128 wide; the 64-row and
#: 32-row parts are otherwise identical and indistinguishable over the bus.
SIZES: dict[str, tuple[int, int]] = {
    "128x64": (128, 64),
    "128x32": (128, 32),
}


@register("ssd1306")
class Ssd1306(MonoDisplay):
    """Solomon Systech SSD1306 monochrome OLED."""

    LABEL = "SSD1306"

    def __init__(self, bus, address: int = DEFAULT_ADDRESS) -> None:
        super().__init__(bus, address)
        self._size = "128x64"
        self._contrast = 0xCF
        self._inverted = False
        self._on = True

    def make_device(self):
        import adafruit_ssd1306

        width, height = SIZES[self._size]
        device = adafruit_ssd1306.SSD1306_I2C(width, height, self.bus, addr=self.address)
        device.contrast(self._contrast)
        device.invert(self._inverted)
        return device

    def geometry(self) -> dict[str, int]:
        width, height = SIZES[self._size]
        return {"width": width, "height": height}

    def frame_bytes(self) -> bytes:
        # The library keeps one buffer with a leading 0x40 data-mode byte so the
        # whole thing can go out in a single I2C write. The pixels are the rest.
        return bytes(self.require().buffer[1:])

    def command(self, name: str, args: list[Any]) -> Any:
        if name == "set_size":
            key = str(args[0])
            if key not in SIZES:
                raise LookupError(f"no size {key!r}")
            self._size = key
            # Rebuilt rather than reconfigured: the buffer, the multiplex ratio
            # and the COM pin layout all follow from the height, and the
            # library settles them in its constructor.
            self._device = self.make_device()
            return self.draw(self._pattern or "border")
        if name == "set_contrast":
            self._contrast = max(0, min(255, int(args[0])))
            self.require().contrast(self._contrast)
            return self.poll()
        if name == "set_invert":
            self._inverted = bool(args[0])
            # A controller-level flip: it inverts what is already on the glass
            # without touching the buffer, so the preview deliberately does not
            # follow it. The panel says so rather than quietly disagreeing.
            self.require().invert(self._inverted)
            return self.poll()
        if name == "set_power":
            self._on = bool(args[0])
            device = self.require()
            device.poweron() if self._on else device.poweroff()
            return self.poll()
        return super().command(name, args)

    def controls(self) -> list[dict[str, Any]]:
        return [
            {
                "kind": "select",
                "command": "set_size",
                "label": "Panel",
                "value": self._size,
                "options": [{"value": key, "label": key} for key in SIZES],
                "title": (
                    "There is no way to read this off the module — the interface "
                    "is write-only. Draw the border pattern: if its bottom edge "
                    "is missing, this is set too tall."
                ),
            },
            {
                "kind": "range",
                "command": "set_contrast",
                "label": "Contrast",
                "value": self._contrast,
                "min": 0,
                "max": 255,
                "title": (
                    "Drive current, not really contrast — these are emissive, so "
                    "it sets brightness. Zero is not black, it is dim."
                ),
            },
            {
                "kind": "toggle",
                "command": "set_invert",
                "label": "Invert",
                "value": self._inverted,
                "title": (
                    "Inverts on the controller, not in the buffer, so the "
                    "preview beside this does not change."
                ),
            },
            {
                "kind": "toggle",
                "command": "set_power",
                "label": "Display on",
                "value": self._on,
                "title": (
                    "Blanks the glass and keeps the memory. The buffer survives, "
                    "so switching back on shows the same image without a resend."
                ),
            },
        ]

    def details(self) -> list[dict[str, Any]]:
        width, height = SIZES[self._size]
        return [
            {
                "label": "Framebuffer",
                "value": f"{width * height // 8} bytes · {height // 8} pages",
                "title": (
                    "One byte is eight vertical pixels, which is why the memory "
                    "is organised in eight-row pages."
                ),
            },
            {
                "label": "Readback",
                "value": "none — write only",
                "title": (
                    "The I2C interface has no read path. The address ACK is the "
                    "only confirmation of anything that this panel ever gets."
                ),
            },
        ]
