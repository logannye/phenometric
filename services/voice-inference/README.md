# Voice representation sidecar

This optional Python 3.11 service exposes transient WavLM Large layer summaries
for research adapter development. It binds to loopback, is disabled by default,
does not log request bodies, and retains neither audio nor embeddings.

The shipping ambient browser pipeline does not import, start, or call this
service. Restoring it preserves a research surface only; it is not part of the
current ObservationV3 measurement path and must not be presented as an active
browser capability.

```bash
uv sync --extra dev
uv run --extra dev pytest
```

For a manual real-model smoke, install the optional checkpoint runtime and
place the pinned `microsoft/wavlm-large` revision in the local Hugging Face
cache. Start the service in one terminal:

```bash
PHENOMETRIC_WAVLM_ENABLED=1 uv run --extra wavlm \
  uvicorn phenometrix_voice.app:app --host 127.0.0.1 --port 8765 --no-access-log
```

Then run generated-audio smoke in a second terminal:

```bash
uv run python -m phenometrix_voice.manual_smoke
```

The browser endpoint is
`http://127.0.0.1:8765/v1/voice/representations`. Do not bind the milestone
service to a non-loopback interface. The service accepts no file paths or URLs,
does not write audio, and returns only layer mean/std summaries plus processor
provenance.

The pinned model revision is
`c1423ed94bb01d80a3f5ce5bc39f6026a0f4828c`; the reviewed
`pytorch_model.bin` SHA-256 is
`fdee460e529396ddb2f8c8e8ce0ad74cfb747b726bc6f612e666c7c1e1963c9d`.
