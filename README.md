# webblinka

Run Adafruit's CircuitPython libraries in a browser tab, driving real I²C parts
and GPIO through an [MCP2221][mcp2221] USB adapter over WebHID. No server, no
install, no firmware — open the page, click Connect, and `import board` works.

The Blinka stack is **unmodified**. `adafruit-blinka`,
`adafruit-circuitpython-gps` and friends are installed straight from their PyPI
wheels. The only thing this project had to write is a `hid` module.

## How it works

Blinka's MCP2221 driver needs exactly one native dependency: a module named
`hid`, of which it uses `enumerate()` plus a device with
`open`/`write`/`read`/`close`. [`python/hid.py`](python/hid.py) reimplements that
slice on top of WebHID and shadows the real package on `sys.path`. Nothing else
about Blinka changes.

The awkward part is that hidapi's calls are blocking while WebHID's are
promises. [WebAssembly JSPI][jspi] resolves it: Pyodide's `run_sync()` suspends
the Python stack mid-call, the browser resolves the promise, and Python resumes
none the wiser. That is also why there is no SharedArrayBuffer here — and so no
COOP/COEP headers, which GitHub Pages cannot set anyway.

```
main thread                          dedicated worker
───────────                          ────────────────
UI panels (plain TS)                 Pyodide
  │                                    ├─ hid.py  (shim on sys.path)
  ├── navigator.hid.requestDevice()    ├─ adafruit_blinka (stock, from a wheel)
  │     (needs a user gesture)         └─ webblinka/session.py + drivers/
  │
  └── HidTransport ◄──── postMessage ────► run_sync(promise)
        ├─ WebHidTransport (real device)
        └─ EmulatorTransport (demo mode / CI)
```

Python runs in a worker so a runaway driver loop cannot freeze the page. WebHID
stays on the main thread because `requestDevice()` needs a user gesture, so each
64-byte report round-trips over `postMessage` — invisible to Blinka thanks to
JSPI.

**Calls into Python are serialised** ([`serialize.ts`](src/worker/serialize.ts)).
The chip has one command pipeline and one I²C engine, and a suspended JSPI stack
lets the worker start a second call while the first is mid-transfer — so two
overlapping calls interleave on that one pipeline and read each other's replies.
The unit of atomicity is a whole driver operation, not a transfer, so the queue
lives at the call boundary. Panels that poll skip a tick rather than queue behind
a slow operation.

**Requirements: Chrome or Edge 137+ on desktop.** WebHID is Chromium-only and
JSPI shipped in 137. The site says so plainly if either is missing.

## The tabs

Laid out after [johntalton/webapp-device-playground][playground], which gets the
shape of an adapter UI right.

- **Common** — the Status/Set Parameters report, polled once a second: the I²C
  engine's state machine, the interrupt latch, silicon revision, and ADC counts
  for whichever pins are currently designated as ADCs. The converter is not
  wired to a pin doing anything else, so those channels are hidden rather than
  reporting a number that means nothing.
- **USB Descriptors** — the identity in the chip's flash. Read-only; see
  [`mcp2221_chip.py`](python/webblinka/mcp2221_chip.py) for why.
- **GPIO** — every pin designation the chip offers, not just in/out: SSPND,
  USBCFG, the UART Rx/Tx and I²C activity LEDs, the clock output, interrupt on
  change, ADC and DAC. Plus the chip-wide clock, reference-voltage and
  interrupt-edge settings those designations depend on.
- **I²C** — bus scan, and the GPS panel. That one leads with the sky view —
  a signal-strength bar per satellite, greyed while too weak to use, amber once
  usable, green once actually in the solution — because an acquiring receiver
  and a broken one look identical for the first half-minute unless you can watch
  the satellites arrive. Alongside it: time to first fix, satellites used versus
  in view, PDOP/HDOP/VDOP, and the raw NMEA. Once there is a fix it also plots
  the position scatter — where successive fixes land, in metres, against the
  HDOP-derived error estimate. That comparison is the useful one: a street map
  would show a single dot that never moves, whereas the size and shape of the
  cloud is the receiver's actual precision. No tiles, so no third party is told
  where the receiver is on every fix; there is a link out for when you do want
  streets, and following it is a decision rather than a side effect.
