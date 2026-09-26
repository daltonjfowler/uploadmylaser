"""Container HTTP service. Only the Worker talks to this. It is never exposed directly."""
from __future__ import annotations

from fastapi import FastAPI

from .models import ContainerJob, ProcessResponse
from .pipeline import process

app = FastAPI(title="uploadmylaser processor", docs_url=None, redoc_url=None)


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/process", response_model=ProcessResponse, response_model_by_alias=True)
def process_route(job: ContainerJob) -> ProcessResponse:
    # sync def → FastAPI runs it in a threadpool, so heavy geometry doesn't block /health
    return process(job)
