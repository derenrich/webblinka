"""Bosch BMI160 six-axis IMU, on the stock circuitpython-bmi160 library.

The library handles identity, reset and the power-mode sequencing. It does not
take the readings here, and it is not asked to interpret the configuration
registers either, because three of its lookups are wrong.

**Its gyroscope scale table is reversed.** ``gyro_scale`` maps the 125 deg/s
range to 16.4 LSB per deg/s and the 2000 deg/s range to 262.4. It is the other
way round: the output is a signed 16-bit word spanning the selected range, so
the sensitivity is 32768/range -- the *narrowest* range gives the *largest*
count per degree. The five numbers in the table are the right five numbers,
assigned to the wrong five ranges, so the readings come out wrong by up to a
factor of 256 at the ends and are correct only at 500 deg/s, where the table
happens to map to itself. Nothing about a wrong answer looks wrong: a bench
that reads 3 deg/s instead of 0.19 is still a small plausible number.

**Its output-rate tables are misindexed.** Both are indexed by the raw register
field, but the accelerometer's starts at 0 when the register's lowest valid
value is 1, so every rate it names is one step out; and the gyroscope's has
eight entries for a field whose valid values run from 6 to 13, so reading it at
the part's own reset default raises IndexError outright. Both are decoded here
from Bosch's formula instead -- 100 / 2**(8 - field) Hz, which the library's own
named constants agree with.

**And it reads one axis at a time.** ``acceleration`` fetches the range and
then each of X, Y and Z in separate transactions -- four round trips, and
another four for ``gyro``. Through USB HID that is tens of milliseconds, over
which a board being turned moves. The six axes live in consecutive registers
from 0x0C precisely so they can be taken together, and that is what this does:
one twelve-byte burst, one instant, one vector.

The temperature answers the obvious question about why an IMU has a
thermometer. It is not for the room. The gyroscope's zero-rate offset moves
with die temperature, and this is the die -- which is why the datasheet only
guarantees the value when the gyroscope is in normal mode, and updates it every
10 ms in that mode against 1.28 s otherwise. It is the gyro's thermometer.
"""

from __future__ import annotations

import struct
import time
from typing import Any

from .base import register
from .imu import Imu, Motion

#: SDO low and SDO high. 0x69 collides with the RV-1805 and 0x68 with a DS3231
#: or an MPU-6050, so the identity check at start matters.
DEFAULT_ADDRESS = 0x68
ADDRESSES = (0x68, 0x69)

#: How often the die temperature is actually fetched. It is a thermal mass in
#: a plastic package -- it does not move perceptibly between two polls a fifth
#: of a second apart -- and on this bus it is a whole extra transaction, which
#: is half the cost of a poll.
TEMPERATURE_INTERVAL_S = 1.0

#: Gyroscope X low byte. Gyro XYZ then accelerometer XYZ, twelve bytes, in the
#: order the datasheet lays them out for exactly this read.
REG_GYRO_X_LSB = 0x0C
MOTION_BYTES = 12

#: Die temperature, 16-bit signed, 1/512 K per count with the zero at 23 C.
REG_TEMPERATURE = 0x20
TEMPERATURE_ZERO_C = 23.0
TEMPERATURE_STEP_C = 1 / 512

#: The signed 16-bit output spans the selected range in both directions, so
#: sensitivity is 32768/range. Written out rather than derived so the numbers
#: can be read against the datasheet directly.
ACCEL_RANGES: dict[int, float] = {0b0011: 2.0, 0b0101: 4.0, 0b1000: 8.0, 0b1100: 16.0}
GYRO_RANGES: dict[int, float] = {
    0b000: 2000.0,
    0b001: 1000.0,
    0b010: 500.0,
    0b011: 250.0,
    0b100: 125.0,
}

FULL_SCALE_COUNTS = 32768.0


def odr_hz(field: int) -> float:
    """Output data rate from the register field, per Bosch.

    One expression covers both sensors: the accelerometer's field runs 1 to 12
    and the gyroscope's 6 to 13, and this is right across both.
    """
    return 100.0 / (2 ** (8 - field))


