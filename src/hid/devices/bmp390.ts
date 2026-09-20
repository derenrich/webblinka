import type { VirtualI2cDevice } from "../i2c-device.ts";

/**
 * A synthetic BMP390.
 *
 * The compensation is a cubic in temperature and a cubic in the raw pressure
 * count, with fourteen packed calibration coefficients behind it. Rather than
 * invert all of that, this part is given a calibration block whose higher-order
 * terms are zero, which leaves the library evaluating its real polynomial over
 * a straight line:
 *
 *     temperature = (adc_t - T1) * T2
 *     pressure    = adc_p * P1
 *
 * So a chosen pressure and temperature round-trip exactly, and the test that
 * asserts it is testing the parts that are mine -- one conversion per reading,
 * the altitude derivation, the datum -- rather than re-deriving Bosch's
 * polynomial and checking it agrees with itself. The coefficients are packed
 * in the datasheet's own layout, so the library's unpacking and scaling are
 * exercised for real.
 *
 * What it does model properly is the **forced-mode handshake**: a conversion is
 * triggered by a write to PWR_CTRL, the data-ready bits are clear until it
 * finishes, and `stall()` makes them never set -- which is the case the
 * library's unbounded wait loop cannot survive on its own.
 */

const REG_CHIP_ID = 0x00;
const REG_STATUS = 0x03;
const REG_PRESSURE = 0x04;
const REG_TEMPERATURE = 0x07;
const REG_PWR_CTRL = 0x1b;
const REG_OSR = 0x1c;
const REG_ODR = 0x1d;
const REG_CONFIG = 0x1f;
const REG_CAL_DATA = 0x31;
const REG_CMD = 0x7e;
const REGISTER_COUNT = 0x80;

const CHIP_ID_BMP390 = 0x60;
const CHIP_ID_BMP388 = 0x50;
const CMD_SOFT_RESET = 0xb6;

/** Both data-ready bits, which is what the library waits for. */
const STATUS_DRDY_TEMP = 0x20;
const STATUS_DRDY_PRESS = 0x40;

/** Calibration chosen so the compensation collapses to two straight lines. */
const T1 = 27000 * 256;
const T2 = 17000 / 2 ** 30;
const P1 = (29660 - 2 ** 14) / 2 ** 20;

const ADC_MAX = 0xffffff;

export interface Bmp390Options {
  address?: number;
  /** Ambient pressure in hPa. 1013.25 is standard sea level. */
  pressureHpa?: number;
  temperatureC?: number;
  /** BMP388 rather than BMP390, which differ only by chip id here. */
  bmp388?: boolean;
  /** Milliseconds a forced conversion takes. Zero keeps tests quick. */
  conversionMs?: number;
  /**
   * Peak-to-peak wander in hPa, on a slow cycle. Zero by default so tests get
   * exactly the pressure they set; the demo rig turns it on, because a trend
   * plot of a perfectly constant pressure demonstrates nothing.
   */
  wanderHpa?: number;
  now?: () => number;
}

export class VirtualBmp390 implements VirtualI2cDevice {
  readonly address: number;
  readonly name = "BMP390 barometer";

  pressureHpa: number;
  temperatureC: number;
  conversionMs: number;
  wanderHpa: number;

  readonly #registers = new Uint8Array(REGISTER_COUNT);
  readonly #now: () => number;
  /** Forced-mode triggers, for tests that count conversions. */
  conversions = 0;

  #pointer = REG_CHIP_ID;
  #triggeredAt: number | null = null;
  #stalled = false;

  constructor(options: Bmp390Options = {}) {
    this.address = options.address ?? 0x77;
    this.pressureHpa = options.pressureHpa ?? 1013.25;
    this.temperatureC = options.temperatureC ?? 21;
    this.conversionMs = options.conversionMs ?? 0;
    this.wanderHpa = options.wanderHpa ?? 0;
    this.#now = options.now ?? (() => Date.now());

    this.#registers[REG_CHIP_ID] = options.bmp388 ? CHIP_ID_BMP388 : CHIP_ID_BMP390;
    this.#registers.set(calibrationBlock(), REG_CAL_DATA);
    this.#reset();
  }

