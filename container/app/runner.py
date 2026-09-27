"""Runs each job in a worker process with a hard time limit (and, on Linux, a memory cap).

One container serves the whole school. A runaway design must not keep a CPU busy after the Worker has
given up on it (30 s), so when a job runs out of time its process is killed and a fresh one takes its
place. Threads can't be killed, which is why this is processes.
"""
from __future__ import annotations

import multiprocessing as mp
import os
import queue
import threading
import time
from multiprocessing.connection import Connection
from typing import Any, Callable

from .models import ProcessResponse

TIME_LIMIT_S = 25.0  # under the Worker's 30 s, so the student reads our message instead of a timeout
WORKERS = 2  # a runaway job holds one; the other keeps serving the class
MEMORY_LIMIT_BYTES = 512 * 1024 * 1024  # per worker; the basic instance has 1 GiB
START_LIMIT_S = 60.0  # a fresh worker imports shapely, ezdxf, ...: slow on a quarter of a CPU

TOO_SLOW = "This design took too long to get ready. Simplify it and try again."
TOO_BIG = "This design is too big to get ready. Simplify it and try again."
BUSY = "The laser processor is busy right now. Wait a few seconds and try again."


def _serve(conn: Connection, target: Callable[[Any], Any], memory_limit: int) -> None:
    if memory_limit:
        try:
            import resource  # Linux only; tests on Windows run without the cap
            resource.setrlimit(resource.RLIMIT_AS, (memory_limit, memory_limit))
        except (ImportError, ValueError, OSError):
            pass
    # Import the heavy libraries before saying ready, so the first job doesn't pay for them.
    from .geometry import dxf_import, hatch, svg_import, text_import  # noqa: F401
    conn.send("ready")
    while True:
        try:
            job = conn.recv()
        except (EOFError, OSError):
            return
        try:
            conn.send(("ok", target(job)))
        except MemoryError:
            conn.send(("memory", None))
            return  # the heap may be in a bad way: let the parent start a fresh worker
        except Exception as e:  # noqa: BLE001
            conn.send(("error", repr(e)))


class _Worker:
    def __init__(self, ctx: Any, target: Callable[[Any], Any], memory_limit: int) -> None:
        self.conn, child = ctx.Pipe()
        self.proc = ctx.Process(target=_serve, args=(child, target, memory_limit), daemon=True)
        self.proc.start()
        child.close()
        self.ready = False

    def wait_ready(self, timeout: float) -> bool:
        if not self.ready and self.conn.poll(max(0.0, timeout)):
            self.ready = self.conn.recv() == "ready"
        return self.ready

    def kill(self) -> None:
        self.proc.kill()
        self.proc.join(5)
        self.conn.close()


class Runner:
    def __init__(self, target: Callable[[Any], Any], workers: int = WORKERS, time_limit: float = TIME_LIMIT_S,
                 memory_limit: int = MEMORY_LIMIT_BYTES) -> None:
        # numpy's OpenBLAS reserves ~40 MB of address space per CPU it sees, which the memory cap counts.
        # Workers inherit this environment. The geometry never needs threaded BLAS.
        os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
        self._ctx = mp.get_context("spawn")  # no fork: the server has threads
        self._target, self._memory_limit, self.time_limit = target, memory_limit, time_limit
        self._idle: queue.Queue[_Worker] = queue.Queue()
        for _ in range(workers):
            self._idle.put(self._new())

    def _new(self) -> _Worker:
        return _Worker(self._ctx, self._target, self._memory_limit)

    def warm(self, timeout: float = START_LIMIT_S) -> None:
        """Wait until every idle worker has finished importing. For startup and tests."""
        held = []
        while True:
            try:
                held.append(self._idle.get_nowait())
            except queue.Empty:
                break
        for w in held:
            w.wait_ready(timeout)
            self._idle.put(w)

    def run(self, job: Any) -> Any:
        deadline = time.monotonic() + self.time_limit
        try:
            w = self._idle.get(timeout=self.time_limit)
        except queue.Empty:
            return ProcessResponse(errors=[BUSY])
        try:
            if not w.wait_ready(deadline - time.monotonic()):
                return ProcessResponse(errors=[BUSY])  # still starting up; it stays in the pool
            w.conn.send(job)
            if not w.conn.poll(max(0.0, deadline - time.monotonic())):
                w = self._restart(w)
                return ProcessResponse(errors=[TOO_SLOW])
            status, value = w.conn.recv()
            if status == "memory":
                w = self._restart(w)
                return ProcessResponse(errors=[TOO_BIG])
        except (EOFError, OSError):  # the worker died, most likely killed for using too much memory
            w = self._restart(w)
            return ProcessResponse(errors=[TOO_BIG])
        finally:
            self._idle.put(w)
        if status == "error":
            raise RuntimeError(value)
        return value

    def _restart(self, w: _Worker) -> _Worker:
        w.kill()
        return self._new()

    def close(self) -> None:
        while True:
            try:
                self._idle.get_nowait().kill()
            except queue.Empty:
                return


_runner: Runner | None = None
_lock = threading.Lock()


def get_runner() -> Runner:
    global _runner
    with _lock:
        if _runner is None:
            from .pipeline import process
            _runner = Runner(process, workers=int(os.environ.get("UML_WORKERS", WORKERS)))
        return _runner
