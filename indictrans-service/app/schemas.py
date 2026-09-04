"""
Pydantic request/response models. The response shapes here are the
contract the Node backend's translationService.js parses directly — keep
them stable; changing field names is a breaking change across the
Node/Python boundary.
"""

from typing import Literal

from pydantic import BaseModel, Field

ErrorCode = Literal[
    "MODEL_NOT_LOADED",
    "UNSUPPORTED_PAIR",
    "EMPTY_OUTPUT",
    "INTERNAL_ERROR",
]


class TranslateRequest(BaseModel):
    source_lang: str = Field(..., min_length=1, max_length=32)
    target_lang: str = Field(..., min_length=1, max_length=32)
    text: str = Field(..., min_length=1)


class TranslateResponse(BaseModel):
    translation: str


class ErrorResponse(BaseModel):
    # `error_code` is what Node's translationService.js switches on to pick
    # the right client-safe TranslationError message — never send the raw
    # exception string here. `detail` is for the Python service's own logs
    # and is not required to be present; Node never echoes it to a client.
    error_code: ErrorCode
    detail: str | None = None


class HealthResponse(BaseModel):
    status: Literal["ok", "loading", "model_missing"]
    models_loaded: dict[str, bool]
    device: str
