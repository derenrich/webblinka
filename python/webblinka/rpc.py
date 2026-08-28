"""JSON-in, JSON-out dispatch for calls arriving from the page.

The worker holds a single PyProxy -- ``dispatch`` -- and invokes it with
``callPromising`` so that stack switching is enabled for the whole call. That is
what lets everything underneath (Blinka, a driver, the hid shim) block on a HID
round-trip through ``run_sync`` while staying ordinary synchronous Python.

Arguments and results cross as JSON rather than as proxies: it keeps object
lifetimes out of the picture and means a handler can only return things the UI
can actually render.
"""

from __future__ import annotations

import json
import traceback
from typing import Any, Callable

_HANDLERS: dict[str, Callable[..., Any]] = {}


def handler(fn: Callable[..., Any]) -> Callable[..., Any]:
    """Expose a function to the page under its own name."""
    _HANDLERS[fn.__name__] = fn
    return fn


def dispatch(name: str, args_json: str) -> str:
    _load_handlers()
    fn = _HANDLERS.get(name)
    if fn is None:
        raise LookupError(f"no such handler: {name!r} (have {sorted(_HANDLERS)})")
    try:
        return json.dumps(fn(*json.loads(args_json)))
    except Exception as err:
        # The bare exception text ("[Errno 5] Input/output error") is rarely
        # enough to tell a NACK from a wedged bus, so carry the traceback across
        # to the console panel.
        raise RuntimeError(
            f"{name}: {err}\n\n{''.join(traceback.format_exc())}"
        ) from err


def handler_names() -> list[str]:
    _load_handlers()
    return sorted(_HANDLERS)


def _load_handlers() -> None:
    """Import the modules that register handlers.

    Deferred to first call so that importing webblinka.rpc during boot does not
    drag in `board` -- which would open the HID device before the page has one.
    """
    if _HANDLERS:
        return
    # Imported for their @handler side effects. Every driver module has to be
    # listed here, which is also what makes it discoverable from the page.
    from . import console, mcp2221_chip, session  # noqa: F401
    from .drivers import base  # noqa: F401
    from .drivers import aht10  # noqa: F401
    from .drivers import as5600  # noqa: F401
    from .drivers import as7341  # noqa: F401
    from .drivers import bmi160  # noqa: F401
    from .drivers import eeprom  # noqa: F401
    from .drivers import gps_pa1010d  # noqa: F401
    from .drivers import hdc302x  # noqa: F401
    from .drivers import rtc  # noqa: F401
    from .drivers import sht4x  # noqa: F401
    from .drivers import tsl2591  # noqa: F401
