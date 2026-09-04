"""
Loads IndicTrans2's three directional checkpoints ONCE and reuses them for
every request — never load-per-request. This is the "model registry"
pattern the plan calls for: a single module-level singleton, populated at
FastAPI startup, read (never re-loaded) on every /translate call.

IndicTrans2 ships as three separate distilled models, not one
multi-directional model:
  - en-indic:    English -> any supported Indic language
  - indic-en:    any supported Indic language -> English
  - indic-indic: Indic -> Indic (e.g. Tamil -> Hindi)
Each direction is loaded independently and *may be absent* (its checkpoint
directory missing) without the other two being affected — a missing
direction degrades to a clear "not loaded" error for requests needing it,
never a crash and never a silent fallback to a different model.

Inference follows AI4Bharat's own published usage pattern for these
checkpoints: IndicProcessor (from the IndicTransToolkit package) handles
the script-aware preprocessing/postprocessing IndicTrans2 requires, and the
model itself is a standard HF AutoModelForSeq2SeqLM loaded with
trust_remote_code=True (IndicTrans2 uses a custom modeling class).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from .config import settings
from .languages import ModelDirection

logger = logging.getLogger("indictrans.model_registry")

_DIRECTIONS = (
    ModelDirection.EN_INDIC,
    ModelDirection.INDIC_EN,
    ModelDirection.INDIC_INDIC,
)


@dataclass
class LoadedModel:
    tokenizer: object
    model: object
    processor: object
    device: str


class ModelRegistry:
    def __init__(self) -> None:
        self._models: dict[str, LoadedModel | None] = {d: None for d in _DIRECTIONS}
        self._device: str = "cpu"
        self._load_attempted = False

    @property
    def device(self) -> str:
        return self._device

    def status(self) -> dict[str, bool]:
        return {direction: (self._models[direction] is not None) for direction in _DIRECTIONS}

    def get(self, direction: str) -> LoadedModel | None:
        return self._models.get(direction)

    def load_all(self) -> None:
        """
        Called once from FastAPI's startup hook. Never raises — a missing
        or broken checkpoint for one direction is logged and left as None
        (that direction's /translate calls then return MODEL_NOT_LOADED,
        503) rather than taking the whole service down. This matters
        because a user may legitimately only download one or two of the
        three directions.
        """
        self._load_attempted = True
        self._device = _resolve_device(settings.device)
        logger.info("indictrans: resolved device=%s (requested=%s)", self._device, settings.device)

        if not settings.model_path:
            logger.warning(
                "indictrans: INDICTRANS_MODEL_PATH is not set — no models will be loaded. "
                "See indictrans-service/README.md for setup."
            )
            return

        for direction in _DIRECTIONS:
            model_dir = settings.model_dir(direction)
            if model_dir is None or not model_dir.exists():
                logger.warning(
                    "indictrans: checkpoint for '%s' not found at %s — that direction will "
                    "return MODEL_NOT_LOADED until it is downloaded (see scripts/download_model.py).",
                    direction,
                    model_dir,
                )
                continue
            try:
                self._models[direction] = _load_one(model_dir, self._device)
                logger.info("indictrans: loaded '%s' from %s", direction, model_dir)
            except Exception:
                # Never let one bad checkpoint crash startup or take down
                # the other two directions.
                logger.exception("indictrans: failed to load '%s' from %s", direction, model_dir)
                self._models[direction] = None


def _resolve_device(requested: str) -> str:
    if requested == "cpu":
        return "cpu"
    if requested == "cuda":
        return "cuda"
    # "auto" (or anything unrecognized, treated as auto rather than a hard
    # error — a typo here shouldn't refuse to start the service)
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        logger.warning("indictrans: torch not available while probing for CUDA — falling back to cpu.")
    return "cpu"


def _load_one(model_dir, device: str) -> LoadedModel:
    import torch
    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

    try:
        from IndicTransToolkit.processor import IndicProcessor
    except ImportError as exc:  # pragma: no cover - environment problem, not code logic
        raise RuntimeError(
            "IndicTransToolkit is not installed. Run `pip install -r requirements.txt` "
            "in the indictrans-service virtualenv."
        ) from exc

    tokenizer = AutoTokenizer.from_pretrained(str(model_dir), trust_remote_code=True)
    dtype = torch.float16 if device == "cuda" else torch.float32
    model = AutoModelForSeq2SeqLM.from_pretrained(str(model_dir), trust_remote_code=True, torch_dtype=dtype)
    model = model.to(device)
    model.eval()

    processor = IndicProcessor(inference=True)

    return LoadedModel(tokenizer=tokenizer, model=model, processor=processor, device=device)


registry = ModelRegistry()


def translate(direction: str, source_lang: str, target_lang: str, text: str) -> str:
    """
    Runs one translation through the loaded model for `direction`. Raises
    RuntimeError with a plain message on any failure — main.py maps that
    to the ErrorResponse contract; this function itself never talks HTTP.
    """
    loaded = registry.get(direction)
    if loaded is None:
        raise ModelNotLoadedError(direction)

    import torch

    batch = loaded.processor.preprocess_batch([text], src_lang=source_lang, tgt_lang=target_lang)
    inputs = loaded.tokenizer(
        batch,
        truncation=True,
        padding="longest",
        return_tensors="pt",
    ).to(loaded.device)

    with torch.no_grad():
        generated = loaded.model.generate(
            **inputs,
            min_length=0,
            max_length=settings.max_new_tokens,
            num_beams=settings.num_beams,
            num_return_sequences=1,
        )

    decoded = loaded.tokenizer.batch_decode(generated, skip_special_tokens=True, clean_up_tokenization_spaces=True)
    results = loaded.processor.postprocess_batch(decoded, lang=target_lang)

    if not results or not results[0].strip():
        raise EmptyOutputError()

    return results[0].strip()


class ModelNotLoadedError(RuntimeError):
    def __init__(self, direction: str) -> None:
        super().__init__(f"Model for direction '{direction}' is not loaded.")
        self.direction = direction


class EmptyOutputError(RuntimeError):
    pass
