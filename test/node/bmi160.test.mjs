// The BMI160 driver, end to end: the stock circuitpython-bmi160 library for
// identity and configuration, against the emulated part, through Blinka.
//
// The assertions are about the things a per-axis readout cannot show you: that
// the six axes describe one instant, that the scaling is right where the
// library's own table is not, and that a stationary gyro is not reading zero.

import { test } from "node:test";
import assert from "node:assert/strict";

import { VirtualBmi160 } from "../../src/hid/devices/bmi160.ts";
import { NackError } from "../../src/hid/i2c-device.ts";
import { Mcp2221Emulator } from "../../src/hid/mcp2221-emulator.ts";
import { bootStack, chipWithImu } from "./fixtures/stack.mjs";

/** An IMU with no offset and no self-heating, so the numbers are exact. */
function steady(options = {}) {
  const chip = new Mcp2221Emulator();
  const imu = new VirtualBmi160({ biasDps: [0, 0, 0], now: () => 0, ...options });
  chip.attach(imu);
  return { chip, imu };
}

async function open(rig) {
  const { call } = await bootStack({ chip: rig.chip });
  await call("connect");
  await call("device_start", "bmi160", rig.imu.address);
  const handle = `bmi160@0x${rig.imu.address.toString(16).padStart(2, "0")}`;
  return { call, poll: () => call("device_poll", handle), handle };
}

test("a level board reads one g straight down and no tilt", async () => {
  const { poll } = await open(steady({ rollDeg: 0, pitchDeg: 0 }));
  const state = await poll();

  // The magnitude is the whole check: gravity does not switch off, so at rest
  // it must come to one g whatever the orientation.
  assert.ok(Math.abs(state.accelMagnitudeG - 1) < 0.001, `got ${state.accelMagnitudeG} g`);
  assert.ok(Math.abs(state.tilt.rollDeg) < 0.1, `roll ${state.tilt.rollDeg}`);
  assert.ok(Math.abs(state.tilt.pitchDeg) < 0.1, `pitch ${state.tilt.pitchDeg}`);
  assert.equal(state.tilt.usable, true);
  assert.equal(state.still, true);
});

test("tilt round-trips through gravity", async () => {
  // The emulator resolves gravity onto the axes; the driver recovers the angles
  // from it. Round-tripping proves both directions rather than one convention
  // agreeing with itself.
  const { poll } = await open(steady({ rollDeg: 30, pitchDeg: -15 }));
  const state = await poll();

  assert.ok(Math.abs(state.tilt.rollDeg - 30) < 0.5, `roll ${state.tilt.rollDeg}`);
  assert.ok(Math.abs(state.tilt.pitchDeg + 15) < 0.5, `pitch ${state.tilt.pitchDeg}`);
  assert.ok(Math.abs(state.accelMagnitudeG - 1) < 0.001, "still exactly one g");
});

test("the magnitude stays one g at any attitude", async () => {
  // Which is the property that fails when the axes are read one at a time on a
  // moving board: each component still looks reasonable, the magnitude does not.
  for (const [roll, pitch] of [[0, 0], [45, 0], [0, 60], [80, -70], [-120, 25]]) {
    const { poll } = await open(steady({ rollDeg: roll, pitchDeg: pitch }));
    const state = await poll();
    assert.ok(
      Math.abs(state.accelMagnitudeG - 1) < 0.002,
      `${roll}/${pitch} gave ${state.accelMagnitudeG} g`,
    );
  }
});

test("the gyro scale is right where the library's table is reversed", async () => {
  // circuitpython-bmi160 maps ±125 °/s to 16.4 LSB/°/s and ±2000 to 262.4. It
  // is the other way round -- the output is a signed 16-bit word spanning the
  // range, so the narrowest range has the *largest* count per degree. Using
  // the library's `gyro` property would report this 100 °/s as 6.1 at ±125.
  const rig = steady({ rateDps: [100, 0, 0] });
  const { call, poll } = await open(rig);

  await call("device_command", rig.imu.address === 0x68 ? "bmi160@0x68" : "bmi160@0x69",
    "set_gyro_range", [0b100]); // ±125 °/s
  const narrow = await poll();
  assert.ok(Math.abs(narrow.gyroDps[0] - 100) < 1, `±125 gave ${narrow.gyroDps[0]} °/s`);

  await call("device_command", "bmi160@0x68", "set_gyro_range", [0b000]); // ±2000 °/s
  const wide = await poll();
  assert.ok(Math.abs(wide.gyroDps[0] - 100) < 1, `±2000 gave ${wide.gyroDps[0]} °/s`);
});

