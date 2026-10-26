"""Idempotent cleanup for host-owned tool bridges."""
from __future__ import annotations

import logging
import threading
import weakref
from typing import Any


_LOG = logging.getLogger(__name__)


class BridgeLifecycle:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._closed: list[weakref.ReferenceType] = []

    def close(self, bridge: Any) -> None:
        if bridge is None:
            return
        with self._lock:
            retained = []
            already_closed = False
            for reference in self._closed:
                current = reference()
                if current is None:
                    continue
                retained.append(reference)
                already_closed = already_closed or current is bridge
            self._closed = retained
            if already_closed:
                return
            try:
                reference = weakref.ref(bridge)
            except TypeError:
                reference = None
            if reference is not None:
                self._closed.append(reference)

        try:
            closer = getattr(bridge, "close", None)
            if not callable(closer):
                closer = getattr(bridge, "dispose", None)
            if callable(closer):
                closer()
        except Exception as exc:
            _LOG.warning("tool bridge cleanup failed (%s)", type(exc).__name__)
