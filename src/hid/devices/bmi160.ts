import type { VirtualI2cDevice } from "../i2c-device.ts";

/**
 * A synthetic BMI160.
 *
 * A register file with an attitude behind it. It exists to make three things
 * reproducible that a fixed-value stub cannot produce:
 *
 * The board has a real **orientation**, so the accelerometer reports the
 * components of gravity rather than three numbers that happen to look like an
 * accelerometer. Their magnitude therefore comes to exactly one g at rest,
 * which is what makes the panel's headline check meaningful — a stub returning
 * plausible per-axis values would fail it, or pass it by accident.
 *
 * The gyroscope has a **zero-rate offset**, because that is the error the panel
 * is built around. Without one, "zero the gyro" has nothing to find and the
 * whole calibration path is untested.
 *
 * And the offset **moves with temperature**, which is the answer to why an IMU
 * carries a thermometer at all. The die self-heats after power-up; a zero
 * captured cold drifts as it warms.
 */

const REG_CHIP_ID = 0x00;
const REG_PMU_STATUS = 0x03;
const REG_GYRO_X_LSB = 0x0c;
const REG_ACC_X_LSB = 0x12;
const REG_TEMPERATURE = 0x20;
const REG_ACC_CONF = 0x40;
const REG_ACC_RANGE = 0x41;
const REG_GYRO_CONF = 0x42;
const REG_GYRO_RANGE = 0x43;
const REG_CMD = 0x7e;
const REGISTER_COUNT = 0x80;

/** The one byte the library checks before it will talk to the part. */
const CHIP_ID = 0xd1;
const CMD_SOFT_RESET = 0xb6;

const FULL_SCALE_COUNTS = 32768;
const STANDARD_GRAVITY = 9.80665;

const ACCEL_RANGES: Record<number, number> = { 0b0011: 2, 0b0101: 4, 0b1000: 8, 0b1100: 16 };
const GYRO_RANGES: Record<number, number> = {
  0b000: 2000,
  0b001: 1000,
  0b010: 500,
  0b011: 250,
  0b100: 125,
};

const TEMPERATURE_ZERO_C = 23;
const TEMPERATURE_STEP_C = 1 / 512;

/** Degrees per second of gyro offset gained per degree the die warms. */
const BIAS_DRIFT_DPS_PER_C = 0.03;
/** How far the die climbs above ambient once it has settled, and how fast. */
const SELF_HEAT_C = 4;
const WARMUP_MS = 40_000;

export interface Bmi160Options {
  address?: number;
  /** Board attitude in degrees. Gravity is resolved onto the axes from these. */
  rollDeg?: number;
  pitchDeg?: number;
  /** Angular rate actually being applied, in deg/s, before any offset. */
  rateDps?: [number, number, number];
  /** Linear acceleration on top of gravity, in g. Breaks the tilt estimate. */
  accelG?: [number, number, number];
  /** The gyro's zero-rate offset at the reference temperature, in deg/s. */
  biasDps?: [number, number, number];
  ambientC?: number;
  now?: () => number;
}

export class VirtualBmi160 implements VirtualI2cDevice {
  readonly address: number;
  readonly name = "BMI160 IMU";

  rollDeg: number;
  pitchDeg: number;
  rateDps: [number, number, number];
  accelG: [number, number, number];
  biasDps: [number, number, number];
  ambientC: number;

  readonly #registers = new Uint8Array(REGISTER_COUNT);
  readonly #now: () => number;
  readonly #poweredAt: number;
  /** Commands written to 0x7E, for tests. */
  readonly commands: number[] = [];
  #pointer = REG_CHIP_ID;

  constructor(options: Bmi160Options = {}) {
    this.address = options.address ?? 0x68;
    this.rollDeg = options.rollDeg ?? 0;
    this.pitchDeg = options.pitchDeg ?? 0;
    this.rateDps = options.rateDps ?? [0, 0, 0];
    this.accelG = options.accelG ?? [0, 0, 0];
    this.biasDps = options.biasDps ?? [0.9, -1.4, 0.6];
    this.ambientC = options.ambientC ?? 22;
    this.#now = options.now ?? (() => Date.now());
    this.#poweredAt = this.#now();

    this.#registers[REG_CHIP_ID] = CHIP_ID;
    this.#registers[REG_ACC_RANGE] = 0b0011; // ±2 g, the part's default
    this.#registers[REG_GYRO_RANGE] = 0b000; // ±2000 °/s, the part's default
    this.#registers[REG_ACC_CONF] = 0x28;
    this.#registers[REG_GYRO_CONF] = 0x28;
  }

  /** Die temperature: ambient plus self-heating that settles over a minute. */
  get dieTemperatureC(): number {
    const elapsed = this.#now() - this.#poweredAt;
    return this.ambientC + SELF_HEAT_C * (1 - Math.exp(-elapsed / WARMUP_MS));
  }