test("the six axes come from one burst, not six reads", async () => {
  // The registers are laid out consecutively so a vector can be taken at one
  // instant. Reading them separately is what makes a turning board report a
  // magnitude that is not one g.
  const rig = steady({ rollDeg: 20, pitchDeg: 10 });
  const { call } = await open(rig);

  let widest = 0;
  const original = rig.imu.read.bind(rig.imu);
  rig.imu.read = (length) => {
    widest = Math.max(widest, length);
    return original(length);
  };
  await call("device_poll", "bmi160@0x68");

  assert.equal(widest, 12, `widest read was ${widest} bytes, expected one 12-byte burst`);
});

test("a stationary gyro does not read zero, and says what that costs", async () => {
  // The point of the whole panel. An offset of about 1.8 °/s looks like a small
  // honest reading; as heading error it is over a hundred degrees a minute.
  const chip = new Mcp2221Emulator();
  chip.attach(new VirtualBmi160({ biasDps: [0.9, -1.4, 0.6], now: () => 0 }));
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "bmi160", 0x68);

  const state = await call("device_poll", "bmi160@0x68");
  assert.equal(state.still, true, "the board is not moving");
  assert.ok(state.gyroMagnitudeDps > 1, `but reads ${state.gyroMagnitudeDps} °/s`);
  assert.ok(
    state.headingDriftDegPerMin > 100,
    `which is ${state.headingDriftDegPerMin} °/min of heading`,
  );
});

test("zeroing removes the offset", async () => {
  const chip = new Mcp2221Emulator();
  chip.attach(new VirtualBmi160({ biasDps: [0.9, -1.4, 0.6], now: () => 0 }));
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "bmi160", 0x68);

  const zeroed = await call("device_command", "bmi160@0x68", "zero_gyro", []);
  assert.equal(zeroed.zeroResult.ok, true, zeroed.zeroResult.text);
  assert.ok(zeroed.gyroMagnitudeDps < 0.05, `left ${zeroed.gyroMagnitudeDps} °/s`);
  assert.ok(zeroed.biasMagnitudeDps > 1, "and recorded what it removed");

  // A real rate still comes through afterwards -- zeroing removes the offset,
  // not the signal.
  const imu = chip.devices.find((d) => d.address === 0x68);
  imu.rateDps = [50, 0, 0];
  const turning = await call("device_poll", "bmi160@0x68");
  assert.ok(Math.abs(turning.gyroDps[0] - 50) < 0.5, `got ${turning.gyroDps[0]} °/s`);
});

test("zeroing while the board moves is refused, not recorded", async () => {
  // Capturing an offset from a moving board bakes the movement in permanently,
  // and every later reading is wrong by it with nothing on screen to say so.
  const chip = new Mcp2221Emulator();
  chip.attach(new VirtualBmi160({ biasDps: [0.5, 0, 0], rateDps: [40, 0, 0], now: () => 0 }));
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "bmi160", 0x68);

  const result = await call("device_command", "bmi160@0x68", "zero_gyro", []);
  assert.equal(result.zeroResult.ok, false);
  assert.match(result.zeroResult.text, /still/i);
  assert.equal(result.zeroed, false, "nothing was recorded");
});

test("acceleration invalidates the tilt rather than lying about it", async () => {
  // The part cannot tell gravity from any other specific force, so a board
  // being pushed reports itself as tilted. The magnitude is what gives it away.
  const { poll } = await open(steady({ rollDeg: 0, pitchDeg: 0, accelG: [0.5, 0, 0] }));
  const state = await poll();

  assert.ok(state.accelMagnitudeG > 1.05, `magnitude ${state.accelMagnitudeG} g`);
  assert.equal(state.tilt.usable, false, "so the angles are not to be trusted");
  assert.equal(state.still, false);
  assert.match(state.tilt.text, /accelerating/i);
});

test("the accelerometer range changes the resolution, not the reading", async () => {
  const rig = steady({ rollDeg: 25, pitchDeg: 0 });
  const { call, poll } = await open(rig);

  const narrow = await poll();
  await call("device_command", "bmi160@0x68", "set_accel_range", [0b1100]); // ±16 g
  const wide = await poll();

  assert.equal(narrow.groups[0].range, 2);
  assert.equal(wide.groups[0].range, 16);
  assert.ok(Math.abs(wide.accelMagnitudeG - 1) < 0.01, `got ${wide.accelMagnitudeG} g`);
});

