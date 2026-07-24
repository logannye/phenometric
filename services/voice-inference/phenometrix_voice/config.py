from dataclasses import dataclass
import os

WAVLM_MODEL_ID = "microsoft/wavlm-large"
WAVLM_REVISION = "c1423ed94bb01d80a3f5ce5bc39f6026a0f4828c"
WAVLM_WEIGHT_SHA256 = (
    "fdee460e529396ddb2f8c8e8ce0ad74cfb747b726bc6f612e666c7c1e1963c9d"
)
WAVLM_LAYERS = (6, 12, 18, 24)


@dataclass(frozen=True)
class Settings:
    enabled: bool
    host: str = "127.0.0.1"
    port: int = 8765


def load_settings() -> Settings:
    return Settings(
        enabled=os.getenv("PHENOMETRIC_WAVLM_ENABLED", "0") == "1",
        host="127.0.0.1",
        port=int(os.getenv("PHENOMETRIC_WAVLM_PORT", "8765")),
    )
