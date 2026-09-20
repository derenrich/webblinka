"""Shared ground for barometric pressure sensors.

Every part of this kind reports the same two numbers and invites the same
derived one, so the physics lives here once and a driver supplies only how to
take a reading and which knobs its silicon has.

**Altitude is not measured.** It is inferred from pressure through a model
atmosphere, and the model needs to be told what the pressure is at sea level
right now. That reference is weather, not geography: it swings by some thirty
hectopascals between a deep low and a strong high, and at roughly 8.3 metres
per hectopascal near sea level that is about 250 metres of apparent altitude
from weather alone. A barometric altimeter reading "112 m" without a current
sea-level reference is not accurate to the metre it prints; it is not
necessarily accurate to the hundred.

**What these parts are genuinely extraordinary at is the difference.** Bosch
quote the BMP390's *relative* accuracy as +/-0.03 hPa, which is +/-25 cm, against
an *absolute* accuracy of +/-0.50 hPa, which is about four metres before the
reference error is even counted. Two readings minutes apart share their offset,
so it cancels: the part cannot tell you where you are, and can tell you that
you climbed 40 cm.

So the panel leads with height above a datum you set, and shows absolute
altitude as the qualified estimate it is. That is the difference between a
number that is impressive and a number that is true.
"""

from __future__ import annotations

import time
from collections import deque
from typing import Any

from .base import Driver

#: Standard sea-level pressure. A definition, and a starting guess -- the real
#: figure where you are is on any aviation or weather site as the QNH.
STANDARD_SEA_LEVEL_HPA = 1013.25

#: The hypsometric relation for the international standard atmosphere, in the
#: form the US National Weather Service publishes it.
ALTITUDE_SCALE_M = 44307.7
ALTITUDE_EXPONENT = 0.190284

#: Near sea level, how much altitude one hectopascal is worth. Only used for
#: explaining an error budget in metres; the real conversion is above.
METRES_PER_HPA = 8.3

#: How much of the recent past the trend keeps, and how far apart its samples
#: are. Pressure moves slowly -- a weather system takes hours -- so this is for
#: seeing the sensor respond to a lift or a stairwell, not for meteorology.
TREND_SAMPLES = 180
TREND_INTERVAL_S = 0.5


def pressure_altitude(pressure_hpa: float, reference_hpa: float) -> float:
    """Height above the level where the pressure would be ``reference_hpa``."""
    if pressure_hpa <= 0 or reference_hpa <= 0:
        return 0.0
    return ALTITUDE_SCALE_M * (1 - (pressure_hpa / reference_hpa) ** ALTITUDE_EXPONENT)


class Barometer(Driver):
    """Base for pressure and temperature sensors."""

    LABEL = "Barometer"

    #: Bosch's own figures, per part, in hPa. The relative one is what the
    #: datum readout is good for; the absolute one bounds everything else.
    RELATIVE_ACCURACY_HPA = 0.03
    ABSOLUTE_ACCURACY_HPA = 0.5

    def __init__(self, bus, address: int) -> None:
        super().__init__(bus, address)
        self._sea_level_hpa = STANDARD_SEA_LEVEL_HPA
        self._datum_hpa: float | None = None
        self._datum_at: float | None = None
        self._trend: deque[tuple[float, float]] = deque(maxlen=TREND_SAMPLES)
        self._last_trend_at = 0.0

    # -- what a subclass supplies -----------------------------------------

    def read(self) -> tuple[float, float]:
        """Pressure in hPa and temperature in Celsius, from ONE conversion.

        One, because the compensated pressure is a function of the temperature
        measured alongside it. Read the two through separate conversions --
        which is what the obvious property access does on every library of this
        kind -- and the pressure returned was corrected using a temperature the
        caller never saw, taken at a different moment.
        """
        raise NotImplementedError

    def controls(self) -> list[dict[str, Any]]:
        return []

    def details(self) -> list[dict[str, Any]]:
        return []

    # -- the shared work ---------------------------------------------------

    def command(self, name: str, args: list[Any]) -> Any:
        if name == "set_datum":
            pressure, _ = self.read()
            self._datum_hpa = pressure
            self._datum_at = time.monotonic()
            return self.poll()
        if name == "clear_datum":
            self._datum_hpa = None
            self._datum_at = None
            return self.poll()
        if name == "set_sea_level":
            self._sea_level_hpa = float(args[0])
            return self.poll()
        return super().command(name, args)

    def poll(self) -> dict[str, Any]:
        pressure_hpa, temperature_c = self.read()

        now = time.monotonic()
        if now - self._last_trend_at >= TREND_INTERVAL_S:
            self._trend.append((now, pressure_hpa))
            self._last_trend_at = now

        relative_m = (
            None
            if self._datum_hpa is None
            else pressure_altitude(pressure_hpa, self._datum_hpa)
        )

        return {
            "label": self.LABEL,
            "pressureHpa": pressure_hpa,
            "temperatureC": temperature_c,
            "temperatureF": temperature_c * 9 / 5 + 32,
            "seaLevelHpa": self._sea_level_hpa,
            "altitudeM": pressure_altitude(pressure_hpa, self._sea_level_hpa),
            "datumHpa": self._datum_hpa,
            "datumAgeS": None if self._datum_at is None else now - self._datum_at,
            "relativeM": relative_m,
            # The two error bars, in the units the panel shows each number in.
            # Quoted from the part rather than assumed, because the whole point
            # of the datum is that one of them is twenty times smaller.
            "relativeAccuracyM": self.RELATIVE_ACCURACY_HPA * METRES_PER_HPA,
            "absoluteAccuracyM": self.ABSOLUTE_ACCURACY_HPA * METRES_PER_HPA,
            "trend": [
                {"age": now - at, "pressureHpa": value} for at, value in self._trend
            ],
            "controls": self.controls(),
            "details": self.details(),
        }
