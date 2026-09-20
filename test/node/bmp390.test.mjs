// The BMP390 driver, end to end: stock adafruit_bmp3xx against the emulated
// part, through Blinka and the hid shim.
//
// The interesting assertions are not about pressure. They are about what the
// part is and is not good for -- absolute altitude is an assumption about the
// weather, height above a datum is a quarter-metre measurement -- and about
// not triggering three conversions to report one reading.

import { test } from "node:test";
import assert from "node:assert/strict";

import { chipWithBarometer, bootStack } from "./fixtures/stack.mjs";

const HANDLE = "bmp3xx@0x77";

async function open(rig) {
  const { call } = await bootStack({ chip: rig.chip });
  await call("connect");
  await call("device_start", "bmp3xx", 0x77);
  return { call, poll: () => call("device_poll", HANDLE) };
}

test("reads back the pressure and temperature it was given", async () => {
  const rig = chipWithBarometer({ pressureHpa: 1008.4, temperatureC: 22.6 });
  const { poll } = await open(rig);
  const state = await poll();

  // The emulator inverts the same compensation the library evaluates, so a
  // round trip has to land back where it started.
  assert.ok(Math.abs(state.pressureHpa - 1008.4) < 0.05, `got ${state.pressureHpa} hPa`);
  assert.ok(Math.abs(state.temperatureC - 22.6) < 0.05, `got ${state.temperatureC} °C`);
});

test("one reading is one conversion, not three", async () => {
  // pressure, temperature and altitude are three properties on the library and
  // each one triggers its own forced measurement -- altitude by way of
  // pressure. At x32 oversampling a conversion is up to 78 ms, so the obvious
  // implementation costs three of them and returns a pressure compensated with
  // a temperature the caller never saw.
  const rig = chipWithBarometer({ pressureHpa: 1000, temperatureC: 20 });
  const { poll } = await open(rig);

  rig.sensor.conversions = 0;
  const state = await poll();

  assert.equal(rig.sensor.conversions, 1, "one forced measurement per reading");
  // And all three numbers came out of it.
  assert.ok(state.pressureHpa > 0 && state.temperatureC > 0 && state.altitudeM !== undefined);
});

test("altitude follows the sea-level reference, and says so", async () => {
  // The headline caveat. The same pressure is a different altitude under a
  // different reference, and the reference is weather: about 8.3 m per hPa, so
  // the ~30 hPa swing between a deep low and a strong high is some 250 m.
  const rig = chipWithBarometer({ pressureHpa: 1000 });
  const { call, poll } = await open(rig);

  const standard = await poll();
  await call("device_command", HANDLE, "set_sea_level", [1013.25]);
  const atStandard = (await poll()).altitudeM;

  await call("device_command", HANDLE, "set_sea_level", [983.25]); // 30 hPa lower
  const atLow = (await poll()).altitudeM;

  assert.ok(Math.abs(standard.altitudeM - atStandard) < 0.01, "1013.25 is the default");
  const moved = Math.abs(atStandard - atLow);
  assert.ok(moved > 200 && moved < 300, `30 hPa of reference moved altitude ${moved} m`);
});

test("a datum turns the same hardware into a quarter-metre measurement", async () => {
  const rig = chipWithBarometer({ pressureHpa: 1000 });
  const { call, poll } = await open(rig);

  assert.equal((await poll()).relativeM, null, "no datum, no relative height");

  await call("device_command", HANDLE, "set_datum", []);
  const atDatum = await poll();
  assert.ok(Math.abs(atDatum.relativeM) < 0.01, `datum is zero, got ${atDatum.relativeM}`);

  // 0.12 hPa is almost exactly one metre near sea level.
  rig.sensor.pressureHpa = 1000 - 0.12;
  const lifted = await poll();
  assert.ok(Math.abs(lifted.relativeM - 1) < 0.1, `expected ~1 m, got ${lifted.relativeM}`);

  // And it is signed: going back down reads negative, not as an absolute gap.
  rig.sensor.pressureHpa = 1000 + 0.12;
  assert.ok((await poll()).relativeM < -0.9, "downwards is negative");
});

test("the relative figure is the small error bar, the absolute one is not", async () => {
  // Both are the part's own numbers from the datasheet: +/-0.03 hPa relative,
  // which Bosch also quote as +/-25 cm, against +/-0.50 hPa absolute. The panel
  // leads with the datum reading because of this ratio, so it is worth pinning.
  const rig = chipWithBarometer();
  const { poll } = await open(rig);
  const state = await poll();

  assert.ok(Math.abs(state.relativeAccuracyM - 0.25) < 0.02, `${state.relativeAccuracyM} m`);
  assert.ok(state.absoluteAccuracyM > 4, `${state.absoluteAccuracyM} m`);
  assert.ok(
    state.absoluteAccuracyM / state.relativeAccuracyM > 15,
    "the whole reason the datum is the headline",
  );
});

