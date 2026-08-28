// The SSD1306 driver, end to end: stock adafruit_ssd1306 against the emulated
// panel, through Blinka and the hid shim.
//
// The assertions here are about what would be *visible*, not about what was
// written. A display is write-only, so every one of these faults -- a disabled
// charge pump, a wrong height, an SH1106 wearing the wrong name -- succeeds
// completely on the bus and shows nothing, or shows the wrong thing. The
// emulator models the glass so the tests can tell those apart.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bootStack, chipWithScreen } from "./fixtures/stack.mjs";

const HANDLE = "ssd1306@0x3c";

async function open(options = {}) {
  const { chip, screen } = chipWithScreen(options);
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "ssd1306", 0x3c);
  return { call, screen, draw: (key) => call("device_command", HANDLE, "pattern", [key]) };
}

/** The visible frame as rows of booleans, for readable assertions. */
function rows(screen) {
  const pixels = screen.visible();
  return Array.from({ length: screen.rows }, (_, y) =>
    Array.from({ length: 128 }, (_, x) => pixels[y * 128 + x] === 1),
  );
}

test("initialising enables the charge pump", async () => {
  // Without it the panel is dark whatever is in memory, and every write still
  // ACKs. It is the single most common reason one of these "does not work".
  const { screen } = await open();
  assert.equal(screen.chargePumpOn, true);
  assert.equal(screen.displayOn, true);
});

test("all-on lights every pixel the glass has", async () => {
  const { draw, screen } = await open();
  await draw("all_on");
  const lit = screen.visible().filter(Boolean).length;
  assert.equal(lit, 128 * 64, `${lit} of ${128 * 64} pixels lit`);
});

test("the border lands on all four edges", async () => {
  // The geometry test, and the reason it is a *border* rather than a box: it
  // touches the last row and the last column, which is where a wrong height or
  // width shows up and nowhere else does.
  const { draw, screen } = await open();
  await draw("border");
  const grid = rows(screen);

  assert.ok(grid[0].every(Boolean), "top edge");
  assert.ok(grid[63].every(Boolean), "bottom edge");
  assert.ok(grid.every((row) => row[0]), "left edge");
  assert.ok(grid.every((row) => row[127]), "right edge");
  assert.equal(grid[32][64], false, "and nothing in the middle");
});

test("a 32-row panel driven as 64 loses its bottom edge", async () => {
  // The failure the border pattern exists to name, and it is not a blank half:
  // the COM pin layout is chosen from the height the library was given, so the
  // glass interlaces and shows every other row of the buffer. All-on cannot
  // reveal that -- every row is lit either way. The border can, because the
  // bottom edge falls on a row that is no longer scanned.
  const wrong = await open({ rows: 32 });
  await wrong.draw("border");
  const grid = rows(wrong.screen);
  assert.ok(grid[0].every(Boolean), "top edge survives");
  assert.ok(!grid[31].every(Boolean), "bottom edge does not");

  // Told the truth, the frame closes.
  const right = await open({ rows: 32 });
  await right.call("device_command", HANDLE, "set_size", ["128x32"]);
  await right.draw("border");
  const fixed = rows(right.screen);
  assert.ok(fixed[0].every(Boolean), "top edge");
  assert.ok(fixed[31].every(Boolean), "and now the bottom edge too");
});

test("the ruler marks both end columns, so a column offset shows", async () => {
  // An SH1106 sold as an SSD1306 has 132 columns of RAM and starts two in.
  // Ordinary images look fine; only something touching the extreme columns
  // reveals it.
  const honest = await open();
  await honest.draw("ruler");
  const straight = rows(honest.screen);
  assert.ok(straight.every((row) => row[0]), "left end column marked");
  assert.ok(straight.every((row) => row[127]), "right end column marked");

  const sh1106 = await open({ columnOffset: 2 });
  await sh1106.draw("ruler");
  const shifted = rows(sh1106.screen);
  assert.ok(
    !shifted.every((row) => row[0]) || !shifted.every((row) => row[127]),
    "a two-column offset has to break one of the ends",
  );
});

test("page stripes alternate on the eight-row boundary", async () => {
  // One byte is eight vertical pixels, so this is the memory's own grain.
  const { draw, screen } = await open();
  await draw("pages");
  const grid = rows(screen);

  for (let y = 0; y < 64; y++) {
    const expected = Math.floor(y / 8) % 2 === 0;
    assert.equal(grid[y][10], expected, `row ${y}`);
  }
});

test("the preview is the bytes that were sent", async () => {
  // The panel draws this, so it has to be the real buffer in the real layout
  // rather than anything reconstructed.
  const { draw, screen } = await open();
  const state = await draw("border");

  const frame = Buffer.from(state.frame, "base64");
  assert.equal(frame.length, (128 * 64) / 8, "one bit per pixel");
  // Top page: the top edge is bit 0 of every byte, and the two end columns are
  // solid, so the first and last bytes of the page differ from the rest.
  assert.equal(frame[0], 0xff, "left column is solid in the top page");
  assert.equal(frame[1] & 0x01, 0x01, "top edge set in the next column");

  assert.equal(state.width, 128);
  assert.equal(state.height, 64);
  assert.equal(state.previewIsSent, true);
  // The frame really did go out, and the panel reports what that cost.
  assert.equal(state.bytesSent, 1024);
  assert.ok(screen.anythingVisible);
});

test("switching the display off keeps the memory", async () => {
  const { call, draw, screen } = await open();
  await draw("all_on");

  await call("device_command", HANDLE, "set_power", [false]);
  assert.equal(screen.anythingVisible, false, "dark");

  await call("device_command", HANDLE, "set_power", [true]);
  assert.equal(screen.visible().filter(Boolean).length, 128 * 64, "and back, unresent");
});

test("contrast and invert reach the controller", async () => {
  const { call, draw, screen } = await open();
  await draw("all_off");

  await call("device_command", HANDLE, "set_invert", [true]);
  assert.equal(screen.inverted, true);
  // Inversion happens on the controller, so a blank buffer now lights up --
  // which is exactly why the preview does not follow it.
  assert.ok(screen.anythingVisible, "an inverted blank screen is lit");

  await call("device_command", HANDLE, "set_contrast", [0x20]);
  assert.equal(screen.contrast, 0x20);
});

test("text draws, despite the font not being in the wheel", async () => {
  // framebuf.text() opens font5x8.bin at draw time. Adafruit ship it beside the
  // library rather than inside it, so installing the package leaves text()
  // raising on any filesystem that has never seen the file -- which is every
  // filesystem here. The font travels base64 in a module instead.
  const { draw, screen } = await open();
  const state = await draw("text");

  const lit = screen.visible().filter(Boolean).length;
  assert.ok(lit > 200, `only ${lit} pixels lit — the glyphs did not render`);
  // Text sits in the top rows and leaves the bottom of a 64-row panel empty,
  // which distinguishes real glyphs from a fill that happened to succeed.
  const grid = rows(screen);
  assert.ok(grid[60].every((pixel) => !pixel), "nothing down at row 60");
  assert.equal(state.pattern, "text");
});

test("the screen is found by a scan and matched to its panel", async () => {
  const { chip } = chipWithScreen();
  const { call } = await bootStack({ chip });
  await call("connect");
  assert.deepEqual(await call("i2c_scan"), [0x3c]);
});
