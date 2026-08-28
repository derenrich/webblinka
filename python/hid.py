"""A `hid` module backed by the browser's WebHID API.

Adafruit_Blinka's MCP2221 driver imports `hid` (the hidapi binding) and uses a
remarkably small slice of it: ``hid.enumerate()`` plus a ``hid.device`` with
open/write/read/close. That is the *only* native dependency standing between
stock Blinka and the browser, so shadowing this one module on sys.path is enough
to run the real, unforked library against real hardware over WebHID.

hidapi's calls are blocking. WebHID's are promises. ``run_sync`` bridges the two
by suspending the Python stack via WebAssembly JSPI (Chrome 137+) while the
worker's event loop round-trips the request to the page. From Blinka's point of
view nothing asynchronous ever happened.

Deliberately not implemented: feature reports, non-blocking mode, and multiple
concurrently open devices. Blinka's MCP2221 path uses none of them, and the
page only ever holds the one adapter the user picked.
"""

from __future__ import annotations

import time

import js
from pyodide.ffi import run_sync

__all__ = ["HIDException", "device", "enumerate"]

# hidapi's own read blocks forever, and Blinka is written against that, so this
# bound exists only to stop a permanently wedged device hanging Python. The
# MCP2221 answers in about a millisecond; the generous margin is not for the
# device but for the page, because the reply is delivered on the main thread and
# a stall there delays it. Two seconds turned out to be inside the range of an
# ordinary hiccup, which failed transfers the device had in fact answered.
DEFAULT_TIMEOUT_MS = 8000

# Blinka's MCP2221 write path contains one loop with no bound on it:
#
#     while self._i2c_state() == RESP_I2C_PARTIALDATA:
#         time.sleep(0.001)
#
# Every other loop in that file stops after MCP2221_RETRY_MAX; this one does
# not. If the I2C engine parks at 0x41 -- which a glitch part-way through a
# write will do, and a loose jumper being waved about produces reliably -- it
# never leaves, and Blinka asks it again every millisecond for ever.
#
# That is worse here than it would be natively. Each iteration is a HID
# transfer, HID lives on the page's main thread, and a thousand round trips a
# second to it starves rendering: the symptom is not a stalled panel but a
# frozen tab, with no error anywhere because from Blinka's point of view
# nothing has gone wrong yet.
#
# The transport can see what the caller cannot. A caller sending the identical
# report and receiving the identical reply, hundreds of times, with no pause
# between, is not waiting for progress -- there is none to wait for. Blinka's
# own bounded loops give up after fifty, so a limit an order of magnitude above
# that cannot fire on one of them, and the gap check keeps a panel that polls
# status once a second from ever accumulating a count at all.
SPIN_GAP_MS = 50
SPIN_LIMIT = 400


class HIDException(OSError):
    """Raised for transport failures.

    Subclasses OSError because Blinka's MCP2221._reset() catches OSError when
    polling for the device to come back.
    """


def enumerate(vendor_id: int = 0, product_id: int = 0) -> list[dict]:
    """List attached devices, filtered like hidapi's (0 means "any")."""
    devices = [dict(info) for info in run_sync(js.webblinkaHid.enumerate()).to_py()]
    return [
        info
        for info in devices
        if (not vendor_id or info["vendor_id"] == vendor_id)
        and (not product_id or info["product_id"] == product_id)
    ]


class device:  # noqa: N801 - hidapi spells it lowercase and Blinka calls hid.device()
    """A single open HID device."""

    def __init__(self, path: bytes | None = None) -> None:
        self._open = False
        self._last_exchange: tuple[bytes, bytes] | None = None
        self._pending_write = b""
        self._repeats = 0
        self._last_at = 0.0
        if path is not None:
            self.open_path(path)

    def open(self, vendor_id: int, product_id: int) -> None:
        try:
            run_sync(js.webblinkaHid.open(vendor_id, product_id))
        except Exception as err:  # noqa: BLE001 - surfaced as hidapi's error type
            raise HIDException(str(err)) from err
        self._open = True

    def open_path(self, path: bytes) -> None:
        # Only one device is ever held, so every path resolves to the same one.
        del path
        self.open(0, 0)

    def write(self, data) -> int:
        """Send one output report. Byte 0 is the report ID, as in hidapi."""
        self._require_open()
        self._pending_write = bytes(data)
        payload = js.Uint8Array.new(list(self._pending_write))
        try:
            return int(run_sync(js.webblinkaHid.write(payload)))
        except Exception as err:  # noqa: BLE001
            raise HIDException(str(err)) from err

    def read(self, size: int, timeout_ms: int | None = None) -> list[int]:
        """Block for one input report and return it as a list of ints."""
        self._require_open()
        timeout = DEFAULT_TIMEOUT_MS if timeout_ms in (None, 0) else int(timeout_ms)
        try:
            report = run_sync(js.webblinkaHid.read(size, timeout))
        except Exception as err:  # noqa: BLE001
            raise HIDException(str(err)) from err
        reply = list(report.to_py())[:size]
        self._check_for_spin(bytes(reply))
        return reply

    def _check_for_spin(self, reply: bytes) -> None:
        """Break a caller that is asking the same question without progress.

        Identical report out, identical report back, no pause in between: the
        state being waited on is not going to change, and the loop doing the
        waiting has no bound. Raising here is the only place that can end it --
        the loop is inside a library this project deliberately does not fork,
        and Python is suspended inside JSPI where nothing outside can interrupt
        it.
        """
        now = time.monotonic() * 1000
        exchange = (self._pending_write, reply)

        if exchange == self._last_exchange and now - self._last_at < SPIN_GAP_MS:
            self._repeats += 1
        else:
            self._last_exchange = exchange
            self._repeats = 1
        self._last_at = now

        if self._repeats < SPIN_LIMIT:
            return

        self._repeats = 0
        state = reply[8] if len(reply) > 8 else 0
        raise HIDException(
            f"I2C engine stuck in state 0x{state:02x}: {SPIN_LIMIT} identical "
            "status reads with no change. The bus is not going to recover on "
            "its own -- check the wiring to the device, then reset the chip."
        )

    def close(self) -> None:
        if not self._open:
            return
        self._open = False
        run_sync(js.webblinkaHid.close())

    def _require_open(self) -> None:
        if not self._open:
            raise HIDException("device is not open")

    # -- hidapi surface Blinka never touches, but drivers might ask about ----

    def set_nonblocking(self, nonblocking: int) -> None:
        if nonblocking:
            raise NotImplementedError("non-blocking reads are not supported over WebHID")

    def __enter__(self) -> "device":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()