test("settings are cached, not re-read on every poll", async () => {
  // The lesson from the BMI160: oversampling and the filter coefficient are
  // registers, each one a bus transaction, and none of them changes unless
  // this driver changes it.
  const rig = chipWithBarometer();
  const { call, poll } = await open(rig);
  await poll();

  let transactions = 0;
  const original = rig.sensor.read.bind(rig.sensor);
  rig.sensor.read = (length) => {
    transactions++;
    return original(length);
  };

  for (let i = 0; i < 5; i++) await poll();
  // Per reading: the status check and the six data bytes, plus a little slack
  // for the wait loop. Re-reading OSR and CONFIG would add two more each time.
  assert.ok(transactions <= 20, `${transactions} reads for five polls`);

  // But a change still takes effect.
  await call("device_command", HANDLE, "set_pressure_oversampling", [32]);
  assert.equal(rig.sensor.pressureOversampling, 32);
  assert.equal((await poll()).details.find((d) => d.label === "Resolution").value.startsWith("0.085"), true);
});

test("this driver's compensation agrees with the library's", async () => {
  // The one piece of arithmetic here copied out of a library rather than
  // called -- the wait loop it is welded to has no bound, so the measurement
  // had to move. A copy is only safe if something checks it against the
  // original, which is what this does: same part, same counts, same answer.
  const rig = chipWithBarometer({ pressureHpa: 977.31, temperatureC: 29.4 });
  const { call, poll } = await open(rig);

  const mine = await poll();
  const result = await call(
    "console_exec",
    "import json\n" +
      "from webblinka.drivers.base import _INSTANCES\n" +
      "s = _INSTANCES['bmp3xx@0x77']._sensor\n" +
      "p, t = s._read()\n" +
      "print(json.dumps([p / 100, t]))",
  );
  const [libraryPressure, libraryTemperature] = JSON.parse((result.error ? `[${result.error}]` : result.output).trim());

  assert.ok(
    Math.abs(mine.pressureHpa - libraryPressure) < 1e-6,
    `${mine.pressureHpa} vs ${libraryPressure}`,
  );
  assert.ok(
    Math.abs(mine.temperatureC - libraryTemperature) < 1e-9,
    `${mine.temperatureC} vs ${libraryTemperature}`,
  );
});

test("a part that never finishes converting fails instead of hanging", async () => {
  // The library's own wait is `while status & 0x60 != 0x60` with no retry
  // limit, and the transport's spin detector does not cover it: that fires on
  // one HID report repeating, and each turn of this loop is a whole
  // write-then-read. An earlier version of this test proved the point by
  // hanging. So the deadline lives in the driver, sized from the datasheet's
  // maximum conversion time for the oversampling in force.
  const rig = chipWithBarometer();
  const { call } = await open(rig);
  rig.sensor.stall();

  const began = Date.now();
  await assert.rejects(
    () => call("device_poll", HANDLE),
    /never finished a conversion/,
    "and it says what it was waiting for",
  );
  assert.ok(Date.now() - began < 5000, `gave up after ${Date.now() - began} ms`);
});

test("the panel states the noise for the settings actually in force", async () => {
  // The two knobs are not independent, and neither means much alone: x32 with
  // the filter off is noisier than x1 with it at x128, at fourteen times the
  // conversion time. So the panel reports the pair's real figure from the
  // datasheet rather than leaving "oversampling" as an abstraction.
  const rig = chipWithBarometer();
  const { call, poll } = await open(rig);

  const noiseOf = (state) => state.details.find((d) => d.label === "Noise").value;

  // The default: x8 with the filter at x4 is 0.6 Pa, which is about 5 cm.
  assert.match(noiseOf(await poll()), /^0\.6 Pa · 5\.0 cm$/);

  // Turning the filter off costs nearly a factor of three.
  await call("device_command", HANDLE, "set_filter", [0]);
  assert.match(noiseOf(await poll()), /^1\.6 Pa/);

  // And the cheap win: the lowest oversampling there is, heavily filtered,
  // beats the highest oversampling unfiltered.
  await call("device_command", HANDLE, "set_pressure_oversampling", [1]);
  await call("device_command", HANDLE, "set_filter", [128]);
  const cheap = parseFloat(noiseOf(await poll()));

  await call("device_command", HANDLE, "set_pressure_oversampling", [32]);
  await call("device_command", HANDLE, "set_filter", [0]);
  const expensive = parseFloat(noiseOf(await poll()));

  assert.ok(cheap < expensive, `${cheap} Pa filtered vs ${expensive} Pa oversampled`);
});

test("the sensor is found by a scan and matched to its panel", async () => {
  const rig = chipWithBarometer();
  const { call } = await bootStack({ chip: rig.chip });
  await call("connect");
  assert.deepEqual(await call("i2c_scan"), [0x77]);
});
