#!/usr/bin/env python
"""
Explicit, one-time model download. NEVER imported or invoked automatically
by the running service (app/main.py, app/model_registry.py) — the service
only ever *reads* an already-populated INDICTRANS_MODEL_PATH. Run this
yourself, once, before starting the service for the first time:

    python scripts/download_model.py --dest ./models

Downloads AI4Bharat's distilled IndicTrans2 checkpoints (the smaller
200M/320M-parameter variants — appropriate for a desktop app; the full
1B-parameter checkpoints exist but are considerably larger and slower on
CPU) into three subdirectories under --dest, matching what
app/model_registry.py expects: en-indic/, indic-en/, indic-indic/.

You can pass --only to download a subset (e.g. just en-indic and
indic-en if you don't need Indic-to-Indic translation) — the service
degrades gracefully for any direction whose directory is missing.
"""

import argparse
import sys
from pathlib import Path

CHECKPOINTS = {
    "en-indic": "ai4bharat/indictrans2-en-indic-dist-200M",
    "indic-en": "ai4bharat/indictrans2-indic-en-dist-200M",
    "indic-indic": "ai4bharat/indictrans2-indic-indic-dist-320M",
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dest", default="./models", help="Destination directory (default: ./models)")
    parser.add_argument(
        "--only",
        nargs="+",
        choices=list(CHECKPOINTS.keys()),
        default=list(CHECKPOINTS.keys()),
        help="Download only these directions (default: all three)",
    )
    args = parser.parse_args()

    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print(
            "huggingface_hub is not installed. Run `pip install -r requirements.txt` first.",
            file=sys.stderr,
        )
        return 1

    dest_root = Path(args.dest).resolve()
    dest_root.mkdir(parents=True, exist_ok=True)

    for direction in args.only:
        repo_id = CHECKPOINTS[direction]
        target = dest_root / direction
        print(f"Downloading {repo_id} -> {target} ...")
        snapshot_download(repo_id=repo_id, local_dir=str(target))
        print(f"  done: {direction}")

    print()
    print("All requested checkpoints downloaded.")
    print(f"Now set INDICTRANS_MODEL_PATH={dest_root} in indictrans-service/.env")
    print("and start the service: uvicorn app.main:app --host 127.0.0.1 --port 8100")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
