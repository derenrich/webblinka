import { EmulatorTransport } from "../hid/emulator.ts";
import type { HidTransport } from "../hid/transport.ts";
import {
  WebHidTransport,
  grantedMcp2221s,
  isWebHidAvailable,
  requestMcp2221,
} from "../hid/webhid.ts";
import { vendoredWheelUrls } from "../wheels.ts";
import { PythonSession } from "../worker/client.ts";
import { BOOT_PHASE_LABELS } from "../worker/protocol.ts";
import { el } from "./dom.ts";
import { statusPill } from "./panel.ts";
import {
  CommonPanel,
  type BoardInfo,
  type BusState,
  type ChipStatus,
  type RuntimeInfo,
} from "./panels/common.ts";
import { ConsolePanel, type ConsoleResult } from "./panels/console.ts";
import { DescriptorsPanel, type UsbDescriptors } from "./panels/descriptors.ts";
import {
  GpioPanel,
  type GpSettings,
  type PinModeSpec,
  type PinState,
} from "./panels/gpio.ts";
import { DeviceManager } from "../devices/manager.ts";
import { DevicesPanel } from "./panels/devices.ts";
import { I2cPanel } from "./panels/i2c.ts";
import { LogPanel } from "./panels/log.ts";
import { Tabs } from "./tabs.ts";

/** JSPI is what lets synchronous Blinka code await WebHID. Chrome 137+. */
function hasJspi(): boolean {
  return typeof WebAssembly.Suspending === "function";
}

/**
 * Opens in a new tab: leaving this one drops the WebHID grant and throws away a
 * Python runtime that took several seconds to boot.
 */
function link(href: string, text: string): HTMLAnchorElement {
  return el("a", { href, text, target: "_blank", rel: "noreferrer noopener" });
}

