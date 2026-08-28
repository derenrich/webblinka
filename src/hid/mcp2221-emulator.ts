import { NackError, type VirtualI2cDevice } from "./i2c-device.ts";

/**
 * A software MCP2221 speaking the same 64-byte HID command protocol as the real
 * chip. It exists for two reasons: the Node test suite can exercise the entire
 * stack -- stock Blinka, the hid shim, JSPI, the RPC layer -- with no hardware
 * attached, and visitors without an adapter still get a working site.
 *
 * Command numbering and report layout follow the MCP2221 datasheet, but the
 * authority on what actually has to be right is Blinka's driver: every field
 * populated below is one that adafruit_blinka/microcontroller/mcp2221/mcp2221.py
 * reads. Fields it ignores are left zero rather than faked.
 */

// Commands.
const CMD_STATUS = 0x10;
const CMD_SET_GPIO = 0x50;
const CMD_GET_GPIO = 0x51;
const CMD_SET_SRAM = 0x60;
const CMD_GET_SRAM = 0x61;
const CMD_RESET = 0x70;
const CMD_READ_FLASH = 0xb0;
const CMD_I2C_READ_DATA = 0x40;
const CMD_I2C_WRITE = 0x90;
const CMD_I2C_READ = 0x91;
const CMD_I2C_WRITE_REPEATED = 0x92;
const CMD_I2C_READ_REPEATED = 0x93;
const CMD_I2C_WRITE_NOSTOP = 0x94;

// I2C engine states, as reported in status byte 8.
const STATE_IDLE = 0x00;
const STATE_ADDR_NACK = 0x25;
const STATE_WRITING_NO_STOP = 0x45;
/** Trying to issue a STOP. Sticks here when a device is holding the bus. */
const STATE_STOP = 0x60;
/** A STOP that never completed. */
const STATE_STOP_TIMEOUT = 0x62;

// Status byte 20 flags, and Get-I2C-Data result codes.
const FLAG_ADDR_NACK = 0x40;
const READ_COMPLETE = 0x55;

const REPORT_SIZE = 64;
const MAX_I2C_CHUNK = 60;

/** GP pin designations, matching MCP2221.GP_* in Blinka. */
export const GP_GPIO = 0b000;
export const GP_DEDICATED = 0b001;
export const GP_ALT0 = 0b010; // ADC
export const GP_ALT1 = 0b011; // DAC
export const GP_ALT2 = 0b100; // interrupt detection, GP1 only

// Read Flash Data sub-commands. Only the read side exists here; webblinka never
// writes flash, so neither does its emulator.
const FLASH_CHIP_SETTINGS = 0x00;
const FLASH_USB_MANUFACTURER = 0x02;
const FLASH_USB_PRODUCT = 0x03;
const FLASH_USB_SERIAL = 0x04;
const FLASH_FACTORY_SERIAL = 0x05;

const USB_STRING_DESCRIPTOR_TYPE = 0x03;

/** What a stock MCP2221A reports about itself, for demo mode to have content. */
const IDENTITY = {
  manufacturer: "Microchip Technology Inc.",
  product: "MCP2221 USB-I2C/UART Combo",
  serialNumber: "0001020304",
  factorySerialNumber: "01234567",
  vendorId: 0x04d8,
  productId: 0x00dd,
  /** Bit 6 self-powered, bit 5 remote wake. Bus-powered with remote wake. */
  powerAttributes: 0x20,
  /** Reported in 2 mA units, so 100 mA. */
  mAUnits: 50,
  hardwareRevision: "A6",
  firmwareRevision: "12",
};

interface GpPin {
  mode: number;
  /** 1 = input, 0 = output, as Blinka's gpio_set_direction uses it. */
  direction: number;
  value: number;
}

interface PendingWrite {
  address: number;
  total: number;
  bytes: number[];
}

interface PendingRead {
  data: Uint8Array;
  offset: number;
  nacked: boolean;
}

