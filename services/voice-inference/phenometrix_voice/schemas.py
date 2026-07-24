from __future__ import annotations

import base64
import binascii
import math
from typing import Literal

import numpy as np
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from .config import WAVLM_LAYERS


class RepresentationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal["phenometric.voice-representation-request.v1"]
    requestRef: str = Field(min_length=1, max_length=120)
    captureEpoch: int = Field(ge=0)
    windowRef: str = Field(min_length=1, max_length=120)
    taskContext: Literal[
        "sustained-vowel-1",
        "sustained-vowel-2",
        "standardized-reading",
        "rapid-syllables",
        "spontaneous-response",
    ]
    sampleRateHz: Literal[16000]
    channelCount: Literal[1]
    durationSamples: int = Field(ge=24000, le=480000)
    requestedLayers: list[int]
    pcmFloat32Base64: str = Field(min_length=1, max_length=2_560_000)

    @field_validator("requestedLayers")
    @classmethod
    def validate_layers(cls, value: list[int]) -> list[int]:
        if value != list(WAVLM_LAYERS):
            raise ValueError(f"requestedLayers must be {list(WAVLM_LAYERS)}")
        return value

    @model_validator(mode="after")
    def validate_pcm(self) -> "RepresentationRequest":
        try:
            payload = base64.b64decode(
                self.pcmFloat32Base64, validate=True
            )
        except (binascii.Error, ValueError) as error:
            raise ValueError("pcmFloat32Base64 is invalid") from error
        if len(payload) != self.durationSamples * 4:
            raise ValueError("PCM byte length does not match durationSamples")
        samples = np.frombuffer(payload, dtype="<f4")
        if not np.isfinite(samples).all():
            raise ValueError("PCM contains nonfinite samples")
        if any(math.fabs(float(sample)) > 1.5 for sample in samples):
            raise ValueError("PCM samples exceed the accepted normalized range")
        return self

    def pcm(self) -> np.ndarray:
        return np.frombuffer(
            base64.b64decode(self.pcmFloat32Base64, validate=True),
            dtype="<f4",
        ).copy()


class LayerSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    layer: int
    dimension: int = Field(gt=0)
    mean: list[float]
    standardDeviation: list[float]

    @model_validator(mode="after")
    def validate_shape(self) -> "LayerSummary":
        if (
            len(self.mean) != self.dimension
            or len(self.standardDeviation) != self.dimension
        ):
            raise ValueError("Pooled vectors must match dimension")
        if not all(
            math.isfinite(value)
            for value in self.mean + self.standardDeviation
        ):
            raise ValueError("Pooled vectors must be finite")
        return self


class RepresentationResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal["phenometric.voice-representation-response.v1"]
    requestRef: str
    windowRef: str
    processorType: Literal["speech-representation"]
    processorRef: str
    modelId: str
    modelRevision: str
    weightSha256: str
    runtime: str
    device: str
    latencyMs: float = Field(ge=0)
    layers: list[LayerSummary]