export function mount(root: HTMLElement): void {
  const session = new PythonSession();
  const status = statusPill("Disconnected");
  const log = new LogPanel();

  const common = new CommonPanel({
    status: () => session.call<ChipStatus>("common_status"),
    clearInterrupt: () => session.call<void>("clear_interrupt"),
  });

  const descriptors = new DescriptorsPanel({
    read: () => session.call<UsbDescriptors>("usb_descriptors"),
  });

  const gpio = new GpioPanel({
    modes: () => session.call<Record<string, PinModeSpec[]>>("gpio_modes"),
    configure: (name, mode) => session.call<PinState>("gpio_configure", name, mode),
    release: (name) => session.call<void>("gpio_release", name),
    write: (name, value) => session.call<PinState>("gpio_write", name, value),
    readAll: () => session.call<PinState[]>("gpio_read_all"),
    settings: () => session.call<{ gp: GpSettings }>("sram_settings"),
    setClock: (duty, divider) => session.call("set_clock_output", duty, divider),
    setDacReference: (v, o) => session.call("set_dac_reference", v, o),
    setDacValue: (value) => session.call("set_dac_value", value),
    setAdcReference: (v, o) => session.call("set_adc_reference", v, o),
    setInterruptEdge: (edge) => session.call("set_interrupt_edge", edge),
  });

  // The device list needs the manager, the manager needs the tab strip, and the
  // strip needs this tab's content -- so the container is made first and filled
  // once the cycle is closed.
  const busTab = el("div");
  let devicesPanel: DevicesPanel | null = null;

  const i2c = new I2cPanel({
    scan: async () => {
      const found = await session.call<number[]>("i2c_scan");
      devicesPanel?.setScan(found);
      return found;
    },
    setFrequency: async (hz) => void (await session.call("set_i2c_frequency", hz)),
  });

  const console_ = new ConsolePanel({
    exec: (source) => session.call<ConsoleResult>("console_exec", source),
    reset: () => session.call<string[]>("console_reset"),
    install: (spec) =>
      session.call<{ requested: string; installed: string[] }>("install_package", spec),
  });

  const tabs = new Tabs([
    {
      id: "common",
      label: "Common",
      content: common.root,
      onShow: () => common.start(),
      onHide: () => common.stop(),
    },
    {
      id: "descriptors",
      label: "USB Descriptors",
      content: descriptors.root,
      onShow: () => void descriptors.load(),
    },
    {
      id: "gpio",
      label: "GPIO",
      content: gpio.root,
      onShow: () => gpio.show(),
      onHide: () => gpio.hide(),
    },
    {
      id: "i2c",
      label: "I²C",
      content: busTab,
      // Scanning writes to every address on the bus, so it happens when you ask
      // to look at the bus -- not as a side effect of plugging something in.
      onShow: () => void i2c.scanOnce(),
    },
    { id: "python", label: "Python", content: console_.root },
  ]);

  const deviceManager = new DeviceManager(session, tabs);
  devicesPanel = new DevicesPanel(deviceManager);
  const devices = devicesPanel;
  busTab.append(i2c.root, devices.root);

  // Connecting hardware is what people came for. The simulator is a fallback for
  // the few who have none, so it reads as a quiet aside rather than a second
  // button of equal weight -- offering them side by side is how someone ends up
  // in the simulator without meaning to be.
  const connect = el("button", { class: "primary large", text: "Connect MCP2221" });
  const demo = el("button", { class: "linklike", text: "run the simulator instead" });
  const reset = el("button", {
    text: "Reset chip",
    hidden: true,
    title:
      "Resets the MCP2221. Clears an I²C engine stuck somewhere a cancel cannot " +
      "reach — the software equivalent of unplugging it.",
  });

  // Shown until there is a device, then retired: once you are connected the
  // pitch is spent, and everything it said about the board is in the Common tab.
  const intro = el("div", { class: "intro" }, [
    el("p", {
      text:
        "Plug in an MCP2221 or MCP2221A, click connect and grant access. Adafruit's Blinka and " +
        "CircuitPython libraries run unmodified in a Python runtime inside this " +
        "page and talk to the chip over WebHID — no server, no install.",
    }),
    el("p", {}, [
    ]),
    el("p", { class: "aside" }, [
      el("span", { text: "Don't have one? Adafruit sells the " }),
      link("https://www.adafruit.com/product/4471", "MCP2221A Breakout"),
      el("span", { text: ", and Microchip the " }),
      link("https://www.microchip.com/en-us/development-tool/bb62z76a", "MCP2221A USB-C Breakout Board"),
      el("span", { text: ". Or you can " }),
      demo,
      el("span", { text: " — everything works, but the readings are invented." }),
    ]),
  ]);

  // Demo mode presents an interface identical to the real one, so every reading
  // it produces has to be labelled as invented. Otherwise a simulated GPS fix
  // simply looks like a receiver reporting the wrong place, and the person
  // reading it goes looking for a fault in their hardware.
  const demoBanner = el("div", { class: "demo-banner", hidden: true }, [
    el("strong", { text: "Demo mode" }),
    el("span", {
      text:
        " — no hardware is connected. Every reading below is generated in " +
        "software. Press Connect MCP2221 to use a real device.",
    }),
  ]);

  root.replaceChildren(
    el("div", { class: "masthead" }, [
      el("div", {}, [
        el("h1", { text: "webblinka" }),
        el("p", {
          text: "Control I²C hardware from your browser using real CircuitPython drivers.",
        }),
      ]),
      // Connecting is the one action available from anywhere, so it lives with
      // the state it changes rather than in a panel of its own.
      el("div", { class: "masthead-actions" }, [status.node, connect]),
    ]),
    demoBanner,
    intro,
    tabs.root,
    log.root,
  );

  // Reset is a chip-level recovery, so it belongs with the chip's own readouts.
  common.boardActions.append(reset);

  const ui: Ui = {
    connect,
    demo,
    reset,
    status,
    log,
    tabs,
    common,
    gpio,
    i2c,
    console: console_,
    deviceManager,
    intro,
    demoMode: false,
    setDemoMode(on: boolean) {
      this.demoMode = on;
      demoBanner.hidden = !on;
      if (on) root.dataset.demo = "true";
      else delete root.dataset.demo;
    },
  };

  reset.addEventListener("click", () => void resetChip(session, ui));

  session.on("status", (phase) => {
    // The pill stays one short word so its box never changes size; the phase
    // detail goes to the log, which is where you would look for progress.
    status.set("Connecting…", "busy");
    log.write(`${BOOT_PHASE_LABELS[phase]}…`);
  });
  session.on("log", (stream, text) => log.write(text, stream));

  demo.addEventListener("click", () => {
    ui.setDemoMode(true);
    log.write(
      "Starting in demo mode: emulated MCP2221 with a simulated PA1010D, " +
        "AHT10, SHT45, AS7341, AS5600, TSL2591, BMI160, SSD1306, EEPROM and " +
        "RV-1805 on its " +
        "bus. " +
        "All readings from here are software-generated, not measurements.",
    );
    void start(session, ui, new EmulatorTransport(), "simulated device");
  });

  const blocker = unsupportedReason();
  if (blocker) {
    // Demo mode still needs JSPI -- it is Python doing the driving either way --
    // so only WebHID's absence leaves it usable.
    connect.disabled = true;
    status.set("Unsupported", "error");
    intro.append(el("div", { class: "notice", dataset: { tone: "error" }, text: blocker }));
    if (!hasJspi() || !window.isSecureContext) demo.disabled = true;
    return;
  }

  connect.addEventListener("click", () => void connectHardware(session, ui));
  void grantedMcp2221s().then((devices) => {
    if (devices.length > 0) connect.textContent = "Reconnect MCP2221";
  });
}

