import type { VirtualI2cDevice } from "../i2c-device.ts";

/**
 * A synthetic SSD1306.
 *
 * It keeps real display memory and can be asked what would be *visible*, which
 * is the only useful thing a fake display can offer. The driver's preview shows
 * what the host sent; this shows what the glass would do with it, and the gap
 * between the two is where every real fault with these modules lives.
 *
 * So it models the three things that make a panel dark or wrong while the bus
 * reports perfect success:
 *
 * The **charge pump**. These generate their own 7.5 V rail, and without command
 * 0x8D 0x14 the panel is simply black no matter what is in memory. Every write
 * still ACKs.
 *
 * The **multiplex ratio**. Rows past it are not scanned, so a 32-row module
 * driven as 64 accepts the whole buffer and shows half of it.
 *
 * And a **column offset**, which is not an SSD1306 fault at all but an SH1106
 * one: that controller has 132 columns of RAM against 128 of glass and starts
 * two in. Modules sold as SSD1306 are sometimes SH1106, and `columnOffset`
 * makes one, so the ruler pattern has something real to catch.
 */

const CONTROL_COMMAND = 0x80;
const CONTROL_DATA = 0x40;

const CMD_SET_CONTRAST = 0x81;
const CMD_ENTIRE_ON = 0xa4;
const CMD_NORM_INV = 0xa6;
const CMD_DISP_OFF = 0xae;
const CMD_DISP_ON = 0xaf;
const CMD_MEM_ADDR = 0x20;
const CMD_COL_ADDR = 0x21;
const CMD_PAGE_ADDR = 0x22;
const CMD_MUX_RATIO = 0xa8;
const CMD_CHARGE_PUMP = 0x8d;
const CMD_COM_PIN_CFG = 0xda;

/** 0x12 interleaves the COM lines; 0x02 runs them in sequence. */
const COM_ALTERNATIVE = 0x12;

/** RAM is always the controller's full 128x64 regardless of the glass. */
const RAM_COLUMNS = 132;
const RAM_PAGES = 8;

export interface Ssd1306Options {
  address?: number;
  /** Rows the glass actually has. The host cannot discover this. */
  rows?: number;
  /**
   * Columns of RAM the visible area starts at. Zero for a real SSD1306; two
   * for an SH1106 wearing its name.
   */
  columnOffset?: number;
}

export class VirtualSsd1306 implements VirtualI2cDevice {
  readonly address: number;
  readonly name = "SSD1306 OLED";

  rows: number;
  columnOffset: number;

  /** Display memory, page-major, one byte per eight vertical pixels. */
  readonly #ram = new Uint8Array(RAM_COLUMNS * RAM_PAGES);
  /** Commands seen, for tests. */
  readonly commands: number[] = [];

  #chargePump = false;
  #displayOn = false;
  #inverted = false;
  #entireOn = false;
  #contrast = 0x7f;
  #muxRatio = 63;
  #comPins = COM_ALTERNATIVE;
  #column = 0;
  #page = 0;
  #colStart = 0;
  #colEnd = 127;
  #pageStart = 0;
  #pageEnd = 7;
  #pendingArgs: number[] = [];
  #pendingCommand: number | null = null;

  constructor(options: Ssd1306Options = {}) {
    this.address = options.address ?? 0x3c;
    this.rows = options.rows ?? 64;
    this.columnOffset = options.columnOffset ?? 0;
  }

  get chargePumpOn(): boolean {
    return this.#chargePump;
  }

  get displayOn(): boolean {
    return this.#displayOn;
  }

  get contrast(): number {
    return this.#contrast;
  }

  get inverted(): boolean {
    return this.#inverted;
  }

  write(data: Uint8Array): void {
    const control = data[0];
    if (control === undefined) return; // address probe

    if (control === CONTROL_DATA) {
      for (let i = 1; i < data.length; i++) this.#writeRam(data[i] ?? 0);
      return;
    }
    // 0x80 is one command byte; the library never batches them.
    if (control === CONTROL_COMMAND) {
      for (let i = 1; i < data.length; i++) this.#command(data[i] ?? 0);
    }
  }

  read(length: number): Uint8Array {
    // The I2C interface genuinely has no read path. Returning zeroes rather
    // than throwing keeps an address probe working, which is the one thing a
    // scan does to it.
    return new Uint8Array(length);
  }