- **Devices** — every I²C part with a driver, opened on request from the I²C
  tab. Each gets its own tab:
  - **PA1010D GPS** — see above.
  - **AHT10 / AHT20** — temperature and humidity, plus the dew point and
    absolute humidity the part does not measure, and a five-minute trend. The
    trend earns its place: an AHT10 self-heats, so for a minute or two after
    power-up it reads high on temperature and low on humidity, and a single
    number gives no way to tell a settled reading from one still coming down.
    The panel says which, and warns when the dew point is close enough to
    ambient that surfaces will wet. Generic
    ([`hygrometer.ts`](src/ui/panels/hygrometer.ts)): the physics lives in
    [`hygrometry.py`](python/webblinka/drivers/hygrometry.py) and each part
    supplies only how to take a reading, what to call itself, which knobs it
    has, and its own account of why a reading might still be drifting.
  - **AT24C256 and the 24-series EEPROMs** — a hex viewer and editor. One
    driver and one panel cover AT24C01 through AT24C512, because the family
    differs only in capacity, page size and address width; a new part is a row
    in `EEPROM_TYPES` and a row in the catalogue. Everything else follows from
    those three numbers, including which I²C addresses the part can sit at:
    one with more storage than its word address can reach borrows the low bits
    of the I²C address, taking `ceil(size / span)` consecutive addresses — the
    rule from Linux's [at24 driver][at24]. So a 24C04 eats two addresses and
    can only start on an even one, and a 24C16 eats all eight and its A-pins
    do nothing. The panel draws the page grid
    because page boundaries are where these parts bite: a write running past
    the end of a page does not continue into the next, it wraps to the start of
    the same page and silently overwrites what it just stored. The driver
    splits every write so that cannot happen, and the emulator reproduces the
    wrap so a driver that stopped splitting would fail the tests rather than
    someone's board.
  - **SHT45 / SHT4x** — Sensirion's precision part, sharing every line of the
    AHT10's panel. The two differ only in what the driver declares: the SHT has
    a precision setting, a serial number and a heater, and the AHT has a reset
    button. The heater is the reason the filtered version exists — the PTFE cap
    keeps liquid off the polymer, but after a long soak near saturation the
    polymer holds water and reads high, and actual condensation pins it near
    100% until it clears. A pulse drives both off, at the cost of warming the
    die, so the panel counts down how long the temperature is still measuring
    the heater rather than the room.
  - **HDC3022 / HDC302x** — TI's precision part, on the same shared panel as
    the AHT10 and SHT45. Adding it was a driver and no UI at all, which was the
    point of the refactor. Its heater *latches* rather than pulsing, so closing
    the panel puts it out — a forgotten one goes on warming the die long after
    the tab has gone.
  - **AS5600 magnetic encoder** — a dial, with the magnet's health above it.
    That ordering is the whole point: the part reports a clean number between 0
    and 360 whether the magnet is well placed, too far, too close, or *absent*,
    and in that last case it is reporting noise while looking exactly like a
    working encoder. The status bits and the automatic gain are the only things
    that say otherwise — the chip winds the gain up as the field weakens, so a
    saturated figure means the gap is wrong in one direction or the other — and
    when they do, the dial greys rather than staying authoritative. Turn
    counting is the driver's job, since the chip wraps at 360 and has no idea
    how many times it has been round.
  - **SSD1306 OLED** — the generic 128×64 (or 128×32) module, with test
    patterns. Patterns rather than a status readout because the I²C interface
    is *write-only*: there is no way to ask the panel what it is showing, what
    size it thinks it is, or whether it is doing anything at all beyond the
    address ACK. A module with its charge pump disabled accepts every byte
    exactly like a working one. So each pattern is chosen so its appearance
    names a fault — nothing at all is the charge pump, a border missing its
    bottom edge is a 32-row panel driven as 64, and a ruler whose ends wrap is
    an SH1106 wearing the SSD1306's name, with 132 columns of RAM starting two
    in. The preview is labelled as what was *sent*, every time, because a dark
    screen beside a perfect preview is the normal failure and a picture on a
    page is very easy to mistake for a screenshot. The panel does not poll: a
    frame is a kilobyte and there is nothing to read back.
  - **BMP390 / BMP388** — barometric pressure, and a panel that leads with
    height above a datum rather than with altitude. Altitude is not measured:
    it is inferred from pressure through a model atmosphere that has to be told
    today's sea-level pressure, and that reference is weather. It moves some
    thirty hectopascals between a deep low and a strong high, which at ~8.3 m
    per hPa is about 250 m of apparent altitude from nothing but the forecast.
    What the part is extraordinary at is the *difference*: Bosch quote ±0.03 hPa
    relative — they give it as ±25 cm — against ±0.50 hPa absolute, some four
    metres before the reference error is counted. Two readings minutes apart
    share their offset, so it cancels. The part cannot tell you where you are,
    and can tell you that you climbed 40 cm.

    The measurement is taken in the driver rather than through the library's
    properties. Each of `pressure`, `temperature` and `altitude` triggers its
    own forced conversion, so the obvious reading costs three of them and hands
    back a pressure compensated with a temperature the caller never saw. The
    library's wait for conversion is also unbounded, and the transport's spin
    detector does not cover it — that fires on one HID report repeating, and
    each turn of this loop is a whole write-then-read. A test established that
    by hanging. So the wait has a deadline sized from the datasheet's own
    maximum conversion time, and the compensation is copied in with a test
    asserting it agrees with the library's on the same raw counts.
  - **TSL2591 light sensor** — six decades of illuminance, which the part only
    actually has if the gain and integration time suit the light. Choosing them
    is the work of using this sensor, so the driver auto-ranges: from an
    unsaturated count the right setting is calculable rather than searched for,
    and from a saturated one it drops to the bottom of the ladder and calculates
    from there — two integrations from anywhere. The stock library raises
    `RuntimeError` on overflow, which blanks a panel exactly when you point it
    at a window, so lux is computed here from the raw channels instead. When
    both channels pin there is no number reported at all: the equation
    subtracts infrared from visible, so two equal clipped counts cancel, and
    any "floor" would be invented. The infrared share comes free from the same
    two registers and says roughly what is lighting the room.
  - **BMI160 IMU** — six axes on a shared panel that any other inertial part
    can reuse: a driver declares its groups of three and the panel draws them.
    Three things it is built around. The axes are read in **one 12-byte burst**,
    because on this bus a per-axis read puts ten milliseconds between X and Z
    and a vector assembled from three instants is not a vector — each component
    still looks fine, only the magnitude gives it away. A **gyroscope at rest
    does not read zero**, so the offset is measured, subtracted, and quoted as
    the heading error it would otherwise cause per minute, which is the number
    that matters and the one °/s hides. And an **accelerometer at rest reads
    one g**, which makes the magnitude a free running check on the whole chain
    and the precondition for the tilt angles — they come from the direction of
    gravity, so the panel greys them the moment the part is accelerating.
    There is no yaw, because it cannot be recovered this way at all.

    The configuration registers are read once at open and after each write,
    never in a poll. That is not tuning: reading them back every time — the
    natural way to write it — costs ten transactions per reading instead of
    one, which at ~20 ms each is 190 ms against a 200 ms timer. A bus at
    ninety-five per cent falls behind, and a repeated-start read abandoned
    between its halves leaves the part holding the line with no STOP ever sent,
    which wedges every transaction after it. A test pins the count.

    The stock `circuitpython-bmi160` handles identity, reset and power modes.
    Its own scale and rate tables are not used: the gyroscope sensitivity table
    is reversed end for end, the accelerometer's output-rate table is off by
    one, and the gyroscope's raises `IndexError` at the part's reset default.
  - **AS7341 spectral sensor** — the eight visible channels drawn as a
    spectrum, each bar at its own wavelength's colour, plus clear and near-IR.
    Plotted in *basic counts* — raw divided by gain and integration time —
    because raw counts scale with both, so a spectrum drawn from them changes
    when you touch a setting even though the light did not. Change the gain by
    16× and the plot should not move; if it does, something is clipping.
    Saturated channels are drawn hollow and named, since a channel at full
    scale is reporting a floor rather than a measurement and the bars either
    side of it describe a spectrum that does not exist.
  - **RV-1805 RTC** — the clock, and the thing a clock panel is actually for:
    drift. Reading a clock once tells you nothing about it, since one thirty
    seconds out and one gaining thirty seconds a day look identical in a single
    sample. The panel measures the rate against the host across the session and
    states the precision that measurement currently supports — over a short
    window the answer is quantisation, and "±217 ppm so far" is worth more than
    a confident 3. It also surfaces which oscillator is running: falling back
    to the internal RC costs orders of magnitude of accuracy and changes
    nothing about how the time registers look.

    The panel is generic ([`rtc.ts`](src/ui/panels/rtc.ts)); a part supplies
    where its time registers are, what its status bits mean and how finely it
    counts fractions of a second. DS3231, DS1307 and PCF8563 differ in exactly
    those, so each is a driver and no UI.

    A status row that can be resolved carries its own fix: the oscillator
    failure latch is set from the factory on any part whose crystal has not
    been running, so a new one always reports it, and the row offers the Clear
    that retires it. Setting the clock clears it too, since writing the time is
    what makes the reading trustworthy again.