interface Ui {
  connect: HTMLButtonElement;
  demo: HTMLButtonElement;
  reset: HTMLButtonElement;
  status: ReturnType<typeof statusPill>;
  log: LogPanel;
  tabs: Tabs;
  common: CommonPanel;
  gpio: GpioPanel;
  i2c: I2cPanel;
  console: ConsolePanel;
  deviceManager: DeviceManager;
  intro: HTMLElement;
  /** Readings are software-generated, and every one of them must say so. */
  demoMode: boolean;
  setDemoMode(on: boolean): void;
}

async function connectHardware(session: PythonSession, ui: Ui): Promise<void> {
  ui.connect.disabled = true;
  const granted = await grantedMcp2221s();
  const device = granted[0] ?? (await requestMcp2221());
  if (!device) {
    ui.status.set("Disconnected", "idle");
    ui.log.write("No device selected.");
    ui.connect.disabled = false;
    return;
  }
  ui.log.write(`Selected ${device.productName || "MCP2221"}.`);

  // Coming from the simulator: drop its devices and its labelling before the
  // transport swaps, so nothing simulated is left on screen next to real
  // readings. The swap itself is invisible to Python -- its `hid` module talks
  // to the transport, not to any particular device.
  if (ui.demoMode) {
    await ui.deviceManager.closeAll();
    ui.setDemoMode(false);
    ui.log.write("Leaving demo mode; readings from here are from the hardware.");
  }

  await start(session, ui, new WebHidTransport(device), device.productName || "MCP2221");
}

async function start(
  session: PythonSession,
  ui: Ui,
  transport: HidTransport,
  label: string,
): Promise<void> {
  ui.connect.disabled = true;
  ui.demo.disabled = true;
  try {
    session.useTransport(transport);
    await session.boot(await vendoredWheelUrls());

    const board = await session.call<BoardInfo>("connect");
    const runtime = await session.call<RuntimeInfo>("runtime_info");
    ui.common.showBoard(board, runtime, label);
    ui.i2c.enable();
    await ui.gpio.enable();
    await ui.console.enable();
    ui.tabs.enable();

    // The pitch has done its job, and the Common tab now says everything it
    // said about the board.
    ui.intro.hidden = true;
    ui.reset.hidden = false;
    // Connected to hardware there is nothing left to connect, so the button
    // goes and the pill sits flush right -- an empty reserved box beside it
    // just looks broken. This is a one-way transition, not the resizing that
    // shoves the header about while connecting.
    //
    // In demo mode it stays, live and enabled: swapping the simulator for a
    // real adapter is what someone in demo mode does next, and the demo banner
    // tells them to press exactly this button.
    ui.connect.hidden = !ui.demoMode;
    ui.connect.disabled = !ui.demoMode;

    // "Demo" rather than "Connected": nothing is connected, and the pill is the
    // one thing on screen in every tab. The device name lives in Common's Board
    // panel -- here it would only make the pill jump about as it changes.
    ui.status.set(ui.demoMode ? "Demo mode" : "Connected", ui.demoMode ? "busy" : "ok");
    ui.log.write(`Blinka ${runtime.blinka} on Python ${runtime.python}, chip ${board.chip}.`);
    reportBusState(ui, session, board.bus);
  } catch (err) {
    ui.status.set("Failed", "error");
    ui.log.write(err instanceof Error ? err.message : String(err), "stderr");
    ui.connect.hidden = false;
    ui.connect.disabled = false;
    ui.demo.disabled = false;
  }
}

