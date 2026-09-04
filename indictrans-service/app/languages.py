"""
FLORES-200-style language identifiers this service understands, and which
of the three IndicTrans2 directional checkpoints a given (source, target)
pair needs. Mirrors backend/src/services/languageRegistry.js on the Node
side — the two lists must be kept in sync when a language is added.

Adding a language later: add one entry to LANGUAGES here (and the matching
entry in the Node registry), then make sure the relevant checkpoint(s)
actually cover it. IndicTrans2's checkpoints are trained on a fixed set of
languages; adding one this model was never trained on requires an updated
checkpoint or fine-tuning, not a code change here.
"""

ENGLISH = "eng_Latn"

# label: readable name, used only in log lines / error messages, never
# required for correctness.
LANGUAGES = {
    "eng_Latn": "English",
    "hin_Deva": "Hindi",
    "tam_Taml": "Tamil",
    "kan_Knda": "Kannada",
    "tel_Telu": "Telugu",
    "mal_Mlym": "Malayalam",
}

LANGUAGE_CODES = frozenset(LANGUAGES.keys())


class ModelDirection:
    EN_INDIC = "en-indic"
    INDIC_EN = "indic-en"
    INDIC_INDIC = "indic-indic"


def resolve_direction(source_lang: str, target_lang: str) -> str | None:
    """
    Returns which of the three IndicTrans2 checkpoints handles this pair,
    or None if the pair isn't a supported combination (both English, or
    either code unknown). This is the "translation router" — it only
    picks a bucket; the actual per-language handling inside that bucket is
    the model's own job (IndicTrans2's indic-* checkpoints are already
    multi-lingual within their bucket).
    """
    if source_lang not in LANGUAGE_CODES or target_lang not in LANGUAGE_CODES:
        return None
    if source_lang == target_lang:
        return None
    source_is_en = source_lang == ENGLISH
    target_is_en = target_lang == ENGLISH
    if source_is_en and not target_is_en:
        return ModelDirection.EN_INDIC
    if target_is_en and not source_is_en:
        return ModelDirection.INDIC_EN
    if not source_is_en and not target_is_en:
        return ModelDirection.INDIC_INDIC
    return None  # both English — not a real translation request
