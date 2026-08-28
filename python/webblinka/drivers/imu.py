"""Shared ground for accelerometers, gyroscopes and the parts that carry both.

Every IMU reports the same shapes -- three axes of specific force, three of
angular rate, sometimes three of field -- and invites the same derivations, so
the physics lives here once and a driver supplies only what is particular to
its silicon: how to take one atomic reading, what ranges it has, and which
knobs it offers.

Three things this base exists to get right, none of which a per-axis readout
shows you on its own.

**A vector has to be sampled at one instant.** The obvious implementation reads
X, then Y, then Z. Over a bus like this one -- I2C tunnelled through USB HID,
where every transaction is a round trip of a few milliseconds -- those three
numbers can be ten milliseconds apart, and while the board is turning they
describe three different orientations. Each component looks perfectly
reasonable; only the magnitude gives it away, and only if you happen to be
watching it. Every part here lays its axes out in consecutive registers
precisely so they can be read in one burst, and drivers are expected to do
that.

**A gyroscope at rest does not read zero.** The zero-rate offset is the
dominant error in every one of these parts, and it is the reason dead reckoning
from a gyro walks away from the truth. Reporting degrees per second and
stopping there hides it completely: a stationary sensor showing 1.2 deg/s looks
like a small honest reading rather than what it is, a bias that will swing an
estimated heading right round the compass in five minutes. So the offset is
measured, subtracted, and -- more usefully -- quoted as the heading error it
would cause per minute if it were not.

**An accelerometer at rest reads one g, not zero.** That makes the magnitude a
free and continuous check on the whole chain: at rest it must come to 1.000 g,
and if it does not, either the part is moving or the scaling is wrong. It is
also the precondition for the tilt angles, which are recovered from the
direction of gravity and mean nothing while the sensor is accelerating.
"""

from __future__ import annotations

import math
import time
from typing import Any

from .base import Driver

#: One standard gravity, in m/s^2. The definition, not a measurement.
STANDARD_GRAVITY = 9.80665

#: How far the acceleration magnitude may sit from 1 g before the sensor is
#: taken to be moving rather than merely tilted. Comfortably above these parts'
#: noise and well below the acceleration of anything being waved about.
STILL_ACCEL_TOLERANCE_G = 0.06

#: And how much residual rotation still counts as stationary, in deg/s. Above a
#: couple of degrees a second the board is being turned, not held.
STILL_GYRO_TOLERANCE_DPS = 2.5

#: Samples averaged when capturing the gyro's zero-rate offset, and the gap
#: between them. Long enough to average down the noise, short enough that
#: nobody has to hold the board still for an awkward length of time.
ZERO_SAMPLES = 24
ZERO_INTERVAL_S = 0.01


class Motion:
    """One atomic reading: three axes of each sensor, plus the die temperature.

    Accelerations are in m/s^2 and rates in degrees per second, which is what
    the CircuitPython convention asks for. Constructed from a single burst read
    -- if the axes here came from separate transactions the whole point of the
    type is lost.
    """

    def __init__(
        self,
        accel: tuple[float, float, float],
        gyro: tuple[float, float, float],
        temperature_c: float | None = None,
    ) -> None:
        self.accel = accel
        self.gyro = gyro
        self.temperature_c = temperature_c


