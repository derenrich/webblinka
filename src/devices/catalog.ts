import type { DevicePanel, DeviceSession } from "./panel.ts";
import { As5600Panel } from "../ui/panels/as5600.ts";
import { HygrometerPanel } from "../ui/panels/hygrometer.ts";
import { As7341Panel } from "../ui/panels/as7341.ts";
import { Tsl2591Panel } from "../ui/panels/tsl2591.ts";
import { DisplayPanel } from "../ui/panels/display.ts";
import { ImuPanel } from "../ui/panels/imu.ts";
import { EepromPanel } from "../ui/panels/eeprom.ts";
import { RtcPanel } from "../ui/panels/rtc.ts";
import { GpsPanel } from "../ui/panels/gps.ts";

/**
 * Every I2C device webblinka knows how to drive.
 *
 * Adding one is: write a Driver in python/webblinka/drivers/, write a panel,
 * and add an entry here. Nothing in the RPC layer, the tab shell or the scanner
 * needs to change -- they all work off this list.
 *
 * `addresses` is what connects a scan result to a panel. It is every address
 * the part can answer at, including strap-selectable ones, because suggesting
 * the right panel for an address the user chose with a solder blob is most of
 * the value of having a catalog at all.
 */
export interface DeviceEntry {
  /** Matches the id its Python driver registers under. */
  id: string;
  name: string;
  /** One line: what the thing is, not how it works. */
  description: string;
  /** Every I2C address the part can appear at. */
  addresses: number[];
  /** Used when opening without a scan match. Defaults to addresses[0]. */
  defaultAddress?: number;
  /** The CircuitPython library it drives, for the catalogue listing. */
  library: string;
  create(session: DeviceSession): DevicePanel;
}

export const DEVICES: DeviceEntry[] = [
  {
    id: "pa1010d",
    name: "PA1010D GPS",
    description: "Adafruit Mini GPS and other GTop I²C receivers",
    // The PA1010D is fixed at 0x10; GTop modules generally are.
    addresses: [0x10],
    library: "adafruit_circuitpython_gps",
    create: (session) => new GpsPanel(session),
  },
  {
    id: "aht10",
    name: "AHT10 / AHT20",
    description: "Temperature and humidity, with dew point derived",
    // The whole AHTx0 family is strapped to 0x38 with no address pins.
    addresses: [0x38],
    library: "adafruit_circuitpython_ahtx0",
    create: (session) => new HygrometerPanel(session),
  },
  {
    id: "sht4x",
    name: "SHT45 / SHT4x",
    description: "Sensirion precision temperature and humidity, with heater",
    // The SHT40/41/43/45 all sit at 0x44; the -B suffix parts are at 0x45.
    addresses: [0x44, 0x45],
    library: "adafruit_circuitpython_sht4x",
    create: (session) => new HygrometerPanel(session),
  },
  {
    id: "hdc302x",
    name: "HDC3022 / HDC302x",
    description: "TI precision temperature and humidity, with heater",
    // Shares 0x44 with the SHT4x; the ADDR pins reach 0x47.
    addresses: [0x44, 0x45, 0x46, 0x47],
    library: "adafruit_circuitpython_hdc302x",
    create: (session) => new HygrometerPanel(session),
  },
  {
    id: "as5600",
    name: "AS5600 magnetic encoder",
    description: "12-bit rotary position, with magnet placement diagnostics",
    addresses: [0x36],
    library: "adafruit_circuitpython_as5600",
    create: (session) => new As5600Panel(session),
  },
  {
    id: "as7341",
    name: "AS7341 spectral sensor",
    description: "Eleven channels, 415–680 nm plus clear and near-IR",
    // Strapped to 0x39, shared with the APDS-9960 among others -- the driver
    // checks the WHOAMI before believing the scan.
    addresses: [0x39],
    library: "adafruit_circuitpython_as7341",
    create: (session) => new As7341Panel(session),
  },
  {
    id: "tsl2591",
    name: "TSL2591 light sensor",
    description: "Illuminance over six decades, with visible and infrared apart",
    // Fixed at 0x29, which it shares with the TCS34725 among others -- the
    // driver checks the device ID register before believing the scan.
    addresses: [0x29],
    library: "adafruit_circuitpython_tsl2591",
    create: (session) => new Tsl2591Panel(session),
  },
  {
    id: "bmi160",
    name: "BMI160 IMU",
    description: "Bosch six-axis accelerometer and gyroscope, with tilt derived",
    // SDO picks between the two. 0x69 is shared with the RV-1805 and 0x68 with
    // a DS3231 or an MPU-6050, so the driver checks the chip ID at open.
    addresses: [0x68, 0x69],
    library: "circuitpython_bmi160",
    create: (session) => new ImuPanel(session),
  },
  {
    id: "ssd1306",
    name: "SSD1306 OLED",
    description: "128×64 or 128×32 monochrome display, with test patterns",
    // SA0 picks between the two; most modules are strapped to 0x3c.
    addresses: [0x3c, 0x3d],
    library: "adafruit_circuitpython_ssd1306",
    create: (session) => new DisplayPanel(session),
  },
  {
    id: "rv1805",
    name: "RV-1805 RTC",
    description: "Micro Crystal / Abracon AB1805 real-time clock",
    // Fixed at 0x69, which it shares with an MPU-6050 among others -- so the
    // driver checks the part number register before believing the scan.
    addresses: [0x69],
    library: "adafruit_bus_device",
    create: (session) => new RtcPanel(session),
  },
  // The 24-series EEPROMs. One driver and one panel serve the whole family --
  // they differ only in capacity, page size and address width -- so a new part
  // is a row here and a row in EEPROM_TYPES. They all sit at 0x50-0x57 by their
  // A0/A1/A2 pins, which is why several of them offer the same eight addresses:
  // the scan cannot tell them apart, so it proposes all of them and you pick.
  ...eeproms(),
];

