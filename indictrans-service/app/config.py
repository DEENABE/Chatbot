"""
Env-driven settings, read once at import time — mirrors the Node backend's
config.js convention (a single object built from process.env with sane
defaults, no scattered os.environ reads elsewhere in the codebase).
"""

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


def _bool(value: str | None, default: bool) -> bool:
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


class Settings:
    # Loopback-only, matching the rest of this app's "no remote AI
    # endpoints" posture (see backend/src/config.js's OLLAMA_URL check).
    # This value is only used for the /health self-report and log lines;
    # binding itself is controlled by how uvicorn is invoked (see README).
    host: str = os.environ.get("INDICTRANS_HOST", "127.0.0.1")
    port: int = int(os.environ.get("INDICTRANS_PORT", "8100"))

    # Base directory containing three subdirectories: en-indic/, indic-en/,
    # indic-indic/ — each a downloaded IndicTrans2 checkpoint (see
    # scripts/download_model.py). No hardcoded default: a missing/unset
    # path is a real setup error, not something to silently paper over.
    model_path: str | None = os.environ.get("INDICTRANS_MODEL_PATH")

    # auto | cpu | cuda. "auto" picks cuda when torch reports it available,
    # else cpu. See model_registry.py.
    device: str = os.environ.get("TRANSLATION_DEVICE", "auto")

    # Generation limits — kept modest for a desktop CPU-fallback case.
    max_input_chars: int = int(os.environ.get("INDICTRANS_MAX_CHARS", "5000"))
    max_new_tokens: int = int(os.environ.get("INDICTRANS_MAX_NEW_TOKENS", "256"))
    num_beams: int = int(os.environ.get("INDICTRANS_NUM_BEAMS", "5"))

    def model_dir(self, direction: str) -> Path | None:
        if not self.model_path:
            return None
        return Path(self.model_path) / direction


settings = Settings()
