"""Bounded raw-byte capture while concurrently feeding a subprocess stdin."""
from __future__ import annotations

import subprocess
import threading
from typing import BinaryIO


class BoundedProcessOutput:
    CHUNK_BYTES = 64 * 1024

    def __init__(self, process: subprocess.Popen, stdin: str | None, limit: int) -> None:
        self.stdout = bytearray()
        self.stderr = bytearray()
        self.overflow = threading.Event()
        self.done = threading.Event()
        self.failed = False
        self._limit = limit
        self._bytes = 0
        self._lock = threading.Lock()
        self._remaining = 2 + (stdin is not None)
        self._threads = [
            threading.Thread(target=self._run, args=(self._read, process.stdout, self.stdout),
                             daemon=True, name="boss-cli-stdout"),
            threading.Thread(target=self._run, args=(self._read, process.stderr, self.stderr),
                             daemon=True, name="boss-cli-stderr"),
        ]
        if stdin is not None:
            self._threads.append(threading.Thread(target=self._run,
                args=(self._write, process.stdin, stdin), daemon=True, name="boss-cli-stdin"))
        self._pipes = [process.stdout, process.stderr] + ([process.stdin] if stdin is not None else [])

    def start(self) -> None:
        for thread in self._threads:
            thread.start()

    def _run(self, operation, *args) -> None:
        try:
            operation(*args)
        except Exception:
            with self._lock:
                self.failed = True
        finally:
            with self._lock:
                self._remaining -= 1
                if self._remaining == 0:
                    self.done.set()

    def _read(self, stream: BinaryIO, destination: bytearray) -> None:
        try:
            while not self.overflow.is_set():
                chunk = stream.read1(self.CHUNK_BYTES)
                if not chunk:
                    return
                with self._lock:
                    if self.overflow.is_set():
                        return
                    if self._bytes + len(chunk) > self._limit:
                        self.overflow.set()
                        return
                    self._bytes += len(chunk)
                    destination.extend(chunk)
        finally:
            stream.close()

    @staticmethod
    def _write(stream: BinaryIO, text: str) -> None:
        try:
            try:
                stream.write(text.encode("utf-8"))
                stream.flush()
            except BrokenPipeError:
                # communicate() also accepts a child closing stdin early.
                pass
        finally:
            try:
                stream.close()
            except BrokenPipeError:
                pass

    def join(self) -> None:
        for thread in self._threads:
            if thread.ident is not None:
                thread.join(timeout=1)

    def close_unstarted(self) -> None:
        for thread, stream in zip(self._threads, self._pipes):
            if thread.ident is None:
                stream.close()