  /** The offset actually in force, which is the cold one plus thermal drift. */
  get effectiveBiasDps(): [number, number, number] {
    const warmth = this.dieTemperatureC - this.ambientC;
    return this.biasDps.map((b) => b + warmth * BIAS_DRIFT_DPS_PER_C) as [
      number,
      number,
      number,
    ];
  }

  get accelRangeG(): number {
    return ACCEL_RANGES[this.#registers[REG_ACC_RANGE] ?? 0] ?? 2;
  }

  get gyroRangeDps(): number {
    return GYRO_RANGES[this.#registers[REG_GYRO_RANGE] ?? 0] ?? 2000;
  }

  write(data: Uint8Array): void {
    const register = data[0];
    if (register === undefined) return; // address probe
    const payload = data.subarray(1);
    if (payload.length === 0) {
      this.#pointer = register;
      return;
    }
    for (let i = 0; i < payload.length; i++) {
      const at = (register + i) % REGISTER_COUNT;
      const value = payload[i] ?? 0;
      if (at === REG_CMD) {
        this.commands.push(value);
        if (value === CMD_SOFT_RESET) this.#reset();
        // The power-mode commands land in PMU_STATUS, which is what the
        // library reads back to confirm both sensors are running.
        const pmu = this.#registers[REG_PMU_STATUS] ?? 0;
        if (value === 0x11) this.#registers[REG_PMU_STATUS] = pmu | 0b0001_0000;
        if (value === 0x15) this.#registers[REG_PMU_STATUS] = pmu | 0b0000_0100;
        continue;
      }
      this.#registers[at] = value;
    }
    this.#pointer = register;
  }

  read(length: number): Uint8Array {
    const out = new Uint8Array(length);
    // Sampled once for the whole read, not per byte. The point of the burst is
    // that all six axes describe one instant; recomputing per byte would make
    // the emulator quietly forgiving of a driver that read them separately.
    const sample = this.#sample();
    for (let i = 0; i < length; i++) {
      out[i] = this.#value((this.#pointer + i) % REGISTER_COUNT, sample);
    }
    this.#pointer = (this.#pointer + length) % REGISTER_COUNT;
    return out;
  }

  #reset(): void {
    this.#registers[REG_ACC_RANGE] = 0b0011;
    this.#registers[REG_GYRO_RANGE] = 0b000;
    this.#registers[REG_PMU_STATUS] = 0;
  }

  /** Counts for all six axes plus temperature, from one instant. */
  #sample(): { accel: number[]; gyro: number[]; temperature: number } {
    const roll = (this.rollDeg * Math.PI) / 180;
    const pitch = (this.pitchDeg * Math.PI) / 180;

    // Gravity resolved onto the board's axes. Flat is +1 g on Z; the signs
    // follow the roll = atan2(y, z), pitch = atan2(-x, hypot(y, z)) convention
    // the driver recovers them with, so a round trip returns the attitude set.
    const gravity = [
      -Math.sin(pitch),
      Math.sin(roll) * Math.cos(pitch),
      Math.cos(roll) * Math.cos(pitch),
    ];

    const accelRange = this.accelRangeG;
    const gyroRange = this.gyroRangeDps;
    const bias = this.effectiveBiasDps;

    return {
      accel: gravity.map((g, axis) =>
        clampCount(((g + (this.accelG[axis] ?? 0)) / accelRange) * FULL_SCALE_COUNTS),
      ),
      gyro: this.rateDps.map((rate, axis) =>
        clampCount((((rate ?? 0) + (bias[axis] ?? 0)) / gyroRange) * FULL_SCALE_COUNTS),
      ),
      temperature: clampCount(
        (this.dieTemperatureC - TEMPERATURE_ZERO_C) / TEMPERATURE_STEP_C,
      ),
    };
  }

  #value(at: number, sample: { accel: number[]; gyro: number[]; temperature: number }): number {
    if (at >= REG_GYRO_X_LSB && at < REG_GYRO_X_LSB + 6) {
      return byteOf(sample.gyro[(at - REG_GYRO_X_LSB) >> 1] ?? 0, at & 1);
    }
    if (at >= REG_ACC_X_LSB && at < REG_ACC_X_LSB + 6) {
      return byteOf(sample.accel[(at - REG_ACC_X_LSB) >> 1] ?? 0, at & 1);
    }
    if (at === REG_TEMPERATURE || at === REG_TEMPERATURE + 1) {
      return byteOf(sample.temperature, at & 1);
    }
    return this.#registers[at] ?? 0;
  }
}

/** The signed 16-bit output saturates rather than wrapping past full scale. */
function clampCount(value: number): number {
  return Math.max(-FULL_SCALE_COUNTS, Math.min(FULL_SCALE_COUNTS - 1, Math.round(value)));
}

/** Little-endian: half 0 is the low byte. */
function byteOf(value: number, half: number): number {
  const word = value < 0 ? value + 0x10000 : value;
  return half === 0 ? word & 0xff : (word >> 8) & 0xff;
}

export { STANDARD_GRAVITY };