- **Python** — the REPL and the PyPI installer.

The EEPROM driver does not use `adafruit_24lc32`, the family's CircuitPython
driver, and the reason is measured rather than aesthetic: it writes one byte at
a time with a flat 5 ms sleep after each, which on a 32 KiB AT24C256 is 164
seconds of sleeping before any bus traffic, against 2.6 seconds page-at-a-time.
It builds on `adafruit_bus_device` instead, which is still a real CircuitPython
library, one level down.

`input`/`output`/`analog_in`/`analog_out` go through `digitalio` and `analogio`,
because running the real CircuitPython API is the point. The rest are chip
functions CircuitPython has no vocabulary for, so
[`mcp2221_chip.py`](python/webblinka/mcp2221_chip.py) speaks the datasheet's
report protocol over the HID transport Blinka already owns. Still no fork.

## When the bus misbehaves

Any failed call into Python dumps the last two dozen HID transfers to the log —
command, reply, and the I²C engine state the chip reported. So does any report
that the bus is unhealthy, even when nothing threw: a chip claiming to be wedged
on a free bus is at least as likely to be us misreading the reply as it is to be
the hardware. Python's traceback tells you which line raised; only the bytes tell
you why, which matters when the hardware is on someone else's desk.

Two rules about not provoking the chip, both learned by breaking it:

