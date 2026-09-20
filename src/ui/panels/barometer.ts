import type { DevicePanel, DeviceSession } from "../../devices/panel.ts";
import { el, svg } from "../dom.ts";
import { panel, statusPill } from "../panel.ts";

export interface BarometerControl {
  kind: "select" | "button";
  command: string;
  label: string;
  title?: string;
  value?: number;
  args?: unknown[];
  options?: { value: number; label: string }[];
}

export interface BarometerState {
  label: string;
  pressureHpa: number;
  temperatureC: number;
  temperatureF: number;
  seaLevelHpa: number;
  altitudeM: number;
  datumHpa: number | null;
  datumAgeS: number | null;
  relativeM: number | null;
  relativeAccuracyM: number;
  absoluteAccuracyM: number;
  trend: { age: number; pressureHpa: number }[];
  controls: BarometerControl[];
  details: { label: string; value: string; title?: string }[];
}

const POLL_INTERVAL_MS = 500;
const TREND_W = 260;
const TREND_H = 90;

/**
 * One panel for every barometric part.
 *
 * It leads with height above a datum rather than with altitude, because that
 * is the measurement this hardware can actually make. The offset that makes an
 * absolute reading uncertain by metres is shared between two readings taken
 * minutes apart, so it cancels out of their difference and what is left is the
 * part's relative accuracy — a quarter of a metre on a BMP390. Absolute
 * altitude is shown underneath with the reference it depends on exposed as a
 * control, because without a current sea-level pressure it is not a
 * measurement so much as an assumption.
 */
export class BarometerPanel implements DevicePanel {
  readonly root: HTMLElement;
  readonly #session: DeviceSession;
  readonly #status = statusPill("Reading…", "busy");
  readonly #headline = el("p", { class: "lux-reading" });
  readonly #headlineLabel = el("p", { class: "baro-headline-label" });
  readonly #note = el("p", { class: "aht-note" });
  readonly #trend = el("div", { class: "baro-trend" });
  readonly #facts = el("dl", { class: "facts" });
  readonly #controls = el("div", { class: "lux-controls" });
  #timer: number | null = null;
  #polling = false;
  #built = "";

