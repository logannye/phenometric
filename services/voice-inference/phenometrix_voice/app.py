from __future__ import annotations

import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from .adapters import VoiceProcessorAdapter, WavLMAdapter
from .config import WAVLM_LAYERS, load_settings
from .schemas import (
    LayerSummary,
    RepresentationRequest,
    RepresentationResponse,
)


def create_app(
    adapter_factory: Callable[[], VoiceProcessorAdapter] | None = None,
) -> FastAPI:
    settings = load_settings()
    factory = adapter_factory or WavLMAdapter

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        if settings.enabled or adapter_factory is not None:
            try:
                application.state.adapter = factory()
            except Exception as error:  # model/cache/runtime isolation boundary
                application.state.adapter_error = type(error).__name__
        yield
        application.state.adapter = None

    app = FastAPI(
        title="PhenoMetrix Voice Representation Service",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://127.0.0.1:4173",
            "http://localhost:4173",
        ],
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["content-type"],
    )
    app.state.adapter = None
    app.state.adapter_error = None

    @app.get("/v1/health")
    def health() -> dict[str, object]:
        adapter = app.state.adapter
        provenance = adapter.provenance if adapter else None
        return {
            "schemaVersion": "phenometric.voice-service-health.v1",
            "enabled": settings.enabled or adapter_factory is not None,
            "ready": adapter is not None,
            "processor": (
                {
                    "processorType": provenance.processor_type,
                    "processorRef": provenance.processor_ref,
                    "modelId": provenance.model_id,
                    "revision": provenance.revision,
                    "weightSha256": provenance.weight_sha256,
                    "runtime": provenance.runtime,
                    "device": provenance.device,
                    "layers": list(WAVLM_LAYERS),
                }
                if provenance
                else None
            ),
            "errorCode": app.state.adapter_error,
            "retainsAudio": False,
            "retainsEmbeddings": False,
        }

    @app.post(
        "/v1/voice/representations",
        response_model=RepresentationResponse,
    )
    async def representations(
        payload: RepresentationRequest, request: Request
    ) -> RepresentationResponse:
        adapter: VoiceProcessorAdapter | None = app.state.adapter
        if adapter is None:
            raise HTTPException(
                status_code=503,
                detail="speech-representation-processor-unavailable",
            )
        started_at = time.perf_counter()
        pcm = payload.pcm()
        encoded: dict[int, np.ndarray] = {}
        try:
            encoded = adapter.encode(
                pcm, payload.sampleRateHz, payload.requestedLayers
            )
            if await request.is_disconnected():
                raise HTTPException(
                    status_code=499, detail="client-disconnected"
                )
            summaries: list[LayerSummary] = []
            for layer in payload.requestedLayers:
                values = np.asarray(encoded[layer], dtype=np.float32)
                if values.ndim != 2 or not np.isfinite(values).all():
                    raise HTTPException(
                        status_code=500,
                        detail="encoder-returned-invalid-representation",
                    )
                summaries.append(
                    LayerSummary(
                        layer=layer,
                        dimension=values.shape[1],
                        mean=values.mean(axis=0).astype(float).tolist(),
                        standardDeviation=values.std(axis=0)
                        .astype(float)
                        .tolist(),
                    )
                )
            provenance = adapter.provenance
        finally:
            pcm.fill(0)
            for values in encoded.values():
                np.asarray(values).fill(0)
            encoded.clear()
        return RepresentationResponse(
            schemaVersion="phenometric.voice-representation-response.v1",
            requestRef=payload.requestRef,
            windowRef=payload.windowRef,
            processorType="speech-representation",
            processorRef=provenance.processor_ref,
            modelId=provenance.model_id,
            modelRevision=provenance.revision,
            weightSha256=provenance.weight_sha256,
            runtime=provenance.runtime,
            device=provenance.device,
            latencyMs=(time.perf_counter() - started_at) * 1000,
            layers=summaries,
        )

    return app


app = create_app()