class Imu(Driver):
    """Base for inertial measurement units."""

    LABEL = "IMU"

    #: Why this part carries a thermometer. Not decoration: on every one of
    #: these it is a die temperature in service of the gyro, and saying so
    #: stops anyone reading it as room temperature.
    TEMPERATURE_NOTE = ""

    def __init__(self, bus, address: int) -> None:
        super().__init__(bus, address)
        self._gyro_bias = (0.0, 0.0, 0.0)
        self._zeroed_at_c: float | None = None

    # -- what a subclass supplies -----------------------------------------

    def read_motion(self) -> Motion:
        """One atomic reading. Must be a single burst, not three transactions."""
        raise NotImplementedError

    def ranges(self) -> dict[str, float]:
        """Full scale currently selected: ``accelG`` and ``gyroDps``."""
        raise NotImplementedError

    def controls(self) -> list[dict[str, Any]]:
        """Knobs this part has, rendered by the panel without knowing the part."""
        return []

    def details(self) -> list[dict[str, Any]]:
        """Extra rows worth showing: identity, power mode, whatever it offers."""
        return []

    # -- the shared work ---------------------------------------------------

    def command(self, name: str, args: list[Any]) -> Any:
        if name == "zero_gyro":
            return self.zero_gyro()
        if name == "clear_zero":
            self._gyro_bias = (0.0, 0.0, 0.0)
            self._zeroed_at_c = None
            return self.poll()
        return super().command(name, args)

    def zero_gyro(self) -> dict[str, Any]:
        """Average the gyro while the board is still, and call that zero.

        Only meaningful if it really is still, so the samples are checked as
        they are taken rather than trusted: a capture made while the board is
        moving would bake that movement in as the offset and every later
        reading would be wrong by it, silently and permanently.
        """
        samples: list[tuple[float, float, float]] = []
        temperatures: list[float] = []
        moved = False

        for index in range(ZERO_SAMPLES):
            motion = self.read_motion()
            if not _is_still(motion.accel, motion.gyro, self._gyro_bias):
                moved = True
                break
            samples.append(motion.gyro)
            if motion.temperature_c is not None:
                temperatures.append(motion.temperature_c)
            if index < ZERO_SAMPLES - 1:
                time.sleep(ZERO_INTERVAL_S)

        if moved or not samples:
            reading = self.poll()
            reading["zeroResult"] = {
                "ok": False,
                "text": "Moved during the capture — hold the board still and try again.",
            }
            return reading

        self._gyro_bias = tuple(
            sum(sample[axis] for sample in samples) / len(samples) for axis in range(3)
        )
        # Recorded because the offset this just measured is only the offset at
        # this temperature. The part warms up, and the number goes stale.
        self._zeroed_at_c = sum(temperatures) / len(temperatures) if temperatures else None

        reading = self.poll()
        reading["zeroResult"] = {
            "ok": True,
            "text": f"Zeroed over {len(samples)} samples.",
        }
        return reading

    def poll(self) -> dict[str, Any]:
        motion = self.read_motion()
        ranges = self.ranges()

        accel_g = tuple(component / STANDARD_GRAVITY for component in motion.accel)
        accel_magnitude_g = _magnitude(accel_g)

        corrected = tuple(
            motion.gyro[axis] - self._gyro_bias[axis] for axis in range(3)
        )
        gyro_magnitude = _magnitude(corrected)
        still = _is_still(motion.accel, motion.gyro, self._gyro_bias)

        # What the offset actually costs, which degrees per second does not
        # convey. A tenth of a degree a second is six degrees a minute: an hour
        # of that and the estimated heading has gone right round and come back.
        residual = _magnitude(corrected) if still else None

        return {
            "label": self.LABEL,
            "groups": [
                {
                    "key": "accel",
                    "label": "Acceleration",
                    "unit": "g",
                    "range": ranges["accelG"],
                    "axes": [
                        {"axis": axis, "value": value}
                        for axis, value in zip("XYZ", accel_g)
                    ],
                    "magnitude": accel_magnitude_g,
                    "magnitudeLabel": "Magnitude",
                    # At rest this has to come to one g, because gravity does
                    # not switch off. It is the only continuous check there is
                    # that the axes were sampled together and scaled right.
                    "expected": 1.0,
                },
                {
                    "key": "gyro",
                    "label": "Rotation",
                    "unit": "°/s",
                    "range": ranges["gyroDps"],
                    "axes": [
                        {"axis": axis, "value": value}
                        for axis, value in zip("XYZ", corrected)
                    ],
                    "magnitude": gyro_magnitude,
                    "magnitudeLabel": "Rate",
                    "expected": 0.0,
                },
            ],
            "accelG": list(accel_g),
            "accelMagnitudeG": accel_magnitude_g,
            "gyroDps": list(corrected),
            "gyroRawDps": list(motion.gyro),
            "gyroBiasDps": list(self._gyro_bias),
            "gyroMagnitudeDps": gyro_magnitude,
            "biasMagnitudeDps": _magnitude(self._gyro_bias),
            "zeroed": self._zeroed_at_c is not None or any(self._gyro_bias),
            "zeroedAtC": self._zeroed_at_c,
            "still": still,
            "tilt": _tilt(accel_g, accel_magnitude_g),
            # Degrees of heading a dead-reckoned estimate would lose per minute
            # to the offset that is still there. Before zeroing this is the
            # whole of it; after, it is what the averaging could not remove.
            "headingDriftDegPerMin": None if residual is None else residual * 60,
            "temperatureC": motion.temperature_c,
            "temperatureNote": self.TEMPERATURE_NOTE,
            "controls": self.controls(),
            "details": self.details(),
        }


def _magnitude(vector: tuple[float, float, float] | list[float]) -> float:
    return math.sqrt(sum(component * component for component in vector))


def _is_still(
    accel: tuple[float, float, float],
    gyro: tuple[float, float, float],
    bias: tuple[float, float, float],
) -> bool:
    """Whether the board is sitting still, by both sensors at once.

    Both, because either alone is fooled. A gyro reads zero in free fall and in
    any constant-velocity motion; an accelerometer reads exactly one g while
    being spun about the gravity vector. Together they are hard to fool by
    accident.
    """
    accel_g = _magnitude(accel) / STANDARD_GRAVITY
    corrected = tuple(gyro[axis] - bias[axis] for axis in range(3))
    return (
        abs(accel_g - 1.0) < STILL_ACCEL_TOLERANCE_G
        and _magnitude(corrected) < STILL_GYRO_TOLERANCE_DPS
    )


def _tilt(accel_g: tuple[float, float, float], magnitude_g: float) -> dict[str, Any]:
    """Roll and pitch, recovered from the direction of gravity.

    Only from the accelerometer, which means it is only true while the sensor
    is not accelerating: the part cannot tell gravity from any other specific
    force, so a board being pushed sideways reports itself as tilted. The
    magnitude says which case you are in, so it is returned alongside and the
    panel greys the angles when it strays from one g.

    Yaw is deliberately absent. It cannot be recovered this way at all --
    rotating about the gravity vector leaves every accelerometer axis unchanged
    -- and it wants a magnetometer or an integrated gyro, neither of which is
    an angle this function could honestly return.
    """
    x, y, z = accel_g
    usable = abs(magnitude_g - 1.0) < STILL_ACCEL_TOLERANCE_G
    return {
        "rollDeg": math.degrees(math.atan2(y, z)),
        "pitchDeg": math.degrees(math.atan2(-x, math.sqrt(y * y + z * z))),
        "usable": usable,
        "text": (
            ""
            if usable
            else "Accelerating — these angles are the direction of the total "
            "force, not of gravity."
        ),
    }