  constructor(session: DeviceSession) {
    this.#session = session;
    const p = panel("Pressure");
    this.root = p.root;
    p.actions.append(this.#status.node);

    p.body.append(
      el("div", { class: "gps-columns" }, [
        el("div", {}, [this.#headline, this.#headlineLabel, this.#note, this.#facts]),
        el("div", {}, [
          el("p", { class: "lux-fill-label", text: "Recent pressure" }),
          this.#trend,
          el("p", {
            class: "caption",
            text:
              "Pressure moves slowly with weather, so almost anything visible " +
              "here is the sensor changing height — a lift, a stairwell, or " +
              "being picked up off the desk."
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
    this.#polling = true;
    try {
      this.#render(await this.#session.command<BarometerState>(command, ...args));
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
      this.#render(await this.#session.poll<BarometerState>());
    } catch (err) {
      this.#status.set(err instanceof Error ? err.message : String(err), "error");
    } finally {
      this.#polling = false;
    }
  }

  #render(state: BarometerState): void {
    this.#build(state);
    this.#status.set(`${state.pressureHpa.toFixed(2)} hPa`, "ok");

    if (state.relativeM === null) {
      this.#headline.textContent = `${state.pressureHpa.toFixed(2)} hPa`;
      this.#headlineLabel.textContent = "Set a datum to measure height changes.";
    } else {
      this.#headline.textContent = formatHeight(state.relativeM);
      const age = state.datumAgeS ?? 0;
      this.#headlineLabel.textContent =
        `above the datum set ${formatAge(age)} ago · ` +
        `±${(state.relativeAccuracyM * 100).toFixed(0)} cm`;
    }

    this.#note.textContent =
      state.relativeM === null
        ? ""
        : "This is the number the part is good at. The absolute altitude below " +
          "shares an offset with it that cancels here.";

    this.#renderFacts(state);
    this.#renderTrend(state);
  }

  #renderFacts(state: BarometerState): void {
    const rows = [
      { label: "Pressure", value: `${state.pressureHpa.toFixed(2)} hPa` },
      {
        label: "Temperature",
        value: `${state.temperatureC.toFixed(2)} °C · ${state.temperatureF.toFixed(1)} °F`,
        title:
          "Measured alongside the pressure and in the same conversion — the " +
          "compensation needs it. It is a die temperature, so it reads above " +
          "the room.",
      },
      {
        label: "Altitude",
        value: `${state.altitudeM.toFixed(1)} m`,
        title:
          `Inferred from pressure against a sea-level reference of ` +
          `${state.seaLevelHpa.toFixed(2)} hPa. Wrong reference, wrong ` +
          `altitude: the reference moves by tens of hectopascals with the ` +
          `weather, which is hundreds of metres.`,
      },
      {
        label: "Sea-level ref",
        value: `${state.seaLevelHpa.toFixed(2)} hPa`,
        title:
          "The QNH where you are, from any aviation or weather site. 1013.25 " +
          "is the standard atmosphere, not today's.",
      },
      ...state.details,
    ];
    this.#facts.replaceChildren(
      ...rows.flatMap((row) => [
        el("dt", { text: row.label, title: row.title ?? "" }),
        el("dd", { text: row.value, title: row.title ?? "" }),
      ]),
    );
  }

  /** Pressure against time, autoscaled, with the span written on it. */
  #renderTrend(state: BarometerState): void {
    const points = state.trend;
    if (points.length < 2) {
      this.#trend.replaceChildren(el("p", { class: "caption", text: "Collecting…" }));
      return;
    }

    const values = points.map((p) => p.pressureHpa);
    const low = Math.min(...values);
    const high = Math.max(...values);
    // A floor on the span, or a flat trace on a still day becomes a wild
    // scribble of pure quantisation filling the whole box.
    const span = Math.max(high - low, 0.05);
    const mid = (high + low) / 2;
    const top = mid + span / 2;
    const oldest = Math.max(...points.map((p) => p.age), 1);

    const path = points
      .map((point, index) => {
        const x = TREND_W * (1 - point.age / oldest);
        const y = TREND_H * ((top - point.pressureHpa) / span);
        return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

    this.#trend.replaceChildren(
      svg("svg", { viewBox: `0 0 ${TREND_W} ${TREND_H}`, class: "baro-trend-svg" }, [
        svg("path", { d: path, class: "baro-trend-line" }),
      ]),
      el("p", {
        class: "baro-trend-scale",
        text: `${span.toFixed(2)} hPa across · ${formatAge(oldest)}`,
      }),
    );
  }

  #build(state: BarometerState): void {
    const signature = state.controls.map((c) => `${c.kind}:${c.command}`).join("|");
    if (signature !== this.#built) {
      this.#built = signature;
      this.#controls.replaceChildren(...state.controls.map((c) => this.#control(c)));
      return;
    }
    for (const control of state.controls) {
      if (control.kind !== "select") continue;
      const node = this.#controls.querySelector<HTMLSelectElement>(
        `select[data-command="${control.command}"]`,
      );
      if (node && document.activeElement !== node) node.value = String(control.value);
    }
  }

  #control(control: BarometerControl): HTMLElement {
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
    select.dataset.command = control.command;
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

/** Centimetres while it is worth them, metres once it is not. */
function formatHeight(metres: number): string {
  const sign = metres >= 0 ? "+" : "−";
  const size = Math.abs(metres);
  if (size < 10) return `${sign}${(size * 100).toFixed(0)} cm`;
  return `${sign}${size.toFixed(1)} m`;
}

function formatAge(seconds: number): string {
  if (seconds < 90) return `${seconds.toFixed(0)} s`;
  return `${(seconds / 60).toFixed(0)} min`;
}
