import type { DevicePanel, DeviceSession } from "../../devices/panel.ts";
import { el, svg } from "../dom.ts";
import { panel, statusPill } from "../panel.ts";

export interface ImuAxis {
  axis: string;
  value: number;
}

export interface ImuGroup {
  key: string;
  label: string;
  unit: string;
  range: number;
  axes: ImuAxis[];
  magnitude: number;
  magnitudeLabel: string;
  expected: number;
}

export interface ImuControl {
  kind: "select" | "button";
  command: string;
  label: string;
  title?: string;
  value?: number;
  args?: unknown[];
  options?: { value: number; label: string }[];
}

export interface ImuState {
  label: string;
  groups: ImuGroup[];
  accelMagnitudeG: number;
  gyroMagnitudeDps: number;
  biasMagnitudeDps: number;
  zeroed: boolean;
  zeroedAtC: number | null;
  still: boolean;
  tilt: { rollDeg: number; pitchDeg: number; usable: boolean; text: string };
  headingDriftDegPerMin: number | null;
  temperatureC: number | null;
  temperatureNote: string;
  controls: ImuControl[];
  details: { label: string; value: string; title?: string }[];
  zeroResult?: { ok: boolean; text: string };
}

const POLL_INTERVAL_MS = 200;
const LEVEL = 190;

/**
 * One panel for every inertial part, driven entirely by what the driver
 * declares. A group is three axes, a unit and a full scale; a part with a
 * magnetometer adds a third group and this renders it without being told.
 *
 * The layout puts the level first because it is the only thing here that is
 * legible at a glance, and the bars beside it because they are the only thing
 * that shows saturation. Both are wanted: the level says which way up the board
 * is, and goes grey the moment the accelerometer stops being a reliable witness
 * to that; the bars say how much of each range is actually in use.
 */
export class ImuPanel implements DevicePanel {
  readonly root: HTMLElement;
  readonly #session: DeviceSession;
  readonly #status = statusPill("Reading…", "busy");
  readonly #level = el("div", { class: "level" });
  readonly #bars = el("div", { class: "imu-groups" });
  readonly #note = el("p", { class: "aht-note" });
  readonly #facts = el("dl", { class: "facts" });
  readonly #controls = el("div", { class: "lux-controls" });
  #timer: number | null = null;
  #polling = false;
  #controlsBuilt = "";
  #flash = "";
  #misses = 0;

  constructor(session: DeviceSession) {
    this.#session = session;
    const p = panel("Motion");
    this.root = p.root;
    p.actions.append(this.#status.node);

    p.body.append(
      el("div", { class: "gps-columns" }, [
        el("div", {}, [this.#bars, this.#note, this.#facts]),
        el("div", {}, [
          el("p", { class: "lux-fill-label", text: "Attitude" }),
          this.#level,
          el("p", {
            class: "caption",
            text:
              "Roll and pitch from the direction of gravity. There is no yaw: " +
              "turning about the vertical leaves every accelerometer axis " +
              "unchanged, so it cannot be recovered this way at all.",
          }),
          this.#controls,
        ]),
      ]),
    );
  }

  show(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => void this.#poll(), POLL_INTERVAL_MS) as unknown as number;
    void this.#poll();
  }

  hide(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  async #run(command: string, args: unknown[]): Promise<void> {
    // Raises the poll guard but never defers to it. Zeroing takes a couple of
    // dozen readings, which on hardware is most of a second, and the poll timer
    // would otherwise queue work behind it that is stale before it runs. A
    // command must still always run: dropping one silently discards a click,
    // and the button under it looks broken.
    this.#polling = true;
    try {
      const state = await this.#session.command<ImuState>(command, ...args);
      if (state?.zeroResult) this.#flash = state.zeroResult.text;
      this.#render(state);
    } catch (err) {
      this.#status.set(err instanceof Error ? err.message : String(err), "error");
    } finally {
      this.#polling = false;
    }
  }

  async #poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      this.#render(await this.#session.poll<ImuState>());
      this.#misses = 0;
    } catch (err) {
      // A dropped frame is not a dead panel. On a bus shared with a moving
      // board an occasional transfer will fail, and blanking everything for one
      // of them loses the reading that was on screen a fifth of a second ago
      // and was fine. The last good values stay, the pill says what happened,
      // and a count that keeps climbing is the signal that this is not
      // occasional at all.
      this.#misses++;
      const text = err instanceof Error ? err.message : String(err);
      this.#status.set(
        this.#misses > 3 ? `bus failing · ${this.#misses}` : "dropped a reading",
        "error",
      );
      if (this.#misses > 3) this.#note.textContent = text;
    } finally {
      this.#polling = false;
    }
  }

  #render(state: ImuState): void {
    this.#status.set(
      state.still ? "still" : `${state.gyroMagnitudeDps.toFixed(0)} °/s`,
      state.still ? "ok" : "busy",
    );