  /** Never finish a conversion, the way a part that has stopped responding
   * leaves the library's unbounded wait loop with nothing to wait for. */
  stall(stalled = true): void {
    this.#stalled = stalled;
  }

  get pressureOversampling(): number {
    return 1 << ((this.#registers[REG_OSR] ?? 0) & 0x07);
  }

  get filterCoefficient(): number {
    const bits = ((this.#registers[REG_CONFIG] ?? 0) >> 1) & 0x07;
    return bits === 0 ? 0 : 1 << bits;
  }

  write(data: Uint8Array): void {
    const register = data[0];
    if (register === undefined) return; // address probe

    const payload = data.subarray(1);
    if (payload.length === 0) {
      // The library writes the pointer and reads in a separate transaction,
      // with a STOP between, so the pointer has to survive one.
      this.#pointer = register;
      return;
    }

    for (let i = 0; i < payload.length; i++) {
      const at = (register + i) % REGISTER_COUNT;
      const value = payload[i] ?? 0;
      if (at === REG_CMD && value === CMD_SOFT_RESET) {
        this.#reset();
        continue;
      }
      this.#registers[at] = value;
      // Bit 5:4 = 01 is forced mode: one conversion, then back to sleep.
      if (at === REG_PWR_CTRL && (value & 0x30) === 0x10) this.#trigger();
    }
    this.#pointer = register;
  }

  read(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = this.#value((this.#pointer + i) % REGISTER_COUNT);
    }
    return out;
  }

  #trigger(): void {
    this.conversions++;
    this.#triggeredAt = this.#now();
  }

  #ready(): boolean {
    if (this.#stalled || this.#triggeredAt === null) return false;
    return this.#now() - this.#triggeredAt >= this.conversionMs;
  }

  #value(at: number): number {
    if (at === REG_STATUS) {
      return this.#ready() ? STATUS_DRDY_TEMP | STATUS_DRDY_PRESS : 0;
    }
    if (at >= REG_PRESSURE && at < REG_PRESSURE + 3) {
      return byteOf(this.#adcPressure(), at - REG_PRESSURE);
    }
    if (at >= REG_TEMPERATURE && at < REG_TEMPERATURE + 3) {
      return byteOf(this.#adcTemperature(), at - REG_TEMPERATURE);
    }
    return this.#registers[at] ?? 0;
  }

  /** Invert `pressure = adc_p * P1`, with pressure in pascals. */
  #adcPressure(): number {
    // Two periods that do not divide into each other, so the trace does not
    // look like the sine wave it is.
    const t = this.#now() / 1000;
    const wander =
      this.wanderHpa === 0
        ? 0
        : (this.wanderHpa / 2) *
          (0.7 * Math.sin(t / 17) + 0.3 * Math.sin(t / 6.1));
    return clampAdc(Math.round(((this.pressureHpa + wander) * 100) / P1));
  }

  /** Invert `temperature = (adc_t - T1) * T2`. */
  #adcTemperature(): number {
    return clampAdc(Math.round(T1 + this.temperatureC / T2));
  }

  #reset(): void {
    this.#registers[REG_PWR_CTRL] = 0;
    this.#registers[REG_OSR] = 0;
    this.#registers[REG_ODR] = 0;
    this.#registers[REG_CONFIG] = 0;
    this.#triggeredAt = null;
  }
}

/**
 * The 21 calibration bytes, in the datasheet's packing: `<HHbhhbbHHbbhbb`.
 * Everything but T1, T2 and P1 is zero, which is what makes the compensation
 * invertible without reproducing it.
 */
function calibrationBlock(): Uint8Array {
  const block = new Uint8Array(21);
  const view = new DataView(block.buffer);
  view.setUint16(0, 27000, true); // T1
  view.setUint16(2, 17000, true); // T2
  view.setInt8(4, 0); //            T3
  view.setInt16(5, 29660, true); // P1
  view.setInt16(7, 2 ** 14, true); // P2 -> exactly zero after scaling
  // P3 through P11 are already zero.
  return block;
}

/** The data registers are 24-bit, little-endian, unsigned. */
function byteOf(value: number, index: number): number {
  return (value >> (index * 8)) & 0xff;
}

function clampAdc(value: number): number {
  return Math.max(0, Math.min(ADC_MAX, value));
}
