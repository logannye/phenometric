from __future__ import annotations

import base64
import math
import os
import struct
import urllib.request


def main() -> None:
    sample_rate = 16000
    samples = [
        0.1 * math.sin(2 * math.pi * 220 * index / sample_rate)
        for index in range(sample_rate * 2)
    ]
    payload = (
        b'{"schemaVersion":"phenometric.voice-representation-request.v1",'
        b'"requestRef":"manual-generated-smoke","captureEpoch":1,'
        b'"windowRef":"generated-vowel","taskContext":"sustained-vowel-1",'
        b'"sampleRateHz":16000,"channelCount":1,"durationSamples":'
        + str(len(samples)).encode()
        + b',"requestedLayers":[6,12,18,24],"pcmFloat32Base64":"'
        + base64.b64encode(
            b"".join(struct.pack("<f", value) for value in samples)
        )
        + b'"}'
    )
    endpoint = os.getenv(
        "PHENOMETRIC_WAVLM_ENDPOINT",
        "http://127.0.0.1:8765/v1/voice/representations",
    )
    request = urllib.request.Request(
        endpoint,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        print(response.read().decode())


if __name__ == "__main__":
    main()
