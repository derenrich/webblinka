import type { DevicePanel, DeviceSession } from "../../devices/panel.ts";
import { el } from "../dom.ts";
import { panel, statusPill } from "../panel.ts";

export interface DisplayControl {
  kind: "select" | "range" | "toggle";
  command: string;
  label: string;
  title?: string;
  value: string | number | boolean;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
}

export interface DisplayState {
  label: string;
  width: number;
  height: number;
  /** Base64 of the framebuffer, in the panel's own page-major layout. */
  frame: string;
  pattern: string;
  patterns: { key: string; label: string; title: string }[];
  lastShowMs: number;
  bytesSent: number;
  controls: DisplayControl[];
  details: { label: string; value: string; title?: string }[];
  previewIsSent: boolean;
}

/** Pixels per display pixel in the preview. */
const ZOOM = 3;

/**
 * One panel for every small framebuffer display.
 *
 * There is no polling here, and that is not an oversight. These parts are
 * write-only and hold no state worth reading back, so a timer would spend the
 * bus on nothing -- a full 128x64 frame is over a kilobyte and eighteen chunks.
 * The panel draws when asked and otherwise leaves the bus alone.
 *
 * The preview is labelled as what was *sent* rather than what is shown, every
 * time, because that distinction is the whole difficulty of working with these
 * modules: a dark screen beside a perfect preview is the normal failure, and a
 * picture on a page is a very easy thing to mistake for a screenshot.
 */
export class DisplayPanel implements DevicePanel {
  readonly root: HTMLElement;
  readonly #session: DeviceSession;
  readonly #status = statusPill("Ready", "ok");
  readonly #canvas = el("canvas", { class: "screen" }) as HTMLCanvasElement;
  readonly #patterns = el("div", { class: "screen-patterns" });
  readonly #controls = el("div", { class: "lux-controls" });
  readonly #facts = el("dl", { class: "facts" });
  #built = false;

  constructor(session: DeviceSession) {
    this.#session = session;
    const p = panel("Screen");
    this.root = p.root;
    p.actions.append(this.#status.node);

    p.body.append(
      el("div", { class: "screen-columns" }, [
        el("div", { class: "screen-side" }, [
          el("p", { class: "lux-fill-label", text: "Sent to the panel" }),
          el("div", { class: "screen-frame" }, [this.#canvas]),
          el("p", {
            class: "caption",
            text:
              "This is the host's copy of what was sent, not a picture of the " +
              "screen. The interface is write-only — nothing can be read back — " +
              "so a dark panel beside a correct preview here is the normal way " +
              "these modules fail, and usually means the charge pump.",
          }),
        ]),
        el("div", {}, [
          el("p", { class: "lux-fill-label", text: "Test patterns" }),
          this.#patterns,
          this.#controls,
          this.#facts,
        ]),
      ]),
    );
  }

  show(): void {
    void this.#refresh();
  }

  hide(): void {}

  async #refresh(): Promise<void> {
    try {
      this.#render(await this.#session.poll<DisplayState>());
    } catch (err) {
      this.#status.set(err instanceof Error ? err.message : String(err), "error");
    }
  }

  async #run(command: string, args: unknown[], busy: string): Promise<void> {
    this.#status.set(busy, "busy");
    try {
      this.#render(await this.#session.command<DisplayState>(command, ...args));
    } catch (err) {
      this.#status.set(err instanceof Error ? err.message : String(err), "error");
    }
  }

  #render(state: DisplayState): void {
    this.#build(state);
    this.#status.set(
      state.lastShowMs
        ? `${state.bytesSent} B in ${state.lastShowMs.toFixed(0)} ms`
        : "ready",
      "ok",
    );
    this.#paint(state);

