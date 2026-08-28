// Blinka's MCP2221 write path contains one unbounded loop:
//
//     while self._i2c_state() == RESP_I2C_PARTIALDATA:
//         time.sleep(0.001)
//
// No retry counter, no timeout. Every other loop in that file is bounded by
// MCP2221_RETRY_MAX; this one is not. If the engine parks at 0x41 it spins for
// ever -- and because each iteration is a HID transfer, and HID lives on the
// page's main thread, it does not merely hang Python. It floods the main thread
// with round trips a millisecond apart and takes the whole tab down with it,
// which is what a user sees as the UI freezing rather than a panel erroring.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Mcp2221Emulator } from "../../src/hid/mcp2221-emulator.ts";
import { VirtualBmi160 } from "../../src/hid/devices/bmi160.ts";
import { bootStack } from "./fixtures/stack.mjs";

/** 0x41: the engine reports it is part-way through a write. */
const STATE_PARTIALDATA = 0x41;

test("a bus parked in PARTIALDATA fails instead of spinning for ever", async () => {
  const chip = new Mcp2221Emulator();
  chip.attach(new VirtualBmi160({ now: () => 0 }));
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "bmi160", 0x68);
  await call("device_poll", "bmi160@0x68");

  // Park the engine where Blinka waits without a bound, the way a bus glitch
  // mid-write does on hardware.
  chip.stallWrites(STATE_PARTIALDATA);

  const began = Date.now();
  let message = "";
  const poll = call("device_poll", "bmi160@0x68").then(
    () => "resolved",
    (err) => {
      message = String(err);
      return "rejected";
    },
  );
  const outcome = await Promise.race([
    poll,
    new Promise((resolve) => setTimeout(() => resolve("still spinning"), 10_000)),
  ]);

  assert.equal(outcome, "rejected", "must not spin");
  // Quickly, because the whole point is that the tab stays responsive. Blinka's
  // own bounded loops stop after fifty identical reads, so tripping at four
  // hundred cannot fire on one of those and still lands well inside a second.
  assert.ok(Date.now() - began < 5000, `took ${Date.now() - began} ms to give up`);
  // And it has to say something the user can act on. "Unrecoverable I2C state
  // failure" from inside Blinka names neither the state nor what to do.
  assert.match(message, /stuck in state 0x41/, message.slice(0, 200));
  assert.match(message, /check the wiring/);
});

test("an ordinary retry loop is nowhere near the spin limit", async () => {
  // The counter must not fire on legitimate waiting. Blinka polls status up to
  // MCP2221_RETRY_MAX times in several places, and the panels poll the chip
  // status on a timer; neither is a spin, and breaking either would trade a
  // rare freeze for constant spurious failures.
  const chip = new Mcp2221Emulator();
  chip.attach(new VirtualBmi160({ now: () => 0 }));
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "bmi160", 0x68);

  for (let i = 0; i < 40; i++) {
    await call("chip_status");
    await call("device_poll", "bmi160@0x68");
  }
  assert.ok(true, "forty rounds of status polling did not trip the detector");
});