**Look before you cancel.** Cancelling drives a STOP, and an idle engine has no
transaction for that STOP to terminate — on a quiet bus it times out, and a chip
that was fine now reports `stop timeout`. `force_idle()` reads the status first
and only cancels if there is something to cancel.

**Then cancel once.** Re-sending it on every poll re-triggers the wind-down being
waited on, pinning the engine in the state it is trying to leave.

`Mcp2221Emulator.stopTimeoutOnSpuriousCancel` and `.cancelRestartsOnRepeat` model
both, and both default to on: code that only works against the forgiving reading
of the datasheet is code that breaks on real hardware.

The engine's state byte is **not** treated as evidence of a fault. It reports the
last thing the engine did, and a NACKed probe or a late cancel leaves a code
sitting there that clears on the next transfer — Blinka itself just cancels and
carries on. Only a line held low gets reported as a problem, because that is
measurable and unambiguous.

The MCP2221's cancel is a request the engine takes a few hundred microseconds to
honour. Blinka waits a flat millisecond and then issues its next command, so when
the wind-down runs long the command is rejected as busy and Blinka reads that as
`Unrecoverable I2C state failure`. `force_idle()` polls until the engine really
is idle instead of assuming, and the scan recovers per-address rather than
abandoning the sweep. `Mcp2221Emulator.cancelLatency` reproduces the window.