    const rows = [
      {
        label: "Panel",
        value: `${state.width} × ${state.height}`,
      },
      {
        label: "Last transfer",
        value: state.lastShowMs
          ? `${state.bytesSent} bytes · ${state.lastShowMs.toFixed(0)} ms`
          : "—",
        title:
          "A whole frame every time. These controllers take no partial update " +
          "over I²C without setting a narrower window first, so a redraw is " +
          "the full buffer plus the commands that address it.",
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

  /**
   * Decode the framebuffer and draw it. The layout is the panel's own: one
   * byte is eight *vertical* pixels, so the bit index is the row within a page.
   */
  #paint(state: DisplayState): void {
    const bytes = Uint8Array.from(atob(state.frame), (c) => c.charCodeAt(0));
    this.#canvas.width = state.width * ZOOM;
    this.#canvas.height = state.height * ZOOM;

    const context = this.#canvas.getContext("2d");
    if (!context) return;
    const style = getComputedStyle(this.root);
    context.fillStyle = style.getPropertyValue("--screen-off") || "#101314";
    context.fillRect(0, 0, this.#canvas.width, this.#canvas.height);
    context.fillStyle = style.getPropertyValue("--screen-on") || "#8fd3e8";

    for (let page = 0; page < state.height / 8; page++) {
      for (let x = 0; x < state.width; x++) {
        const byte = bytes[page * state.width + x] ?? 0;
        for (let bit = 0; bit < 8; bit++) {
          if ((byte >> bit) & 1) {
            context.fillRect(x * ZOOM, (page * 8 + bit) * ZOOM, ZOOM - 1, ZOOM - 1);
          }
        }
      }
    }
  }

  #build(state: DisplayState): void {
    if (this.#built) {
      this.#syncControls(state);
      return;
    }
    this.#built = true;

    this.#patterns.replaceChildren(
      ...state.patterns.map((pattern) => {
        const button = el("button", { text: pattern.label, title: pattern.title });
        button.addEventListener("click", () => {
          button.disabled = true;
          void this.#run("pattern", [pattern.key], `drawing ${pattern.label}…`).finally(
            () => {
              button.disabled = false;
            },
          );
        });
        return button;
      }),
    );

    this.#controls.replaceChildren(...state.controls.map((c) => this.#control(c)));
  }

  #control(control: DisplayControl): HTMLElement {
    if (control.kind === "toggle") {
      const input = el("input", { type: "checkbox" }) as HTMLInputElement;
      input.checked = Boolean(control.value);
      input.dataset.command = control.command;
      input.addEventListener("change", () => {
        void this.#run(control.command, [input.checked], "…");
      });
      return el("label", { title: control.title ?? "" }, [
        input,
        el("span", { text: control.label }),
      ]);
    }

    if (control.kind === "range") {
      const input = el("input", {
        type: "range",
        min: String(control.min ?? 0),
        max: String(control.max ?? 255),
      }) as HTMLInputElement;
      input.value = String(control.value);
      input.dataset.command = control.command;
      // On change, not input: each move is an I²C write, and a slider dragged
      // across its range would otherwise queue a hundred of them.
      input.addEventListener("change", () => {
        void this.#run(control.command, [Number(input.value)], "…");
      });
      return el("label", { title: control.title ?? "" }, [
        el("span", { text: control.label }),
        input,
      ]);
    }

    const select = el("select", { title: control.title ?? "" }) as HTMLSelectElement;
    for (const option of control.options ?? []) {
      select.append(el("option", { value: option.value, text: option.label }));
    }
    select.value = String(control.value);
    select.dataset.command = control.command;
    select.addEventListener("change", () => {
      void this.#run(control.command, [select.value], "reconfiguring…");
    });
    return el("label", { title: control.title ?? "" }, [
      el("span", { text: control.label }),
      select,
    ]);
  }

  #syncControls(state: DisplayState): void {
    for (const control of state.controls) {
      const node = this.#controls.querySelector<HTMLInputElement | HTMLSelectElement>(
        `[data-command="${control.command}"]`,
      );
      if (!node || document.activeElement === node) continue;
      if (node instanceof HTMLInputElement && node.type === "checkbox") {
        node.checked = Boolean(control.value);
      } else {
        node.value = String(control.value);
      }
    }
  }
}
