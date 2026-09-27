"""Container HTTP service. Only the Worker talks to this. It is never exposed directly."""
from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .models import ContainerJob, ProcessResponse
from .runner import get_runner


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    get_runner()  # start the worker processes now; they finish importing while the first request travels
    yield


app = FastAPI(title="uploadmylaser processor", docs_url=None, redoc_url=None, lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/process", response_model=ProcessResponse, response_model_by_alias=True)
def process_route(job: ContainerJob) -> ProcessResponse:
    # sync def → FastAPI runs it in a threadpool while a worker process does the geometry (app/runner.py)
    return get_runner().run(job)