@register("bmi160")
class Bmi160(Imu):
    """Bosch BMI160 accelerometer and gyroscope."""

    LABEL = "BMI160"
    TEMPERATURE_NOTE = (
        "Die temperature, not the room. It is here because the gyroscope's "
        "zero-rate offset moves with it — which is also why the part only "
        "guarantees this value while the gyroscope is running."
    )

    def __init__(self, bus, address: int = DEFAULT_ADDRESS) -> None:
        super().__init__(bus, address)
        self._sensor = None
        self._device = None
        self._config: dict[str, Any] = {}
        self._temperature_c: float | None = None
        self._temperature_at = 0.0
        self._recoveries = 0

    def start(self) -> dict[str, Any]:
        import bmi160
        from adafruit_bus_device import i2c_device

        # The constructor checks the chip ID against 0xD1 and raises otherwise,
        # which is what keeps a clock or an MPU-6050 at the same address from
        # being read as an IMU. It also resets the part and brings both sensors
        # up in normal mode.
        self._sensor = bmi160.BMI160(self.bus, address=self.address)
        self._device = i2c_device.I2CDevice(self.bus, self.address)
        self._refresh_config()
        return {"address": self.address, "label": self.LABEL, **self.ranges()}

    def stop(self) -> None:
        self._sensor = None
        self._device = None

    def command(self, name: str, args: list[Any]) -> Any:
        sensor = self._require()
        if name == "set_accel_range":
            sensor.acceleration_range = int(args[0])
            self._refresh_config()
            return self.poll()
        if name == "set_gyro_range":
            sensor.gyro_range = int(args[0])
            self._refresh_config()
            return self.poll()
        return super().command(name, args)

    # -- readings ----------------------------------------------------------

    def read_motion(self) -> Motion:
        raw = self._burst_or_recover(REG_GYRO_X_LSB, MOTION_BYTES)
        gyro_x, gyro_y, gyro_z, accel_x, accel_y, accel_z = struct.unpack("<6h", raw)

        ranges = self.ranges()
        accel_scale = ranges["accelG"] / FULL_SCALE_COUNTS
        gyro_scale = ranges["gyroDps"] / FULL_SCALE_COUNTS

        from .imu import STANDARD_GRAVITY

        return Motion(
            accel=(
                accel_x * accel_scale * STANDARD_GRAVITY,
                accel_y * accel_scale * STANDARD_GRAVITY,
                accel_z * accel_scale * STANDARD_GRAVITY,
            ),
            gyro=(
                gyro_x * gyro_scale,
                gyro_y * gyro_scale,
                gyro_z * gyro_scale,
            ),
            temperature_c=self._temperature(),
        )

    def ranges(self) -> dict[str, float]:
        """The cached full scales. Free -- no bus traffic."""
        return {
            "accelG": self._config.get("accelG", 2.0),
            "gyroDps": self._config.get("gyroDps", 250.0),
        }

    def _refresh_config(self) -> None:
        """Read the four configuration fields, once, after any change to them.

        The library's range getters return the setting's *name*; the raw bit
        fields underneath are what map to a number.
        """
        sensor = self._require()
        self._config = {
            "accelG": ACCEL_RANGES.get(sensor._acc_range, 2.0),
            "gyroDps": GYRO_RANGES.get(sensor._gyro_range, 250.0),
            "accelBits": sensor._acc_range,
            "gyroBits": sensor._gyro_range,
            "accelOdrHz": odr_hz(sensor._acc_odr),
            "gyroOdrHz": odr_hz(sensor._gyro_odr),
        }

    def _temperature(self) -> float | None:
        """The die temperature, at most once a second."""
        now = time.monotonic()
        if self._temperature_c is not None and now - self._temperature_at < TEMPERATURE_INTERVAL_S:
            return self._temperature_c
        raw = struct.unpack("<h", self._burst(REG_TEMPERATURE, 2))[0]
        self._temperature_c = TEMPERATURE_ZERO_C + raw * TEMPERATURE_STEP_C
        self._temperature_at = now
        return self._temperature_c

    def _burst(self, register_address: int, length: int) -> bytes:
        """One write of the register pointer, one read of `length` bytes."""
        buffer = bytearray(length)
        with self._require_device() as i2c:
            i2c.write_then_readinto(bytes([register_address]), buffer)
        return bytes(buffer)

    def _burst_or_recover(self, register_address: int, length: int) -> bytes:
        """A burst, and one attempt to unstick the bus if it fails.

        The failure this exists for is a repeated-start read abandoned between
        its two halves: the part is left waiting for the read that never came,
        with no STOP sent, holding the bus. Nothing recovers on its own from
        there -- every later transaction fails at the address phase, and the
        panel looks frozen. Cancelling the engine drives the STOP that releases
        it, so one cancel and one retry turns a dead panel into a dropped
        frame. If the retry fails too, the bus is genuinely stuck and the error
        belongs on screen with its trace rather than swallowed here.
        """
        try:
            return self._burst(register_address, length)
        except Exception:  # noqa: BLE001 - any bus failure gets the same treatment
            from .. import mcp2221_chip

            mcp2221_chip.force_idle()
            self._recoveries += 1
            return self._burst(register_address, length)

    # -- panel surface -----------------------------------------------------

    def controls(self) -> list[dict[str, Any]]:
        return [
            {
                "kind": "select",
                "command": "set_accel_range",
                "label": "Accel range",
                "value": self._config.get("accelBits", 0),
                "options": [
                    {"value": bits, "label": f"±{g:g} g"}
                    for bits, g in sorted(ACCEL_RANGES.items(), key=lambda item: item[1])
                ],
                "title": (
                    "Full scale. A narrower range resolves finer steps — the "
                    "output is always the same 16 bits — so use the narrowest "
                    "the motion will fit inside."
                ),
            },
            {
                "kind": "select",
                "command": "set_gyro_range",
                "label": "Gyro range",
                "value": self._config.get("gyroBits", 0),
                "options": [
                    {"value": bits, "label": f"±{dps:g} °/s"}
                    for bits, dps in sorted(GYRO_RANGES.items(), key=lambda item: item[1])
                ],
                "title": (
                    "Full scale for rotation. ±125 °/s resolves about "
                    "0.004 °/s per count; ±2000 only 0.061."
                ),
            },
            {
                "kind": "button",
                "command": "zero_gyro",
                "label": "Zero the gyro",
                "args": [],
                "title": (
                    "Averages the gyroscope while the board is still and calls "
                    "that zero. Hold it still — a capture taken while it moves "
                    "bakes the movement in as the offset."
                ),
            },
            {
                "kind": "button",
                "command": "clear_zero",
                "label": "Clear",
                "args": [],
                "title": "Discard the captured offset and show the raw rates again.",
            },
        ]

    def details(self) -> list[dict[str, Any]]:
        rows = [
            {
                "label": "Chip ID",
                "value": "0xd1 · BMI160",
                "title": "Checked at open — 0x68 and 0x69 are crowded addresses.",
            },
            {
                "label": "Output rate",
                "value": f"{self._config.get('accelOdrHz', 0):g} Hz · "
                f"{self._config.get('gyroOdrHz', 0):g} Hz",
                "title": (
                    "Accelerometer and gyroscope, which are set separately. "
                    "Decoded here rather than read from the library, whose "
                    "tables for these are misindexed."
                ),
            },
        ]
        if self._recoveries:
            rows.append(
                {
                    "label": "Bus glitches",
                    "value": f"{self._recoveries} recovered",
                    "title": (
                        "Transfers that failed and succeeded on a retry. A count "
                        "that climbs while the board is moved, and not while it "
                        "sits still, is a connection problem rather than a "
                        "software one — check the cable and the header pins."
                    ),
                }
            )
        if self._zeroed_at_c is not None:
            rows.append(
                {
                    "label": "Zeroed at",
                    "value": f"{self._zeroed_at_c:.1f} °C",
                    "title": (
                        "The die temperature when the offset was captured. The "
                        "offset only holds near it — the part self-heats after "
                        "power-up, so a zero taken cold goes stale."
                    ),
                }
            )
        return rows

    def _require(self):
        if self._sensor is None:
            raise RuntimeError("BMI160 not started")
        return self._sensor

    def _require_device(self):
        if self._device is None:
            raise RuntimeError("BMI160 not started")
        return self._device
