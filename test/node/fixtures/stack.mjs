// Boots the real stack in Node: Pyodide, the vendored wheels, python/hid.py,
// stock Blinka -- all of it wired to the MCP2221 emulator instead of WebHID.
//
// The one thing this harness does not exercise is the postMessage hop between
// page and worker; jspi-worker-rpc.test.mjs covers that separately. Everything
// else is byte-for-byte what the browser runs.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadPyodide } from "pyodide";

import { EmulatorTransport } from "../../../src/hid/emulator.ts";
import { Mcp2221Emulator } from "../../../src/hid/mcp2221-emulator.ts";
import { VirtualAht10 } from "../../../src/hid/devices/aht10.ts";
import { VirtualAs7341 } from "../../../src/hid/devices/as7341.ts";
import { VirtualEeprom } from "../../../src/hid/devices/eeprom.ts";
import { VirtualPa1010d } from "../../../src/hid/devices/pa1010d.ts";
import { VirtualRv1805 } from "../../../src/hid/devices/rv1805.ts";
import { VirtualSht4x } from "../../../src/hid/devices/sht4x.ts";
import { VirtualHdc302x } from "../../../src/hid/devices/hdc302x.ts";
import { VirtualAs5600 } from "../../../src/hid/devices/as5600.ts";
import { VirtualTsl2591 } from "../../../src/hid/devices/tsl2591.ts";
import { VirtualSsd1306 } from "../../../src/hid/devices/ssd1306.ts";
import { VirtualBmi160 } from "../../../src/hid/devices/bmi160.ts";
import { PY_ROOT, bootstrapSource } from "../../../src/worker/bootstrap.ts";
import { Serializer } from "../../../src/worker/serialize.ts";

const ROOT = new URL("../../../", import.meta.url);
const WHEELS = new URL("public/wheels/", ROOT);
const PYTHON = new URL("python/", ROOT);

/**
 * @param {{
 *   chip?: Mcp2221Emulator,
 *   transport?: EmulatorTransport,
 *   transferDelayMs?: number,
 * }} [options]
 */
export async function bootStack(options = {}) {
  const chip = options.chip ?? new Mcp2221Emulator();
  const transport =
    options.transport ?? new EmulatorTransport(chip, options.transferDelayMs ?? 0);

  const py = await loadPyodide();
  installBridge(transport);
  await installWheels(py);
  copyTree(py, PYTHON, PY_ROOT);
  await py.runPythonAsync(bootstrapSource());

  const rpc = py.pyimport("webblinka.rpc");
  // The same Serializer the worker uses, so concurrent calls in a test hit the
  // real queueing rather than a test-only approximation of it.
  const calls = new Serializer();
  /** Invoke a @handler exactly the way src/worker/pyworker.ts does. */
  const call = async (fn, ...args) =>
    JSON.parse(await calls.run(() => rpc.dispatch.callPromising(fn, JSON.stringify(args))));

  return { py, chip, transport, call, calls };
}

/** Build the demo rig without EmulatorTransport's setInterval keeping Node alive. */
export function demoChip(pa1010dOptions = {}) {
  const chip = new Mcp2221Emulator();
  chip.attach(new VirtualPa1010d(pa1010dOptions));
  return chip;
}

/** A chip with one EEPROM on it, sized however the test wants. */
export function chipWithEeprom(options = {}) {
  const chip = new Mcp2221Emulator();
  const eeprom = new VirtualEeprom(options);
  chip.attach(eeprom);
  return { chip, eeprom };
}

/** A chip with one AS7341 on it. */
export function chipWithSpectral(options = {}) {
  const chip = new Mcp2221Emulator();
  const sensor = new VirtualAs7341(options);
  chip.attach(sensor);
  return { chip, sensor };
}

/** A chip with one SHT4x on it. */
export function chipWithSht4x(options = {}) {
  const chip = new Mcp2221Emulator();
  const sensor = new VirtualSht4x(options);
  chip.attach(sensor);
  return { chip, sensor };
}

/** A chip with one HDC302x on it. */
export function chipWithHdc302x(options = {}) {
  const chip = new Mcp2221Emulator();
  const sensor = new VirtualHdc302x(options);
  chip.attach(sensor);
  return { chip, sensor };
}

/** A chip with one AS5600 on it. */
export function chipWithEncoder(options = {}) {
  const chip = new Mcp2221Emulator();
  const encoder = new VirtualAs5600(options);
  chip.attach(encoder);
  return { chip, encoder };
}

/** A chip with one TSL2591 on it. */
export function chipWithLight(options = {}) {
  const chip = new Mcp2221Emulator();
  const sensor = new VirtualTsl2591(options);
  chip.attach(sensor);
  return { chip, sensor };
}

/** A chip with one BMI160 on it. */
export function chipWithImu(options = {}) {
  const chip = new Mcp2221Emulator();
  const imu = new VirtualBmi160(options);
  chip.attach(imu);
  return { chip, imu };
}

/** A chip with one SSD1306 on it. */
export function chipWithScreen(options = {}) {
  const chip = new Mcp2221Emulator();
  const screen = new VirtualSsd1306(options);
  chip.attach(screen);
  return { chip, screen };
}

/** A chip with one RV-1805 on it. */
export function chipWithRtc(options = {}) {
  const chip = new Mcp2221Emulator();
  const rtc = new VirtualRv1805(options);
  chip.attach(rtc);
  return { chip, rtc };
}

/** The demo rig: a GPS and a temperature/humidity sensor on one bus. */
export function demoChipWithAht(options = {}) {
  const chip = demoChip(options.pa1010d ?? {});
  chip.attach(new VirtualAht10(options.aht ?? {}));
  return chip;
}

function installBridge(transport) {
  globalThis.webblinkaHid = {
    enumerate: () => transport.enumerate(),
    open: (vendorId, productId) => transport.open(vendorId, productId),
    write: (data) => transport.write(data),
    read: (length, timeoutMs) => transport.read(length, timeoutMs),
    close: () => transport.close(),
  };
  globalThis.webblinkaSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}

async function installWheels(py) {
  await py.loadPackage("micropip");
  py.FS.mkdirTree("/wheels");
  const files = readdirSync(WHEELS).filter((name) => name.endsWith(".whl"));
  if (files.length === 0) throw new Error("no vendored wheels -- run `npm run wheels`");
  for (const name of files) {
    py.FS.writeFile(`/wheels/${name}`, new Uint8Array(readFileSync(new URL(name, WHEELS))));
  }
  const micropip = py.pyimport("micropip");
  // emfs: installs straight out of the Pyodide filesystem, so the suite never
  // touches the network. deps:false because fetch_wheels.py pins the closure.
  await micropip.install(
    files.map((name) => `emfs:/wheels/${name}`),
    { deps: false },
  );
}

function copyTree(py, from, target) {
  for (const entry of readdirSync(fileURLToPath(from), { withFileTypes: true })) {
    const source = new URL(entry.name + (entry.isDirectory() ? "/" : ""), from);
    const destination = `${target}/${entry.name}`;
    if (entry.isDirectory()) {
      py.FS.mkdirTree(destination);
      copyTree(py, source, destination);
    } else if (entry.name.endsWith(".py")) {
      py.FS.mkdirTree(target);
      py.FS.writeFile(destination, readFileSync(fileURLToPath(source), "utf8"));
    }
  }
}
