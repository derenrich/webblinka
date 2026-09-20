"""Bosch BMP390 and BMP388, on the stock adafruit_bmp3xx library.

**Every property is its own forced measurement.** ``pressure`` calls ``_read``,
``temperature`` calls ``_read``, and ``altitude`` calls ``pressure``, which
calls ``_read`` again. Reading the three the obvious way triggers three
conversions and three status-poll loops -- and at ×32 oversampling a conversion
takes up to 78 ms on top of the bus time. This driver calls ``_read`` once and
derives the rest, which is also the only way to get a pressure and the
temperature it was compensated with from the same instant.

**The datasheet is explicit about the burst.** Section 3.10.1: the data
registers are shadowed only for the duration of one burst read, and "using
several independent read commands may result in inconsistent data". The library
does read its six data bytes in one go; it is the surrounding property access
that multiplies the conversions, not the register read.

**The wait for conversion has no bound**, so this driver does not use it.
``_read`` waits with ``while status & 0x60 != 0x60`` and no retry limit: a part
that never reports both conversions done spins there for ever, one I2C
transaction per iteration. The transport's spin detector does not save this
one -- it fires on the same HID report repeating, and each turn of this loop is
a whole write-then-read, a different sequence of reports every time. A test
established that by hanging.

So the measurement is taken here: trigger forced mode, wait with a deadline
computed from the datasheet's own maximum conversion time for the oversampling
in force, read the six data bytes in the single burst section 3.10.1 requires,
and apply the compensation. The compensation is the one piece of arithmetic in
this project copied out of a library rather than called, which is a real cost,
so ``test_matches_the_library`` asserts the two agree on the same raw counts.

Accuracy figures below are Bosch's, from BST-BMP390-DS002 section 3.2.
"""

from __future__ import annotations

import time
from typing import Any

from .barometry import Barometer, METRES_PER_HPA
from .base import register

#: SDO low and SDO high. Adafruit's breakout strap is 0x77; bare modules and
#: the Pimoroni boards are often 0x76.
DEFAULT_ADDRESS = 0x77
ADDRESSES = (0x76, 0x77)

#: Oversampling to the typical pressure resolution it buys, in pascals, and
#: the typical measurement time in milliseconds. Datasheet tables 6 and 23 --
#: both are worth showing, because they are the two ends of the same trade.
OVERSAMPLING: dict[int, tuple[float, float]] = {
    1: (2.64, 4.82),
    2: (1.32, 6.84),
    4: (0.66, 10.88),
    8: (0.33, 18.69),
    16: (0.17, 37.14),
    32: (0.085, 69.46),
}

#: IIR filter coefficients the part offers. Higher is smoother and slower.
FILTERS = (0, 2, 4, 8, 16, 32, 64, 128)

#: Typical RMS noise in pascals, by oversampling and filter coefficient.
#: Datasheet table 8, transcribed whole, because the two knobs are not
#: independent and neither one means much without the other.
#:
#: The table is the argument against the obvious intuition. Going from x1 to
#: x32 costs fourteen times the conversion time and takes noise from 3.7 Pa to
#: 0.9 -- about the sqrt(N) averaging predicts. Turning the filter on instead
#: takes x1 from 3.7 Pa to 0.1, better than x32 unfiltered and far cheaper,
#: because it averages across readings already being taken rather than making
#: each one longer. What the filter costs is not time but lag: it smooths a
#: real climb exactly as well as it smooths noise.
NOISE_PA: dict[int, dict[int, float]] = {
    1: {0: 3.7, 2: 2.0, 4: 1.2, 8: 0.8, 16: 0.4, 32: 0.2, 64: 0.1, 128: 0.1},
    2: {0: 2.7, 2: 1.5, 4: 0.9, 8: 0.5, 16: 0.3, 32: 0.2, 64: 0.1, 128: 0.1},
    4: {0: 2.0, 2: 1.1, 4: 0.7, 8: 0.4, 16: 0.3, 32: 0.2, 64: 0.1, 128: 0.04},
    8: {0: 1.6, 2: 0.9, 4: 0.6, 8: 0.3, 16: 0.2, 32: 0.1, 64: 0.1, 128: 0.03},
    16: {0: 1.2, 2: 0.6, 4: 0.4, 8: 0.2, 16: 0.1, 32: 0.1, 64: 0.04, 128: 0.03},
    32: {0: 0.9, 2: 0.5, 4: 0.3, 8: 0.2, 16: 0.1, 32: 0.1, 64: 0.1, 128: 0.1},
}

#: Cells the datasheet gives as "<0.1" rather than a figure, so the panel can
#: show them as the upper bound they are instead of inventing precision.
NOISE_IS_BOUND = {(32, 64), (32, 128)}

CHIP_IDS = {0x50: "BMP388", 0x60: "BMP390"}

REG_STATUS = 0x03
REG_PRESSURE = 0x04
REG_PWR_CTRL = 0x1B

#: Both data-ready bits: temperature and pressure.
STATUS_READY = 0x60