test("the chip ID is checked rather than the address trusted", async () => {
  // 0x69 is the RV-1805's address too, and 0x68 a DS3231's. Something
  // answering is not evidence that it is an IMU.
  const chip = new Mcp2221Emulator();
  const imposter = new VirtualBmi160({ address: 0x69 });
  // Everything about it is right except the one byte the library checks.
  imposter.read = (length) => new Uint8Array(length);
  chip.attach(imposter);
  const { call } = await bootStack({ chip });
  await call("connect");

  await assert.rejects(() => call("device_start", "bmi160", 0x69), /BMI160/);
});

test("the die temperature is reported, and labelled as the gyro's", async () => {
  const { poll } = await open(steady({ ambientC: 25 }));
  const state = await poll();

  assert.ok(Math.abs(state.temperatureC - 25) < 0.5, `got ${state.temperatureC} °C`);
  assert.match(state.temperatureNote, /zero-rate offset/);
});

test("the IMU is found by a scan and matched to its panel", async () => {
  const { chip } = chipWithImu();
  const { call } = await bootStack({ chip });
  await call("connect");
  assert.deepEqual(await call("i2c_scan"), [0x68]);
});

test("a poll costs one bus transaction, not ten", async () => {
  // This is a regression guard with a real failure behind it. The natural way
  // to write the driver reads the ranges and output rates back on every poll,
  // which turns a 22-byte reading into ten transactions. At roughly 20 ms each
  // on this bus that is 190 ms against the panel's 200 ms timer -- the bus sits
  // at ninety-five per cent, falls behind, and a repeated-start read abandoned
  // between its halves leaves the part holding the line and the panel frozen.
  // None of those registers changes unless this driver changes it.
  const rig = steady();
  const { call } = await open(rig);

  let transactions = 0;
  const original = rig.imu.read.bind(rig.imu);
  rig.imu.read = (length) => {
    transactions++;
    return original(length);
  };

  await call("device_poll", "bmi160@0x68"); // the first also fetches temperature
  transactions = 0;
  for (let i = 0; i < 5; i++) await call("device_poll", "bmi160@0x68");

  assert.ok(transactions <= 6, `${transactions} transactions for five polls`);
});

test("changing a range still takes effect, cached or not", async () => {
  // The other side of caching: a stale cache would report the old full scale
  // for ever, and every reading would be scaled by it.
  const rig = steady({ rateDps: [300, 0, 0] });
  const { call, poll } = await open(rig);

  await call("device_command", "bmi160@0x68", "set_gyro_range", [0b011]); // ±250
  const narrow = await poll();
  assert.equal(narrow.groups[1].range, 250);
  // 300 °/s does not fit in ±250, so it pins -- which the panel shows rather
  // than reporting a wrapped value as a real rate.
  assert.ok(Math.abs(narrow.gyroDps[0]) >= 249, `got ${narrow.gyroDps[0]} °/s`);

  await call("device_command", "bmi160@0x68", "set_gyro_range", [0b000]); // ±2000
  const wide = await poll();
  assert.equal(wide.groups[1].range, 2000);
  assert.ok(Math.abs(wide.gyroDps[0] - 300) < 2, `got ${wide.gyroDps[0]} °/s`);
});

test("a bus left holding the line is recovered, not surrendered to", async () => {
  // The wedge this exists for: the part is left waiting mid-transaction with
  // no STOP sent, so it holds the bus and every later transaction fails at the
  // address phase. Cancelling the engine drives the STOP that releases it.
  const rig = steady();
  const { call } = await open(rig);

  let failures = 1;
  const original = rig.imu.read.bind(rig.imu);
  rig.imu.read = (length) => {
    if (failures-- > 0) throw new NackError("holding the line");
    return original(length);
  };

  const state = await call("device_poll", "bmi160@0x68");
  assert.ok(failures < 0, "the injected failure was actually hit");
  assert.ok(Math.abs(state.accelMagnitudeG - 1) < 0.01, "and the poll still came back");
});

test("a bus that stays stuck raises rather than being swallowed", async () => {
  // The other half. One cancel and one retry turns a wedge into a dropped
  // frame; retrying for ever would turn a genuinely stuck bus into a panel
  // that shows plausible stale numbers and never says anything is wrong.
  const rig = steady();
  const { call } = await open(rig);
  rig.imu.read = () => {
    throw new NackError("holding the line");
  };

  await assert.rejects(() => call("device_poll", "bmi160@0x68"));
});