  /**
   * What the glass would show: one entry per visible pixel, row-major.
   *
   * Everything the controller can do to make memory invisible is applied here
   * -- power, charge pump, mux ratio, inversion, entire-display-on -- because a
   * fake that ignores them would let a driver that never enables the pump look
   * exactly like one that does.
   */
  visible(): Uint8Array {
    const out = new Uint8Array(128 * this.rows);
    if (!this.#displayOn || !this.#chargePump || this.#contrast === 0) return out;

    // A 32-row panel told it has 64 does not go half dark -- it interlaces.
    // The library picks the COM pin layout from the height it was given, so a
    // 32-row glass driven as 64 gets the alternative layout meant for twice as
    // many rows and shows every other line of the buffer, stretched over the
    // whole panel. That confusing doubled look, rather than a blank half, is
    // what people actually see, and the border pattern is what names it.
    const interlaced = this.#comPins === COM_ALTERNATIVE && this.rows < this.#muxRatio + 1;
    const scanned = Math.min(this.rows, this.#muxRatio + 1);

    for (let y = 0; y < scanned; y++) {
      const source = interlaced ? y * 2 : y;
      if (source >= this.#muxRatio + 1) continue;
      for (let x = 0; x < 128; x++) {
        const ramColumn = x + this.columnOffset;
        const byte = this.#ram[(source >> 3) * RAM_COLUMNS + ramColumn] ?? 0;
        let lit = (byte >> (source & 7)) & 1;
        if (this.#entireOn) lit = 1;
        if (this.#inverted) lit ^= 1;
        out[y * 128 + x] = lit;
      }
    }
    return out;
  }

  /** Convenience for tests: is any pixel lit? */
  get anythingVisible(): boolean {
    return this.visible().some((pixel) => pixel !== 0);
  }

  #writeRam(value: number): void {
    // No offset here, deliberately. The host writes columns 0..127 believing
    // they are the visible ones; it is the *glass* that starts two columns in.
    // Applying it on both sides would cancel it out and model nothing.
    const column = this.#column;
    if (column < RAM_COLUMNS && this.#page < RAM_PAGES) {
      this.#ram[this.#page * RAM_COLUMNS + column] = value;
    }
    this.#column++;
    if (this.#column > this.#colEnd) {
      this.#column = this.#colStart;
      this.#page = this.#page >= this.#pageEnd ? this.#pageStart : this.#page + 1;
    }
  }

  #command(byte: number): void {
    if (this.#pendingCommand !== null) {
      this.#pendingArgs.push(byte);
      const wanted = this.#pendingCommand === CMD_COL_ADDR || this.#pendingCommand === CMD_PAGE_ADDR ? 2 : 1;
      if (this.#pendingArgs.length < wanted) return;
      this.#apply(this.#pendingCommand, this.#pendingArgs);
      this.#pendingCommand = null;
      this.#pendingArgs = [];
      return;
    }

    this.commands.push(byte);
    if (
      byte === CMD_SET_CONTRAST ||
      byte === CMD_MEM_ADDR ||
      byte === CMD_COL_ADDR ||
      byte === CMD_PAGE_ADDR ||
      byte === CMD_MUX_RATIO ||
      byte === CMD_COM_PIN_CFG ||
      byte === CMD_CHARGE_PUMP
    ) {
      this.#pendingCommand = byte;
      this.#pendingArgs = [];
      return;
    }

    if (byte === CMD_DISP_ON) this.#displayOn = true;
    else if (byte === CMD_DISP_OFF) this.#displayOn = false;
    else if (byte === CMD_NORM_INV) this.#inverted = false;
    else if (byte === (CMD_NORM_INV | 1)) this.#inverted = true;
    else if (byte === CMD_ENTIRE_ON) this.#entireOn = false;
    else if (byte === (CMD_ENTIRE_ON | 1)) this.#entireOn = true;
    else if ((byte & 0xf0) === 0xb0) this.#page = byte & 0x07; // page addressing
  }

  #apply(command: number, args: number[]): void {
    const first = args[0] ?? 0;
    if (command === CMD_SET_CONTRAST) this.#contrast = first;
    else if (command === CMD_MUX_RATIO) this.#muxRatio = first;
    else if (command === CMD_COM_PIN_CFG) this.#comPins = first;
    // 0x14 enables the pump, 0x10 disables it. Without it the panel is dark
    // however healthy the bus looks.
    else if (command === CMD_CHARGE_PUMP) this.#chargePump = first === 0x14;
    else if (command === CMD_COL_ADDR) {
      this.#colStart = first;
      this.#colEnd = args[1] ?? 127;
      this.#column = this.#colStart;
    } else if (command === CMD_PAGE_ADDR) {
      this.#pageStart = first;
      this.#pageEnd = args[1] ?? 7;
      this.#page = this.#pageStart;
    }
  }
}