export class Mcp2221Emulator {
  readonly #pins: GpPin[] = Array.from({ length: 4 }, () => ({
    mode: GP_GPIO,
    direction: 1,
    value: 0,
  }));
  readonly #bus = new Map<number, VirtualI2cDevice>();
  #adc: [number, number, number] = [0, 0, 0];
  #dac = 0;
  #clockDivider = 0x75; // ~100 kHz
  /**
   * Status polls a cancel takes to reach idle. Zero matches a chip that is
   * never asked to cancel mid-transfer; raise it to reproduce the window where
   * a command issued too soon after a cancel is rejected as busy.
   */
  cancelLatency = 0;
  /**
   * Whether asking to cancel again, while one is already winding down, restarts
   * the wind-down. Releasing the bus goes through a STOP, so a chip that behaves
   * this way can be held in that state forever by a poll loop that re-sends the
   * cancel each time. Defaulted on because it is the pessimistic assumption and
   * code that only works against the forgiving chip is code that breaks on real
   * hardware -- which is exactly what happened.
   */
  cancelRestartsOnRepeat = true;
  /**
   * Whether cancelling an already-idle engine leaves it reporting a stop
   * timeout. Also defaulted on, and for the same reason: assuming the chip
   * forgives a pointless command is how you ship one.
   */
  stopTimeoutOnSpuriousCancel = true;
  /** Test hook: every address a write command targets, and its payload length. */
  onProbe: ((address: number, length: number) => void) | null = null;
  #cancelPending = 0;
  #wedged = false;
  #stallAfterWrite: number | null = null;
  #justSettled = false;
  #linesLow = false;
  #i2cState = STATE_IDLE;
  #addrNacked = false;
  #write: PendingWrite | null = null;
  #read: PendingRead | null = null;

  // SRAM configuration bytes, in the packing the Get SRAM response uses.
  #chipByte = 0b1111_0000; // CDC enumeration + all three LEDs, unsecured
  #clockByte = (0b10 << 3) | 0b101; // 50% duty at 1.5 MHz
  #dacByte = (0b01 << 6) | (0b1 << 5); // 1.024 V from Vrm, value 0
  #adcByte = (0b01 << 3) | (0b1 << 2); // 1.024 V from Vrm, no interrupt edges
  #interruptDetected = false;

  attach(device: VirtualI2cDevice): void {
    for (const address of device.addresses ?? [device.address]) {
      this.#bus.set(address, device);
    }
  }

  get devices(): VirtualI2cDevice[] {
    // Deduplicated: a part spanning several addresses is still one part.
    return [...new Set(this.#bus.values())];
  }

  /** Drive an ADC channel (0 = GP1, 1 = GP2, 2 = GP3) with a 10-bit value. */
  setAdc(channel: 0 | 1 | 2, value: number): void {
    this.#adc[channel] = Math.max(0, Math.min(0x3ff, Math.round(value)));
  }

  /** Last value written to the 5-bit DAC. */
  get dac(): number {
    return this.#dac;
  }

  pinState(pin: number): Readonly<GpPin> {
    const state = this.#pins[pin];
    if (!state) throw new RangeError(`no GP${pin}`);
    return state;
  }

  /** Handle one 64-byte command report. Returns the reply, or null for a reset. */
  handle(report: Uint8Array): Uint8Array | null {
    const command = report[0] ?? 0;
    if (command === CMD_RESET) {
      this.#resetState();
      return null;
    }

    // A cancel in flight winds down as time passes, which here means as
    // commands go by -- independently of what those commands are asking for.
    this.#justSettled = false;
    if (this.#cancelPending > 0 && --this.#cancelPending === 0) {
      this.#settle();
      this.#justSettled = true;
    }

    const reply = new Uint8Array(REPORT_SIZE);
    reply[0] = command;
    reply[1] = 0x00;

    switch (command) {
      case CMD_STATUS:
        this.#status(report, reply);
        break;
      case CMD_SET_GPIO:
        this.#setGpio(report, reply);
        break;
      case CMD_GET_GPIO:
        this.#getGpio(reply);
        break;
      case CMD_SET_SRAM:
        this.#setSram(report);
        break;
      case CMD_GET_SRAM:
        this.#getSram(reply);
        break;
      case CMD_I2C_WRITE:
      case CMD_I2C_WRITE_REPEATED:
      case CMD_I2C_WRITE_NOSTOP:
        this.#i2cWrite(command, report, reply);
        break;
      case CMD_I2C_READ:
      case CMD_I2C_READ_REPEATED:
        this.#i2cRead(report, reply);
        break;
      case CMD_I2C_READ_DATA:
        this.#i2cGetData(reply);
        break;
      case CMD_READ_FLASH:
        this.#readFlash(report[1] ?? 0, reply);
        break;
      default:
        reply[1] = 0x01; // unsupported command
        break;
    }
    return reply;
  }

  // ------------------------------------------------------------- 0x10 status

  #status(report: Uint8Array, reply: Uint8Array): void {
    if (report[2] === 0x10) {
      const busy = this.#i2cState !== STATE_IDLE || this.#write !== null || this.#read !== null;
      // A cancel is a request, not an instruction the engine obeys at once: the
      // datasheet gives it "a few hundred microseconds" to release the bus.
      // cancelLatency models that, because a chip that cancels instantly hides
      // the exact bug this emulator exists to catch. Asking again while one is
      // already in flight does not restart the wind-down -- the engine runs on
      // its own clock, not on how often it is polled.
      if (!busy) {
        // Cancelling means driving a STOP, and an idle engine has no
        // transaction for that STOP to terminate. On an empty bus it never
        // completes, so a chip that was fine now reports a stop timeout -- the
        // fault entirely manufactured by asking.
        //
        // Unless the engine reached idle by finishing the cancel we already
        // asked for, in the very command carrying this one. Then it is
        // completing a real request, not being handed a pointless second one.
        if (this.stopTimeoutOnSpuriousCancel && !this.#justSettled) {
          this.#i2cState = STATE_STOP_TIMEOUT;
        } else {
          this.#settle();
        }
      } else if (this.#cancelPending === 0 || this.cancelRestartsOnRepeat) {
        if (this.cancelLatency > 0) this.#cancelPending = this.cancelLatency;
        else this.#settle();
      }
      // 0x10 means "marked for cancellation", 0x11 that it is already idle.
      reply[2] = this.#cancelPending > 0 ? 0x10 : 0x11;
    }
    if (report[3] === 0x20) {
      if (this.#cancelPending > 0) {
        reply[3] = 0x00; // the divider is only accepted while idle
      } else {
        this.#clockDivider = report[4] ?? this.#clockDivider;
        reply[3] = 0x20; // divider accepted
      }
    }

    reply[8] = this.#i2cState;
    const total = this.#write?.total ?? 0;
    const done = this.#write?.bytes.length ?? 0;
    reply[9] = total & 0xff;
    reply[10] = (total >> 8) & 0xff;
    reply[11] = done & 0xff;
    reply[12] = (done >> 8) & 0xff;
    reply[13] = done & 0xff; // data buffer counter
    reply[14] = this.#clockDivider;
    reply[15] = 0x0a; // I2C timeout, ms
    reply[16] = (this.#write?.address ?? 0) << 1;
    reply[20] = this.#addrNacked ? FLAG_ADDR_NACK : 0x00;
    reply[21] = 0x01; // I2C engine initialised
    // Both high is a free bus. A device holding either one low is the case a
    // chip reset cannot fix, and the reason webblinka reports the levels.
    reply[22] = this.#linesLow ? 0 : 1; // SCL
    reply[23] = this.#linesLow ? 0 : 1; // SDA
    reply[24] = this.#interruptDetected ? 1 : 0;

    // Hardware and firmware revision, four ASCII bytes.
    for (let i = 0; i < 2; i++) {
      reply[46 + i] = IDENTITY.hardwareRevision.charCodeAt(i);
      reply[48 + i] = IDENTITY.firmwareRevision.charCodeAt(i);
    }

    // ADC channels 0..2 sit at bytes 50/51, 52/53, 54/55 -- Blinka reads them as
    // resp[49 + 2*pin] << 8 | resp[48 + 2*pin] for GP1..GP3.
    for (let channel = 0; channel < 3; channel++) {
      const value = this.#adc[channel] ?? 0;
      reply[50 + 2 * channel] = value & 0xff;
      reply[51 + 2 * channel] = (value >> 8) & 0xff;
    }
  }

  // --------------------------------------------------------------- 0x50/0x51

  #setGpio(report: Uint8Array, reply: Uint8Array): void {
    for (let pin = 0; pin < 4; pin++) {
      const state = this.#pins[pin]!;
      // Each pin owns a four-byte block: [alter value, value, alter dir, dir].
      if (report[2 + 4 * pin] === 0x01) state.value = report[3 + 4 * pin] ?? 0;
      if (report[4 + 4 * pin] === 0x01) state.direction = report[5 + 4 * pin] ?? 1;
      const gpio = state.mode === GP_GPIO;
      reply[2 + 4 * pin] = gpio ? state.value : 0xee;
      reply[4 + 4 * pin] = gpio ? state.direction : 0xee;
    }
  }

  #getGpio(reply: Uint8Array): void {
    for (let pin = 0; pin < 4; pin++) {
      const state = this.#pins[pin]!;
      const gpio = state.mode === GP_GPIO;
      reply[2 + 2 * pin] = gpio ? state.value : 0xee;
      reply[3 + 2 * pin] = gpio ? state.direction : 0xee;
    }
  }

  // --------------------------------------------------------------- 0x60/0x61

  /**
   * Every field of Set SRAM is skipped unless its high "alter" bit is set,
   * which is what lets callers change one setting without disturbing the rest.
   */
  #setSram(report: Uint8Array): void {
    const clock = report[2] ?? 0;
    const dacRef = report[3] ?? 0;
    const dacValue = report[4] ?? 0;
    const adcRef = report[5] ?? 0;
    const interrupt = report[6] ?? 0;

    if (clock & 0x80) this.#clockByte = clock & 0b0001_1111;
    if (dacRef & 0x80) {
      // The Set command packs the DAC reference as (voltage << 1) | option,
      // while the Get response reports voltage at bits 6-7 and option at bit 5.
      // The two layouts are not symmetric; the datasheet is like that.
      const voltage = (dacRef >> 1) & 0b11;
      const option = dacRef & 0b1;
      this.#dacByte = (voltage << 6) | (option << 5) | (this.#dacByte & 0b11111);
    }
    if (dacValue & 0x80) {
      this.#dac = dacValue & 0b11111;
      this.#dacByte = (this.#dacByte & ~0b11111) | this.#dac;
    }
    if (adcRef & 0x80) {
      const voltage = (adcRef >> 1) & 0b11;
      const option = adcRef & 0b1;
      this.#adcByte = (this.#adcByte & 0b0110_0000) | (voltage << 3) | (option << 2);
    }
    if (interrupt & 0x80) {
      if (interrupt & 0b1) this.#interruptDetected = false; // clear the latch
      const edgeBits = (interrupt >> 1) & 0b1111;
      if (edgeBits & 0b1000) {
        const positive = (edgeBits & 0b0100) !== 0;
        const negative = (edgeBits & 0b0001) !== 0;
        this.#adcByte =
          (this.#adcByte & ~0b0110_0000) | (Number(negative) << 6) | (Number(positive) << 5);
      }
    }
    if ((report[7] ?? 0) & 0x80) {
      for (let pin = 0; pin < 4; pin++) {
        const byte = report[8 + pin] ?? 0;
        const state = this.#pins[pin]!;
        state.mode = byte & 0b111;
        state.direction = (byte >> 3) & 0b1;
        state.value = (byte >> 4) & 0b1;
      }
    }
  }

  #getSram(reply: Uint8Array): void {
    reply[2] = 18; // chip settings length
    reply[3] = 4; // GP settings length
    reply[4] = this.#chipByte;
    reply[5] = this.#clockByte;
    reply[6] = this.#dacByte;
    reply[7] = this.#adcByte;
    reply[8] = IDENTITY.vendorId & 0xff;
    reply[9] = (IDENTITY.vendorId >> 8) & 0xff;
    reply[10] = IDENTITY.productId & 0xff;
    reply[11] = (IDENTITY.productId >> 8) & 0xff;
    reply[12] = IDENTITY.powerAttributes;
    reply[13] = IDENTITY.mAUnits;
    // Bytes 14-21 are the currently supplied access password; left zeroed.
    for (let pin = 0; pin < 4; pin++) {
      const state = this.#pins[pin]!;
      reply[22 + pin] = state.mode | (state.direction << 3) | (state.value << 4);
    }
  }

  // -------------------------------------------------------------- 0xB0 flash

  #readFlash(subCommand: number, reply: Uint8Array): void {
    switch (subCommand) {
      case FLASH_CHIP_SETTINGS:
        reply[2] = 10;
        reply[4] = this.#chipByte;
        reply[5] = this.#clockByte;
        reply[6] = this.#dacByte;
        reply[7] = this.#adcByte;
        reply[8] = IDENTITY.vendorId & 0xff;
        reply[9] = (IDENTITY.vendorId >> 8) & 0xff;
        reply[10] = IDENTITY.productId & 0xff;
        reply[11] = (IDENTITY.productId >> 8) & 0xff;
        reply[12] = IDENTITY.powerAttributes;
        reply[13] = IDENTITY.mAUnits;
        return;
      case FLASH_USB_MANUFACTURER:
        writeUsbString(reply, IDENTITY.manufacturer);
        return;
      case FLASH_USB_PRODUCT:
        writeUsbString(reply, IDENTITY.product);
        return;
      case FLASH_USB_SERIAL:
        writeUsbString(reply, IDENTITY.serialNumber);
        return;
      case FLASH_FACTORY_SERIAL: {
        // The factory serial is plain ASCII, unlike the USB string descriptors.
        const text = IDENTITY.factorySerialNumber;
        reply[2] = text.length;
        for (let i = 0; i < text.length; i++) reply[4 + i] = text.charCodeAt(i);
        return;
      }
      default:
        reply[1] = 0x01; // unsupported sub-command
    }
  }

  // ------------------------------------------------------------------- I2C

  #i2cWrite(command: number, report: Uint8Array, reply: Uint8Array): void {
    const total = (report[1] ?? 0) | ((report[2] ?? 0) << 8);
    const address = (report[3] ?? 0) >> 1;
    this.onProbe?.(address, total);

    if (this.#cancelPending > 0) {
      // The engine has not finished winding down from a cancel. It rejects the
      // command and echoes the state it is still in -- which is what Blinka
      // reads as "Unrecoverable I2C state failure".
      reply[1] = 0x01;
      reply[2] = this.#i2cState;
      return;
    }

    if (!this.#bus.has(address)) {
      // Real hardware accepts the command and reports the NACK in the status
      // register afterwards; Blinka's i2c_scan depends on exactly that ordering.
      this.#addrNacked = true;
      this.#i2cState = STATE_ADDR_NACK;
      this.#write = null;
      return;
    }

    this.#addrNacked = false;
    if (!this.#write || this.#write.address !== address || this.#write.total !== total) {
      this.#write = { address, total, bytes: [] };
    }
    const remaining = total - this.#write.bytes.length;
    const size = Math.min(remaining, MAX_I2C_CHUNK);
    for (let i = 0; i < size; i++) this.#write.bytes.push(report[4 + i] ?? 0);

    if (this.#write.bytes.length < total) {
      this.#i2cState = STATE_WRITING_NO_STOP;
      reply[2] = this.#i2cState;
      return;
    }

    const bytes = Uint8Array.from(this.#write.bytes);
    this.#write = null;
    try {
      this.#bus.get(address)!.write(bytes, address);
    } catch (err) {
      if (!(err instanceof NackError)) throw err;
      // A device that declines looks exactly like an absent one from the bus's
      // side: the command is accepted and the NACK surfaces in the status
      // register afterwards. An EEPROM mid-write-cycle is the usual reason.
      this.#addrNacked = true;
      this.#i2cState = STATE_ADDR_NACK;
      reply[2] = this.#i2cState;
      return;
    }
    // A no-stop write leaves the bus held so a repeated-start read can follow.
    this.#i2cState = command === CMD_I2C_WRITE_NOSTOP ? STATE_WRITING_NO_STOP : STATE_IDLE;
    if (this.#stallAfterWrite !== null) this.#i2cState = this.#stallAfterWrite;
    reply[2] = this.#i2cState;
  }

  #i2cRead(report: Uint8Array, reply: Uint8Array): void {
    const total = (report[1] ?? 0) | ((report[2] ?? 0) << 8);
    const address = (report[3] ?? 0) >> 1;
    const device = this.#bus.get(address);

    if (!device) {
      this.#addrNacked = true;
      this.#i2cState = STATE_ADDR_NACK;
      this.#read = { data: new Uint8Array(0), offset: 0, nacked: true };
      return;
    }

    this.#addrNacked = false;
    let data: Uint8Array;
    try {
      data = device.read(total, address);
    } catch (err) {
      if (!(err instanceof NackError)) throw err;
      this.#addrNacked = true;
      this.#i2cState = STATE_ADDR_NACK;
      this.#read = { data: new Uint8Array(0), offset: 0, nacked: true };
      return;
    }
    this.#read = { data, offset: 0, nacked: false };
    this.#i2cState = STATE_IDLE;
    reply[2] = this.#i2cState;
  }

  #i2cGetData(reply: Uint8Array): void {
    const pending = this.#read;
    if (!pending) {
      // Blinka reads "no data and no error" as a clean end of transfer.
      reply[2] = 0x00;
      reply[3] = 0x00;
      return;
    }
    if (pending.nacked) {
      reply[2] = STATE_ADDR_NACK;
      this.#read = null;
      return;
    }

    const chunk = pending.data.subarray(pending.offset, pending.offset + MAX_I2C_CHUNK);
    pending.offset += chunk.length;
    reply[2] = READ_COMPLETE;
    reply[3] = chunk.length;
    reply.set(chunk, 4);
    if (pending.offset >= pending.data.length) this.#read = null;
  }

  /** Simulate an edge on GP1 when it is designated for interrupt detection. */
  triggerInterrupt(): void {
    this.#interruptDetected = true;
  }

  /** The engine has finished cancelling: bus released, transfers abandoned. */
  #settle(): void {
    this.#cancelPending = 0;
    if (this.#wedged) return; // a cancel cannot reach this one
    this.#i2cState = STATE_IDLE;
    this.#write = null;
    this.#read = null;
  }

  #resetState(): void {
    for (const pin of this.#pins) {
      pin.mode = GP_GPIO;
      pin.direction = 1;
      pin.value = 0;
    }
    this.#i2cState = STATE_IDLE;
    this.#addrNacked = false;
    this.#write = null;
    this.#read = null;
    this.#interruptDetected = false;
    // A reset is the one thing that clears a wedge no cancel can reach, and
    // being able to model that is the point of having `wedge()` at all.
    this.#cancelPending = 0;
    this.#wedged = false;
    this.#linesLow = false;
  }

  /**
   * Jam the engine in a state a cancel cannot clear, the way a transfer
   * abandoned mid-flight leaves real hardware. Only a reset gets out of it.
   */
  /**
   * Accept writes but park the engine in `state` afterwards, the way a bus
   * glitch part-way through a write does. Distinct from `wedge`, which jams
   * the engine before it will take anything: here the command is accepted and
   * the trouble only shows in the status that follows, which is the shape that
   * catches callers out.
   */
  stallWrites(state: number | null): void {
    this.#stallAfterWrite = state;
  }

  wedge(state = STATE_STOP, linesLow = false): void {
    this.#wedged = true;
    this.#i2cState = state;
    this.#linesLow = linesLow;
  }
}

/**
 * USB string descriptors are length-prefixed UTF-16LE with a 0x03 type byte;
 * the reported length counts those two header bytes.
 */
function writeUsbString(reply: Uint8Array, text: string): void {
  reply[2] = text.length * 2 + 2;
  reply[3] = USB_STRING_DESCRIPTOR_TYPE;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    reply[4 + i * 2] = code & 0xff;
    reply[5 + i * 2] = (code >> 8) & 0xff;
  }
}