Some states no cancel can reach — a transfer abandoned mid-flight leaves the
engine trying to issue a STOP forever, and it survives page reloads because
webblinka does not reset the chip at startup the way Blinka does (a reset drops
the device off USB, invalidating the page's `HIDDevice`). **Reset chip** does it
properly: resets, waits for the re-enumerated device, swaps the handle
underneath Python, and re-reads the chip's real pin configuration into Blinka's
cache. `Mcp2221Emulator.wedge()` reproduces the state.

Which of the two you have is decided by the SCL/SDA levels, which is why they
are reported rather than guessed at. Both high means the bus is free and the
chip is stuck, so a reset fixes it. Either low means a device is holding a line
down, and resetting the MCP2221 cannot release someone else's line — that one is
wiring or pull-ups.

Scanning is not automatic on connect: it writes to every address on the bus, so
it happens when you open the I²C tab, and again whenever you press Scan.

## Demo mode

Marked everywhere it appears — a banner, a `· simulated` suffix on every panel
heading, and a status pill that says Demo rather than Connected. The readings
are indistinguishable from real ones by construction, which is the point of the
emulator and also its hazard: an invented GPS fix reads exactly like a receiver
reporting the wrong place.


No adapter? [`src/hid/mcp2221-emulator.ts`](src/hid/mcp2221-emulator.ts) is a
software MCP2221 speaking the same HID command protocol, with a synthetic
PA1010D GPS on its I²C bus that acquires a fix over the first few seconds. The
same emulator backs the test suite, so CI exercises the full stack — Pyodide,
the shim, JSPI, stock Blinka — with no hardware attached.

## Deploying

Pushing to `main` builds and publishes to GitHub Pages
([`deploy.yml`](.github/workflows/deploy.yml)). The deploy is gated on the test
job, so a red suite does not ship.

One setting has to be changed by hand, once: **Settings → Pages → Source →
GitHub Actions**. Without it the workflow succeeds and nothing is served.

The base path is derived from the repository name, so the site works whether it
is a project page at `/<repo>/` or a user page at the root. Hard-coding it is
the classic cause of a deploy that reports success and loads a blank page,
because every asset 404s one directory up.

Pyodide itself comes from the jsDelivr CDN; the ~1.4 MB of CircuitPython wheels
are served from the site. Nothing else is fetched at runtime.

## Development

Node comes from `.nvmrc` and must be new enough for unflagged JSPI (Node 24 is
not; 25 and later are). Python only ever runs inside Pyodide, so uv's only job
here is fetching the vendored wheels.

```bash
nvm use && npm install
```

| command | what it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm test` | full stack in Node against the emulator |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | typecheck + production build into `dist/` |
| `npm run wheels` | re-vendor `public/wheels/` via `uv` |

Imports carry explicit `.ts` extensions so Node can run `src/` directly with its
built-in type stripping — that is how the tests exercise the real emulator and
bootstrap code rather than a copy of them.

### Adding a device

Three pieces, and nothing else changes — not the RPC layer, not the tab shell,
not the scanner:

1. A `Driver` subclass in [`python/webblinka/drivers/`](python/webblinka/drivers/)
   with `start` / `poll` / `command` / `stop`, decorated `@register("your-id")`,
   and imported in `rpc.py`'s `_load_handlers`.
2. A panel implementing [`DevicePanel`](src/devices/panel.ts). It is handed a
   session bound to one running instance and never learns its own address or
   handle, so the same class serves two of the same part on one bus.
3. An entry in [`src/devices/catalog.ts`](src/devices/catalog.ts) listing every
   I²C address the part can answer at.

The addresses are what connect a scan to a panel. A scan proposes matching
devices and the person decides — an address only says *something* answered, and
parts share addresses, so detection is never taken as identification. Nothing
talks to a device until you open it, which matters because starting a driver
configures the part.

If you add a wheel, remember `scripts/fetch_wheels.py`.

A panel that polls must stop on `hide()` — every tick is real traffic competing
for the bus. And add a `VirtualI2cDevice` under `src/hid/devices/` so the part
works in demo mode and in CI without hardware.

See [`gps_pa1010d.py`](python/webblinka/drivers/gps_pa1010d.py) and
[`gps.ts`](src/ui/panels/gps.ts) for the shape.

### Adding a chip-level panel

Panels for the MCP2221 itself — rather than something on its bus — are plain
`@handler` functions plus a static tab in `src/ui/app.ts`. GPIO and Common work
this way.

## Deployment

`.github/workflows/deploy.yml` runs the test suite and publishes `dist/` to
GitHub Pages on pushes to `main`. The Vite `base` defaults to `/webblinka/` for
project pages; set `BASE_PATH=/` for a custom domain or a user/org page.

Pyodide's ~10MB runtime loads from the jsDelivr CDN. The ~1.4MB of CircuitPython
wheels are vendored in `public/wheels/` and served from the site itself, so a
cold start does not depend on PyPI.

[mcp2221]: https://www.microchip.com/en-us/product/MCP2221
[jspi]: https://developer.chrome.com/blog/webassembly-jspi
[playground]: https://github.com/johntalton/webapp-device-playground
[at24]: https://github.com/torvalds/linux/blob/master/drivers/misc/eeprom/at24.c
