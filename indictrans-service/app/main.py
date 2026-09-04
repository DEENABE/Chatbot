"""
IndicTrans2 translation microservice. Run with:
    uvicorn app.main:app --host 127.0.0.1 --port 8100
(see README.md for full setup — venv, pip install, model download).

Loopback-only by convention (matches the rest of this app's local-only AI
endpoints): nothing here authenticates callers, because the only expected
caller is the Node backend on the same machine, itself already gated by
the app's real authentication layer before a request ever reaches here.
Do not expose this service's port beyond localhost.
"""

import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .config import settings
from .languages import LANGUAGE_CODES, resolve_direction
from .model_registry import EmptyOutputError, ModelNotLoadedError, registry, translate
from .schemas import ErrorResponse, HealthResponse, TranslateRequest, TranslateResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("indictrans.main")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logger.info("indictrans: loading models at startup (this can take a while on first run)...")
    registry.load_all()
    logger.info("indictrans: startup complete. status=%s device=%s", registry.status(), registry.device)
    yield


app = FastAPI(title="IndicTrans2 Translation Service", lifespan=lifespan)


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    loaded = registry.status()
    # "ok" as soon as at least one direction is usable — /translate itself
    # is the source of truth for whether a *specific* requested pair
    # works, so this doesn't flap to "model_missing" just because e.g.
    # indic-indic wasn't downloaded.
    status = "ok" if any(loaded.values()) else "model_missing"
    return HealthResponse(status=status, models_loaded=loaded, device=registry.device)


@app.post("/translate", response_model=TranslateResponse, responses={400: {"model": ErrorResponse}, 503: {"model": ErrorResponse}, 500: {"model": ErrorResponse}})
async def translate_endpoint(payload: TranslateRequest, request: Request):
    started = time.monotonic()

    if len(payload.text) > settings.max_input_chars:
        return _error(400, "UNSUPPORTED_PAIR", f"text exceeds {settings.max_input_chars} characters")

    direction = resolve_direction(payload.source_lang, payload.target_lang)
    if direction is None:
        return _error(
            400,
            "UNSUPPORTED_PAIR",
            f"unsupported language pair: {payload.source_lang} -> {payload.target_lang} "
            f"(known codes: {sorted(LANGUAGE_CODES)})",
        )

    try:
        result = translate(direction, payload.source_lang, payload.target_lang, payload.text)
    except ModelNotLoadedError as exc:
        logger.warning("translate: %s", exc)
        return _error(503, "MODEL_NOT_LOADED", str(exc))
    except EmptyOutputError:
        logger.warning("translate: model produced empty output for direction=%s", direction)
        return _error(500, "EMPTY_OUTPUT", "model produced no output")
    except Exception:
        # Never leak the raw exception (could contain a filesystem path
        # from a torch/transformers internal error) to the caller — same
        # "safe message to client, full detail only in the server log"
        # split the Node side already uses everywhere else.
        logger.exception("translate: unexpected failure (direction=%s)", direction)
        return _error(500, "INTERNAL_ERROR", "unexpected translation failure")

    duration_ms = int((time.monotonic() - started) * 1000)
    logger.info(
        "translate: ok direction=%s chars=%d duration_ms=%d",
        direction,
        len(payload.text),
        duration_ms,
    )
    return TranslateResponse(translation=result)


def _error(status_code: int, error_code: str, detail: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content=ErrorResponse(error_code=error_code, detail=detail).model_dump())
