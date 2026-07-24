import base64

import numpy as np
from fastapi.testclient import TestClient

from phenometrix_voice.adapters import DeterministicFakeWavLMAdapter
from phenometrix_voice.app import create_app
from phenometrix_voice.config import (
    WAVLM_REVISION,
    WAVLM_WEIGHT_SHA256,
)


def payload(samples: np.ndarray) -> dict[str, object]:
    return {
        "schemaVersion": "phenometric.voice-representation-request.v1",
        "requestRef": "request-1",
        "captureEpoch": 2,
        "windowRef": "voice-window-1",
        "taskContext": "sustained-vowel-1",
        "sampleRateHz": 16000,
        "channelCount": 1,
        "durationSamples": int(samples.size),
        "requestedLayers": [6, 12, 18, 24],
        "pcmFloat32Base64": base64.b64encode(
            samples.astype("<f4").tobytes()
        ).decode(),
    }


def client() -> TestClient:
    return TestClient(
        create_app(adapter_factory=DeterministicFakeWavLMAdapter)
    )


def test_health_exposes_pinned_provenance_without_retention() -> None:
    with client() as active:
        response = active.get("/v1/health")
        assert response.status_code == 200
        body = response.json()
        assert body["ready"] is True
        assert body["processor"]["revision"] == WAVLM_REVISION
        assert body["processor"]["weightSha256"] == WAVLM_WEIGHT_SHA256
        assert body["retainsAudio"] is False
        assert body["retainsEmbeddings"] is False


def test_cors_is_limited_to_the_local_browser_origin() -> None:
    with client() as active:
        allowed = active.options(
            "/v1/voice/representations",
            headers={
                "Origin": "http://127.0.0.1:4173",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        assert allowed.status_code == 200
        assert (
            allowed.headers["access-control-allow-origin"]
            == "http://127.0.0.1:4173"
        )
        denied = active.options(
            "/v1/voice/representations",
            headers={
                "Origin": "https://example.invalid",
                "Access-Control-Request-Method": "POST",
            },
        )
        assert "access-control-allow-origin" not in denied.headers


def test_fake_encoder_returns_finite_layer_summaries() -> None:
    time = np.arange(32000, dtype=np.float32) / 16000
    samples = 0.1 * np.sin(2 * np.pi * 220 * time)
    with client() as active:
        response = active.post(
            "/v1/voice/representations", json=payload(samples)
        )
        assert response.status_code == 200
        body = response.json()
        assert [item["layer"] for item in body["layers"]] == [6, 12, 18, 24]
        assert all(item["dimension"] == 6 for item in body["layers"])
        assert "pcmFloat32Base64" not in response.text


def test_rejects_nonfinite_wrong_shape_and_path_inputs() -> None:
    samples = np.zeros(24000, dtype=np.float32)
    bad = payload(samples)
    bad["sampleRateHz"] = 48000
    with client() as active:
        assert active.post(
            "/v1/voice/representations", json=bad
        ).status_code == 422
        with_path = payload(samples)
        with_path["path"] = "/tmp/audio.wav"
        assert active.post(
            "/v1/voice/representations", json=with_path
        ).status_code == 422
        with_url = payload(samples)
        with_url["url"] = "https://example.invalid/audio.wav"
        assert active.post(
            "/v1/voice/representations", json=with_url
        ).status_code == 422
        stereo = payload(samples)
        stereo["channelCount"] = 2
        assert active.post(
            "/v1/voice/representations", json=stereo
        ).status_code == 422
        wrong_layers = payload(samples)
        wrong_layers["requestedLayers"] = [24]
        assert active.post(
            "/v1/voice/representations", json=wrong_layers
        ).status_code == 422
        nonfinite = samples.copy()
        nonfinite[0] = np.nan
        assert active.post(
            "/v1/voice/representations", json=payload(nonfinite)
        ).status_code == 422
        short = payload(np.zeros(100, dtype=np.float32))
        assert active.post(
            "/v1/voice/representations", json=short
        ).status_code == 422
        long = payload(np.zeros(480001, dtype=np.float32))
        assert active.post(
            "/v1/voice/representations", json=long
        ).status_code == 422
        mismatched = payload(samples)
        mismatched["durationSamples"] = 24001
        assert active.post(
            "/v1/voice/representations", json=mismatched
        ).status_code == 422
        invalid_base64 = payload(samples)
        invalid_base64["pcmFloat32Base64"] = "not-base64"
        assert active.post(
            "/v1/voice/representations", json=invalid_base64
        ).status_code == 422
        out_of_range = samples.copy()
        out_of_range[0] = 2
        assert active.post(
            "/v1/voice/representations", json=payload(out_of_range)
        ).status_code == 422