#: How far past the datasheet's typical conversion time to wait before calling
#: it a failure, and a floor underneath that for the bus itself. Each status
#: check is an I2C transaction, which on this adapter is some 20 ms.
WAIT_MARGIN = 4.0
WAIT_FLOOR_S = 0.5


@register("bmp3xx")
class Bmp3xx(Barometer):
    """Bosch BMP390 pressure and temperature sensor, and the BMP388."""

    LABEL = "BMP390"

    # Datasheet section 3.2: relative accuracy +/-0.03 hPa over 700-1100 hPa at
    # 25-40 C, which Bosch also state directly as +/-25 cm; absolute accuracy
    # +/-0.50 hPa over 0-65 C.
    RELATIVE_ACCURACY_HPA = 0.03
    ABSOLUTE_ACCURACY_HPA = 0.5

    def __init__(self, bus, address: int = DEFAULT_ADDRESS) -> None:
        super().__init__(bus, address)
        self._sensor = None
        self._config: dict[str, Any] = {}
        self._chip = "BMP390"

    def start(self) -> dict[str, Any]:
        import adafruit_bmp3xx

        # The constructor checks the chip ID against 0x50 and 0x60 and raises
        # otherwise, which is what stops a BME280 or an MS5611 at the same
        # address being read as this part.
        self._sensor = adafruit_bmp3xx.BMP3XX_I2C(self.bus, address=self.address)
        # x8 pressure against x1 temperature: a third of a pascal, which is
        # already finer than the relative accuracy, for under 19 ms. The x32
        # setting costs 69 ms per reading to buy resolution the part's own
        # accuracy cannot use.
        self._sensor.pressure_oversampling = 8
        self._sensor.temperature_oversampling = 1
        self._sensor.filter_coefficient = 4
        self._refresh_config()
        return {"address": self.address, "label": self.LABEL, **self._config}

    def stop(self) -> None:
        self._sensor = None

    def read(self) -> tuple[float, float]:
        """One forced conversion, both numbers, with a bound on the wait."""
        sensor = self._require()

        # Forced mode: press_en | temp_en | mode=01. One measurement, then the
        # part returns to sleep on its own.
        sensor._write_register_byte(REG_PWR_CTRL, 0x13)

        # The datasheet's maximum for this oversampling, with room for the bus
        # underneath it. Generous, because the cost of being wrong in this
        # direction is a spurious failure and in the other it is a hung tab.
        budget = self._config.get("measureMs", 70.0) * WAIT_MARGIN / 1000
        deadline = time.monotonic() + budget + WAIT_FLOOR_S
        while True:
            if sensor._read_byte(REG_STATUS) & STATUS_READY == STATUS_READY:
                break
            if time.monotonic() > deadline:
                raise RuntimeError(
                    f"{self.LABEL} never finished a conversion: data-ready still "
                    f"clear after {(budget + WAIT_FLOOR_S) * 1000:.0f} ms, against "
                    f"a datasheet maximum of {self._config.get('measureMs', 0):g} ms."
                )
            time.sleep(0.002)

        # One burst. Datasheet 3.10.1: the data registers are shadowed only for
        # the duration of a single burst read, and separate reads "may result
        # in inconsistent data".
        data = sensor._read_register(REG_PRESSURE, 6)
        adc_p = data[2] << 16 | data[1] << 8 | data[0]
        adc_t = data[5] << 16 | data[4] << 8 | data[3]

        pressure_pa, temperature_c = compensate(
            adc_p, adc_t, sensor._temp_calib, sensor._pressure_calib
        )
        return pressure_pa / 100, temperature_c

    def command(self, name: str, args: list[Any]) -> Any:
        sensor = self._require()
        if name == "set_pressure_oversampling":
            sensor.pressure_oversampling = int(args[0])
            self._refresh_config()
            return self.poll()
        if name == "set_filter":
            sensor.filter_coefficient = int(args[0])
            self._refresh_config()
            return self.poll()
        return super().command(name, args)

    def _refresh_config(self) -> None:
        """Read the settings registers once, after any change to them.

        Cached for the same reason as everywhere else in this project: each of
        these is a bus transaction, and none of them changes unless this driver
        changes it. Reading them back inside a poll is how a one-transaction
        reading turns into six.
        """
        sensor = self._require()
        oversampling = sensor.pressure_oversampling
        resolution_pa, measure_ms = OVERSAMPLING.get(oversampling, (0.0, 0.0))
        self._config = {
            "oversampling": oversampling,
            "temperatureOversampling": sensor.temperature_oversampling,
            "filter": sensor.filter_coefficient,
            "resolutionPa": resolution_pa,
            "measureMs": measure_ms,
        }

    def controls(self) -> list[dict[str, Any]]:
        return [
            {
                "kind": "button",
                "command": "set_datum",
                "label": "Set datum here",
                "args": [],
                "title": (
                    "Take the current pressure as zero height. The offset that "
                    "makes absolute altitude unreliable is shared by both "
                    "readings, so it cancels — this is the ±25 cm measurement."
                ),
            },
            {
                "kind": "button",
                "command": "clear_datum",
                "label": "Clear",
                "args": [],
                "title": "Forget the datum and show absolute altitude only.",
            },
            {
                "kind": "select",
                "command": "set_pressure_oversampling",
                "label": "Oversampling",
                "value": self._config.get("oversampling", 8),
                "options": [
                    {"value": times, "label": f"×{times} · {pa:g} Pa"}
                    for times, (pa, ms) in OVERSAMPLING.items()
                ],
                "title": (
                    "Averaging inside one measurement: the ADC converts this "
                    "many times and returns the mean. Noise falls with roughly "
                    "the square root of the count — ×1 to ×32 is 3.7 Pa down "
                    "to 0.9 — and the time rises with the count itself, 4.8 ms "
                    "to 69. The IIR filter below buys the same quiet far more "
                    "cheaply; this knob is what you raise when you cannot "
                    "afford the lag it costs."
                ),
            },
            {
                "kind": "select",
                "command": "set_filter",
                "label": "IIR filter",
                "value": self._config.get("filter", 4),
                "options": [
                    {"value": coefficient, "label": "off" if coefficient == 0 else f"×{coefficient}"}
                    for coefficient in FILTERS
                ],
                "title": (
                    "Averaging across measurements, on the part. Much better "
                    "value than oversampling — ×1 with the filter at ×128 is "
                    "quieter than ×32 with it off, at a fourteenth of the "
                    "conversion time — because it reuses readings already "
                    "being taken. What it costs is lag: it smooths a real "
                    "climb exactly as well as it smooths noise."
                ),
            },
        ]

    def details(self) -> list[dict[str, Any]]:
        return [
            {
                "label": "Part",
                "value": f"{self._chip} · chip id "
                f"0x{[k for k, v in CHIP_IDS.items() if v == self._chip][0]:02x}",
                "title": "Checked at open — 0x76 and 0x77 are crowded addresses.",
            },
            {
                "label": "Resolution",
                "value": f"{self._config.get('resolutionPa', 0):g} Pa · "
                f"{self._config.get('measureMs', 0):g} ms per reading",
                "title": (
                    "Typical figures from datasheet tables 6 and 23, for the "
                    "oversampling currently set."
                ),
            },
            {
                "label": "Noise",
                "value": self._noise_text(),
                "title": (
                    "Typical RMS noise for this oversampling and filter pair, "
                    "from datasheet table 8, and what it is worth in height at "
                    "roughly 8.3 cm per pascal. This is the spread you will "
                    "actually see standing still — the resolution above is the "
                    "step size, which is finer and not the limit."
                ),
            },
            {
                "label": "Relative accuracy",
                "value": f"±{self.RELATIVE_ACCURACY_HPA:g} hPa · "
                f"±{self.RELATIVE_ACCURACY_HPA * METRES_PER_HPA * 100:.0f} cm",
                "title": (
                    "Between two readings close together in time, which share "
                    "their offset. This is what the datum readout measures."
                ),
            },
            {
                "label": "Absolute accuracy",
                "value": f"±{self.ABSOLUTE_ACCURACY_HPA:g} hPa · "
                f"±{self.ABSOLUTE_ACCURACY_HPA * METRES_PER_HPA:.1f} m",
                "title": (
                    "Against true pressure, before any error in the sea-level "
                    "reference — which is usually the larger of the two."
                ),
            },
        ]

    def _noise_text(self) -> str:
        oversampling = self._config.get("oversampling", 8)
        coefficient = self._config.get("filter", 0)
        noise = NOISE_PA.get(oversampling, {}).get(coefficient)
        if noise is None:
            return "—"
        bound = "<" if (oversampling, coefficient) in NOISE_IS_BOUND else ""
        # Metres per hectopascal and centimetres per pascal are the same
        # number: both sides of the ratio divide by a hundred.
        centimetres = noise * METRES_PER_HPA
        return f"{bound}{noise:g} Pa · {bound}{centimetres:.1f} cm"

    def _require(self):
        if self._sensor is None:
            raise RuntimeError("BMP3xx not started")
        return self._sensor


def compensate(
    adc_p: int,
    adc_t: int,
    temp_calib: tuple[float, ...],
    pressure_calib: tuple[float, ...],
) -> tuple[float, float]:
    """Raw counts to pascals and Celsius, per datasheet sections 9.2 and 9.3.

    Copied out of adafruit_bmp3xx rather than called, because there it is
    welded to an unbounded wait loop. Duplicated arithmetic is a liability, so
    the test suite asserts this agrees with the library on the same counts --
    that is the thing that makes the copy safe rather than the care taken
    transcribing it.
    """
    t1, t2, t3 = temp_calib
    pd1 = adc_t - t1
    pd2 = pd1 * t2
    temperature = pd2 + (pd1 * pd1) * t3

    p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11 = pressure_calib

    po1 = p5 + p6 * temperature + p7 * temperature**2.0 + p8 * temperature**3.0
    po2 = adc_p * (p1 + p2 * temperature + p3 * temperature**2.0 + p4 * temperature**3.0)
    pd4 = adc_p**2.0 * (p9 + p10 * temperature) + p11 * adc_p**3.0

    return po1 + po2 + pd4, temperature