    this.#renderGroups(state.groups);
    this.#renderLevel(state);
    this.#renderFacts(state);
    this.#buildControls(state.controls);
    this.#note.textContent = this.#verdict(state);
  }

  #verdict(state: ImuState): string {
    if (this.#flash) {
      const text = this.#flash;
      this.#flash = "";
      return text;
    }
    if (!state.tilt.usable) return state.tilt.text;
    if (!state.zeroed && state.still && state.headingDriftDegPerMin !== null) {
      // The headline fact about any gyro, and the one degrees-per-second hides:
      // a rate this small still walks the heading right round the compass.
      const minutes = state.headingDriftDegPerMin;
      return (
        `Still, but the gyroscope reads ${state.gyroMagnitudeDps.toFixed(2)} °/s — ` +
        `that offset alone would swing a dead-reckoned heading by ${minutes.toFixed(
          0,
        )}° a minute. Zero it.`
      );
    }
    return "";
  }

  #renderGroups(groups: ImuGroup[]): void {
    this.#bars.replaceChildren(
      ...groups.map((group) =>
        el("div", { class: "imu-group" }, [
          el("div", { class: "imu-group-head" }, [
            el("span", { class: "imu-group-label", text: group.label }),
            el("span", {
              class: "imu-group-range",
              text: `±${group.range} ${group.unit}`,
            }),
          ]),
          ...group.axes.map((axis) => this.#axisRow(axis, group)),
        ]),
      ),
    );
  }

  /** One signed bar, growing either side of a centre line at zero. */
  #axisRow(axis: ImuAxis, group: ImuGroup): HTMLElement {
    const fraction = Math.max(-1, Math.min(1, axis.value / group.range));
    const saturated = Math.abs(axis.value) >= group.range * 0.99;

    const fill = el("div", { class: "imu-bar-fill" });
    fill.style.width = `${(Math.abs(fraction) * 50).toFixed(2)}%`;
    if (fraction >= 0) fill.style.left = "50%";
    else fill.style.right = "50%";

    return el("div", { class: saturated ? "imu-axis saturated" : "imu-axis" }, [
      el("span", { class: "imu-axis-name", text: axis.axis }),
      el("div", { class: "imu-bar" }, [el("div", { class: "imu-bar-zero" }), fill]),
      el("span", {
        class: "imu-axis-value",
        text: formatAxis(axis.value, group.unit),
      }),
    ]);
  }

  /**
   * A bubble level: the dot is where "down" is pointing, so the board's tilt
   * moves it off centre in the direction it is leaning.
   */
  #renderLevel(state: ImuState): void {
    const centre = LEVEL / 2;
    const radius = centre - 12;
    const { rollDeg, pitchDeg, usable } = state.tilt;

    // Ninety degrees of tilt puts the bubble on the rim; past that it stays
    // there rather than wrapping back through the middle, which would read as
    // level while the board is upside down.
    const scale = radius / 90;
    const x = centre + clamp(rollDeg, -90, 90) * scale;
    const y = centre - clamp(pitchDeg, -90, 90) * scale;

    const rings = [radius, radius * 0.66, radius * 0.33].map((r) =>
      svg("circle", { cx: centre, cy: centre, r, class: "level-ring" }),
    );

    this.#level.replaceChildren(
      svg("svg", { viewBox: `0 0 ${LEVEL} ${LEVEL}`, class: usable ? "level-svg" : "level-svg unusable" }, [
        ...rings,
        svg("line", { x1: centre - radius, y1: centre, x2: centre + radius, y2: centre, class: "level-cross" }),
        svg("line", { x1: centre, y1: centre - radius, x2: centre, y2: centre + radius, class: "level-cross" }),
        svg("circle", { cx: x, cy: y, r: 7, class: "level-bubble" }),
        svg(
          "text",
          { x: centre, y: LEVEL - 2, "text-anchor": "middle", class: "dial-label" },
          [usable ? `${rollDeg.toFixed(1)}° / ${pitchDeg.toFixed(1)}°` : "accelerating"],
        ),
      ]),
    );
  }

  #renderFacts(state: ImuState): void {
    const rows: { label: string; value: string; title?: string }[] = [
      {
        label: "Magnitude",
        value: `${state.accelMagnitudeG.toFixed(3)} g`,
        title:
          "At rest this must come to 1.000 g — gravity does not switch off. " +
          "It is the continuous check that the axes were sampled together and " +
          "scaled correctly.",
      },
      {
        label: "Roll / pitch",
        value: state.tilt.usable
          ? `${state.tilt.rollDeg.toFixed(1)}° / ${state.tilt.pitchDeg.toFixed(1)}°`
          : "—",
      },
      {
        label: "Gyro offset",
        value: state.zeroed ? `${state.biasMagnitudeDps.toFixed(2)} °/s removed` : "not zeroed",
        title:
          "The zero-rate offset measured while the board was still. It is the " +
          "dominant error in any gyroscope and the reason dead reckoning walks.",
      },
    ];
    if (state.headingDriftDegPerMin !== null) {
      rows.push({
        label: "Heading drift",
        value: `${state.headingDriftDegPerMin.toFixed(1)} °/min`,
        title:
          "What is left of the offset, expressed as the heading error it would " +
          "accumulate. Only measurable while the board is still.",
      });
    }
    if (state.temperatureC !== null) {
      rows.push({
        label: "Die temperature",
        value: `${state.temperatureC.toFixed(1)} °C`,
        title: state.temperatureNote,
      });
    }
    rows.push(...state.details);

    this.#facts.replaceChildren(
      ...rows.flatMap((row) => [
        el("dt", { text: row.label, title: row.title ?? "" }),
        el("dd", { text: row.value, title: row.title ?? "" }),
      ]),
    );
  }

  /** Rebuilt only when the shape changes, so a select stays usable mid-click. */
  #buildControls(controls: ImuControl[]): void {
    const signature = controls.map((c) => `${c.kind}:${c.command}`).join("|");
    if (signature !== this.#controlsBuilt) {
      this.#controlsBuilt = signature;
      this.#controls.replaceChildren(
        ...controls.map((control) => this.#control(control)),
      );
      return;
    }
    // Same controls, new values: update the selects in place.
    const selects = [...this.#controls.querySelectorAll("select")];
    let index = 0;
    for (const control of controls) {
      if (control.kind !== "select") continue;
      const select = selects[index++];
      if (select && document.activeElement !== select) select.value = String(control.value);
    }
  }

  #control(control: ImuControl): HTMLElement {
    if (control.kind === "button") {
      const button = el("button", { text: control.label, title: control.title ?? "" });
      button.addEventListener("click", () => {
        button.disabled = true;
        void this.#run(control.command, control.args ?? []).finally(() => {
          button.disabled = false;
        });
      });
      return el("label", {}, [button]);
    }

    const select = el("select", { title: control.title ?? "" }) as HTMLSelectElement;
    for (const option of control.options ?? []) {
      select.append(el("option", { value: String(option.value), text: option.label }));
    }
    select.value = String(control.value);
    select.addEventListener("change", () => {
      void this.#run(control.command, [Number(select.value)]);
    });
    return el("label", {}, [el("span", { text: control.label }), select]);
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** Enough figures to see the noise, not so many that the column jitters. */
function formatAxis(value: number, unit: string): string {
  const digits = unit === "g" ? 3 : 2;
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}
