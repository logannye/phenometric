from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Literal

import numpy as np

from .config import (
    WAVLM_MODEL_ID,
    WAVLM_REVISION,
    WAVLM_WEIGHT_SHA256,
)

ProcessorType = Literal[
    "speech-representation",
    "health-acoustic",
    "asr",
    "diarization",
]


@dataclass(frozen=True)
class ProcessorProvenance:
    processor_type: ProcessorType
    processor_ref: str
    model_id: str
    revision: str
    weight_sha256: str
    runtime: str
    device: str


class VoiceProcessorAdapter(ABC):
    @property
    @abstractmethod
    def provenance(self) -> ProcessorProvenance:
        raise NotImplementedError

    @abstractmethod
    def encode(
        self, pcm: np.ndarray, sample_rate: int, layers: list[int]
    ) -> dict[int, np.ndarray]:
        raise NotImplementedError


class DeterministicFakeWavLMAdapter(VoiceProcessorAdapter):
    """Small deterministic encoder used by required CI without model weights."""

    @property
    def provenance(self) -> ProcessorProvenance:
        return ProcessorProvenance(
            processor_type="speech-representation",
            processor_ref=f"{WAVLM_MODEL_ID}@{WAVLM_REVISION}:fake-ci",
            model_id=WAVLM_MODEL_ID,
            revision=WAVLM_REVISION,
            weight_sha256=WAVLM_WEIGHT_SHA256,
            runtime="numpy-fake",
            device="cpu",
        )

    def encode(
        self, pcm: np.ndarray, sample_rate: int, layers: list[int]
    ) -> dict[int, np.ndarray]:
        del sample_rate
        frame_count = max(2, min(24, pcm.size // 1600))
        chunks = np.array_split(pcm, frame_count)
        base = np.asarray(
            [
                [
                    float(np.mean(chunk)),
                    float(np.std(chunk)),
                    float(np.sqrt(np.mean(chunk * chunk))),
                    float(np.max(np.abs(chunk))),
                ]
                for chunk in chunks
            ],
            dtype=np.float32,
        )
        return {
            layer: np.concatenate(
                [base * (1 + layer / 24), base[:, :2]], axis=1
            )
            for layer in layers
        }


class WavLMAdapter(VoiceProcessorAdapter):
    def __init__(self) -> None:
        import torch
        from huggingface_hub import snapshot_download
        from transformers import AutoModel

        snapshot = Path(
            snapshot_download(
                repo_id=WAVLM_MODEL_ID,
                revision=WAVLM_REVISION,
                local_files_only=True,
            )
        )
        weight_path = snapshot / "pytorch_model.bin"
        if not weight_path.is_file():
            raise RuntimeError("Pinned WavLM weight file is absent from cache")
        digest = sha256()
        with weight_path.open("rb") as weights:
            for chunk in iter(lambda: weights.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != WAVLM_WEIGHT_SHA256:
            raise RuntimeError("Pinned WavLM weight digest does not match")

        self._torch = torch
        self._device = (
            "mps"
            if torch.backends.mps.is_available()
            else "cuda"
            if torch.cuda.is_available()
            else "cpu"
        )
        self._model = AutoModel.from_pretrained(
            snapshot,
            local_files_only=True,
        ).to(self._device)
        self._model.eval()

    @property
    def provenance(self) -> ProcessorProvenance:
        return ProcessorProvenance(
            processor_type="speech-representation",
            processor_ref=f"{WAVLM_MODEL_ID}@{WAVLM_REVISION}",
            model_id=WAVLM_MODEL_ID,
            revision=WAVLM_REVISION,
            weight_sha256=WAVLM_WEIGHT_SHA256,
            runtime=f"torch-{self._torch.__version__}",
            device=self._device,
        )

    def encode(
        self, pcm: np.ndarray, sample_rate: int, layers: list[int]
    ) -> dict[int, np.ndarray]:
        if sample_rate != 16000:
            raise ValueError("WavLM requires 16 kHz PCM")
        tensor = self._torch.from_numpy(pcm).unsqueeze(0).to(self._device)
        with self._torch.inference_mode():
            result = self._model(
                tensor, output_hidden_states=True, return_dict=True
            )
        hidden_states = result.hidden_states
        return {
            layer: hidden_states[layer][0].detach().float().cpu().numpy()
            for layer in layers
        }
