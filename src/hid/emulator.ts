import { VirtualAht10 } from "./devices/aht10.ts";
import { VirtualAs7341 } from "./devices/as7341.ts";
import { VirtualEeprom } from "./devices/eeprom.ts";
import { VirtualPa1010d } from "./devices/pa1010d.ts";
import { VirtualRv1805 } from "./devices/rv1805.ts";
import { VirtualSht4x } from "./devices/sht4x.ts";
import { VirtualAs5600 } from "./devices/as5600.ts";
import { VirtualTsl2591 } from "./devices/tsl2591.ts";
import { VirtualSsd1306 } from "./devices/ssd1306.ts";
import { VirtualBmi160 } from "./devices/bmi160.ts";
import { Mcp2221Emulator } from "./mcp2221-emulator.ts";
import { MCP2221_PRODUCT_ID, MCP2221_VENDOR_ID } from "./webhid.ts";
import { ReportQueue, type HidDeviceInfo, type HidTransport, type Report } from "./transport.ts";

/**
 * Feeds the emulated chip through the same HidTransport the real device uses,
 * so nothing above this line -- not the worker, not the hid shim, not Blinka --
 * can tell the difference.
 */
export class EmulatorTransport implements HidTransport {
  droppedReports = 0;
  lateReports = 0;
  readonly chip: Mcp2221Emulator;
  readonly #queue = new ReportQueue();
  readonly #transferDelayMs: number;
  #opened = false;

  /**
   * @param transferDelayMs Latency to add to each transfer. Zero keeps demo mode
   *   snappy, but real USB costs about a millisecond per report -- enough to
   *   turn timing bugs that are invisible here into certainties on hardware, so
   *   tests set it deliberately.
   */
  constructor(chip = defaultRig(), transferDelayMs = 0) {
    this.chip = chip;
    this.#transferDelayMs = transferDelayMs;
  }

  async enumerate(): Promise<HidDeviceInfo[]> {
    return [
      {
        vendor_id: MCP2221_VENDOR_ID,
        product_id: MCP2221_PRODUCT_ID,
        product_string: "MCP2221 (emulated)",
        manufacturer_string: "webblinka",
        serial_number: "demo",
        path: "emulator:0",
      },
    ];
  }

  async open(): Promise<void> {
    this.#opened = true;
    this.#queue.clear();
  }

  async write(data: Report): Promise<number> {
    if (!this.#opened) throw new Error("emulated device is not open");
    // Anything unread when a new command goes out is an orphaned reply; see the
    // matching comment in WebHidTransport.write.
    const stale = this.#queue.discardStale();
    this.droppedReports += stale.orphaned;
    this.lateReports += stale.late;
    await this.#delay();
    // Byte 0 is the hidapi report ID; the chip only sees the 64-byte report.
    const reply = this.chip.handle(data.subarray(1));
    if (reply) this.#queue.push(reply as Report);
    return data.length;
  }

  async read(_length: number, timeoutMs: number): Promise<Report> {
    if (!this.#opened) throw new Error("emulated device is not open");
    await this.#delay();
    return this.#queue.take(timeoutMs);
  }

  #delay(): Promise<void> {
    if (this.#transferDelayMs <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, this.#transferDelayMs));
  }

  async close(): Promise<void> {
    this.#opened = false;
  }

  /** Nothing re-enumerates in software, so the handle is still good. */
  async reacquire(): Promise<void> {
    this.#queue.clear();
    this.#opened = true;
  }
}

/** Something legible in the hex dump rather than 32 KiB of 0xff. */
function demoEepromContents(): Uint8Array {
  const text = new TextEncoder().encode(
    "webblinka demo EEPROM\nAT24C256, 64-byte pages.\n" +
      "Try writing across a page boundary at 0x0040.\n",
  );
  const contents = new Uint8Array(256).fill(0xff);
  contents.set(text.subarray(0, 256));
  return contents;
}

/** The board demo mode presents: an MCP2221 with three parts on its bus. */
export function defaultRig(): Mcp2221Emulator {
  const chip = new Mcp2221Emulator();
  // Start the cold start when the driver starts the module, not when the page
  // built the rig -- otherwise Pyodide's boot outlasts the acquisition and the
  // sky view is already full by the time anyone can look at it.
  chip.attach(new VirtualPa1010d({ acquireFromFirstCommand: true }));
  // A second part, so demo mode shows a bus with more than one thing on it and
  // the scan has something to match against two catalogue entries.
  chip.attach(new VirtualAht10());
  chip.attach(new VirtualAs7341());
  chip.attach(new VirtualSht4x());
  // Parked at an angle and slowly turning, so the dial is not frozen.
  chip.attach(new VirtualAs5600({ degrees: 137, gap: 0.45 }));
  // Bright enough to saturate the library's default 25x gain, so demo mode
  // opens on the panel doing the thing it is for -- ranging down out of an
  // overflow -- rather than on a comfortable mid-scale reading.
  chip.attach(new VirtualTsl2591({ lux: 3200, infraredFraction: 0.42 }));
  chip.attach(new VirtualSsd1306());
  // Tilted, turning slowly, and with the zero-rate offset a real one has --
  // so the panel opens on a gyro that reads non-zero while the board is still,
  // which is the thing it exists to point out.
  chip.attach(
    new VirtualBmi160({ rollDeg: 12, pitchDeg: -7, rateDps: [0, 0, 0], biasDps: [0.9, -1.4, 0.6] }),
  );
  chip.attach(new VirtualEeprom({ contents: demoEepromContents() }));
  // A few seconds out and running conspicuously fast. A real RV-1805 is within
  // a couple of ppm, which takes an hour of watching to resolve at this part's
  // hundredth-second resolution -- so the demo would spend the whole time
  // saying "not yet". 900 ppm is a badly sick crystal, resolves in about ten
  // seconds, and is the only way the panel's actual point is visible in a demo.
  chip.attach(
    new VirtualRv1805({
      epoch: Date.now() / 1000 - 4.2,
      driftPpm: 900,
      // How one arrives out of its tube: the failure latch is set because the
      // crystal has not been running, and stays set until someone clears it.
      // Showing that is more useful than showing a clock that has never had a
      // past, since it is the first thing a real part reports.
      oscillatorFault: true,
    }),
  );
  // A slowly wandering analog signal so the ADC readouts are not flatlined.
  const started = Date.now();
  const tick = () => {
    const t = (Date.now() - started) / 1000;
    chip.setAdc(0, 512 + 480 * Math.sin(t / 3));
    chip.setAdc(1, 512 + 300 * Math.sin(t / 7 + 1));
    chip.setAdc(2, 200);
  };
  tick();
  setInterval(tick, 100);
  return chip;
}