/**
 * Say what the bus is actually doing rather than guessing at it. The two lines
 * separate the two causes: both high and the bus is free, so the chip itself is
 * stuck and a reset fixes it; either low and a device is holding the line, which
 * no amount of resetting the MCP2221 will change.
 */
/**
 * Say something about the bus only when there is something to say.
 *
 * The engine's state byte reports the last thing it did, not necessarily what
 * is wrong with it — a NACKed probe or a cancel that arrived a moment late
 * leaves a code sitting there that clears on the next transfer. Blinka treats a
 * non-idle state as a thing to cancel and carry on from, not as a fault, and so
 * should we: an earlier version announced a broken chip on the strength of that
 * byte alone and was wrong every time.
 *
 * A line held low is different. That is measurable, unambiguous, and no amount
 * of resetting the MCP2221 will release a line another device is pulling down.
 */
function reportBusState(ui: Ui, session: PythonSession, bus: BusState): void {
  if (!bus.scl || !bus.sda) {
    ui.log.write(
      `I²C bus is not free: SCL ${bus.scl ? "high" : "low"}, ` +
        `SDA ${bus.sda ? "high" : "low"}. A device is holding a line down — ` +
        `check wiring and pull-ups. Resetting the MCP2221 will not release it.`,
      "stderr",
    );
    ui.log.write(session.trace.format(), "stderr");
    return;
  }
  if (!bus.idle) {
    ui.log.write(
      `I²C engine reports "${bus.state}"; the bus itself is free. That is usually ` +
        `a leftover code from the last transfer and clears on the next one.`,
    );
  }
}

async function resetChip(session: PythonSession, ui: Ui): Promise<void> {
  ui.reset.disabled = true;
  // Nothing may talk to the device while it is away. Drivers hold a bus the
  // reset is about to invalidate, so they close rather than pause.
  ui.common.stop();
  ui.gpio.hide();
  await ui.deviceManager.closeAll();
  ui.status.set("Resetting…", "busy");
  ui.log.write("Resetting the chip; it will drop off USB and re-enumerate.");
  try {
    // The reply never comes -- the device is gone before it could send one --
    // and the send itself may fail for the same reason. Both are success here.
    await session.call("reset_chip").catch(() => undefined);
    await session.reacquire();
    const bus = await session.call<BusState>("rebuild_bus");
    await ui.gpio.enable(); // a reset put every pin back to its flash default
    ui.status.set("Connected", "ok");
    ui.log.write(`Chip is back, I²C engine ${bus.state}.`);
    reportBusState(ui, session, bus);
  } catch (err) {
    ui.status.set("Reset failed", "error");
    ui.log.write(err instanceof Error ? err.message : String(err), "stderr");
  } finally {
    ui.reset.disabled = false;
  }
}

function unsupportedReason(): string | null {
  if (!window.isSecureContext) {
    return "WebHID needs a secure context. Load this page over HTTPS or from localhost.";
  }
  if (!hasJspi()) {
    return (
      "This browser lacks WebAssembly JavaScript Promise Integration, which is " +
      "what lets synchronous CircuitPython code wait on WebHID. Chrome 137 or " +
      "newer is required."
    );
  }
  if (!isWebHidAvailable()) {
    return (
      "This browser has no WebHID support, so it cannot reach an MCP2221. " +
      "You can still run the demo, which emulates one in software."
    );
  }
  return null;
}