/**
 * Every catalogued EEPROM. Kept together because only the numbers differ, and
 * everything else about them follows from those numbers.
 *
 * The addresses are derived rather than listed. A part with more storage than
 * its word address can reach borrows the low bits of the I2C address for the
 * high bits of the memory address, so it occupies several consecutive
 * addresses -- ceil(size / span), where span is 64 KiB for a two-byte word
 * address and 256 bytes for a one-byte one, which is Linux's at24 rule. Those
 * are addresses the A-pins can no longer reach: a 24C04 eats two and can only
 * start on an even one, and a 24C16 eats all eight and cannot be moved at all.
 */
function eeproms(): DeviceEntry[] {
  // pins is how many A-pins the package bonds out, which is a datasheet fact
  // and not always three: the original AT24C128/256 leave pin 3 unconnected,
  // so tying it high does nothing at all and only four fit on a bus. The C
  // revisions of the same parts do bond it out. That difference is invisible
  // from the bus and is exactly what makes an address jumper look broken.
  const parts: [
    id: string,
    name: string,
    bytes: number,
    page: number,
    addrBytes: 1 | 2,
    pins: number,
  ][] = [
    ["at24c512c", "AT24C512C", 64 * 1024, 128, 2, 3],
    ["at24c256c", "AT24C256C", 32 * 1024, 64, 2, 3],
    ["at24c256", "AT24C256", 32 * 1024, 64, 2, 2],
    ["at24c128c", "AT24C128C", 16 * 1024, 64, 2, 3],
    ["at24c128", "AT24C128", 16 * 1024, 64, 2, 2],
    ["at24c64", "AT24C64", 8 * 1024, 32, 2, 3],
    ["24lc32", "24LC32", 4 * 1024, 32, 2, 3],
    ["at24c16", "AT24C16", 2 * 1024, 16, 1, 3],
    ["at24c08", "AT24C08", 1024, 16, 1, 3],
    ["at24c04", "AT24C04", 512, 16, 1, 3],
    ["at24c02", "AT24C02", 256, 8, 1, 3],
    ["at24c01", "AT24C01", 128, 8, 1, 3],
  ];
  return parts.map(([id, name, bytes, page, addrBytes, pins]) => {
    const span = addrBytes === 2 ? 65536 : 256;
    const banks = Math.max(1, Math.ceil(bytes / span));
    // Banking eats the low address bits, so a multi-address part can only
    // start on a multiple of its run; the pin count caps the range outright.
    const addresses: number[] = [];
    for (let i = 0; i < (1 << pins) / banks; i++) addresses.push(0x50 + i * banks);
    return {
      id,
      name: `${name} EEPROM`,
      description:
        `${bytes >= 1024 ? `${bytes / 1024} KiB` : `${bytes} B`}, ${page}-byte pages, ` +
        `${hexAddress(addresses[0]!)}–${hexAddress(addresses.at(-1)!)}` +
        (banks > 1 ? ` in steps of ${banks}` : "") +
        (pins < 3 ? ` (A0–A${pins - 1} only)` : ""),
      addresses,
      library: "adafruit_bus_device",
      create: (session) => new EepromPanel(session),
    };
  });
}

function hexAddress(value: number): string {
  return `0x${value.toString(16)}`;
}

export function deviceById(id: string): DeviceEntry | undefined {
  return DEVICES.find((device) => device.id === id);
}

/** Catalogue entries that could account for an address the scan turned up. */
export function devicesAt(address: number): DeviceEntry[] {
  return DEVICES.filter((device) => device.addresses.includes(address));
}

export function defaultAddressOf(device: DeviceEntry): number {
  return device.defaultAddress ?? device.addresses[0] ?? 0;
}
