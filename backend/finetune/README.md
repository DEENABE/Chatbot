# Fine-tuning the Chanakya repair model

Turn logged repair sessions into a specialized local model
(`chanakya-repair`) that the agent uses via `AGENT_MODEL`.

```
repair-sessions.json ──export──► repair-dataset.jsonl ──train──► GGUF ──► Ollama
   (raw log)                        (training data)      (Colab GPU)   (your PC)
```

## 1. Collect data

Every repair you run in the app is logged to
`../storage/repair-sessions.json`. Give a 👍 on the ones that worked — only
those become training examples. To grow the set faster you can also hand-write
sessions, or have another AI generate them (see the prompt in the project
chat). Aim for **300+ good, diverse sessions across all 6 domains**.

## 2. Export the dataset

```powershell
cd ..
node src/ai/exportDataset.cli.js
```

This filters to the good sessions and writes
`../storage/repair-dataset.jsonl` (chat format, one example per line).

## 3. Train (Google Colab — free GPU)

1. Open <https://colab.research.google.com> → new notebook.
2. `Runtime → Change runtime type → T4 GPU`.
3. Upload `repair-dataset.jsonl` (left panel → upload).
4. Open `train_chanakya.py` here and run its cells (`# %%` blocks) top to
   bottom — or upload it and `!python train_chanakya.py`.
5. When it finishes, download the `*.gguf` file from the
   `chanakya-repair-gguf/` folder.

Training a few hundred examples on a T4 takes roughly 10–30 minutes.

## 4. Load into Ollama (your PC)

Put the downloaded `.gguf` and the `Modelfile` in the same folder, fix the
`FROM` line to match the real `.gguf` filename, then:

```powershell
ollama create chanakya-repair -f Modelfile
ollama run chanakya-repair "My wifi is connected but no internet"
```

## 5. Point the app at it

In `backend/.env`:

```
AGENT_MODEL=chanakya-repair
```

Restart the backend. The agent now reasons with your fine-tuned model.

---

### ⚠️ Format note

The current `exportTrainingData()` emits a **prose summary** ("Commands
used: …"). The agent loop, however, expects a **step-by-step JSON** object
each turn (`{thought, command, done, answer}`). If you want the fine-tuned
model to drive the agent loop directly, change the exporter to emit those
JSON turns before training — otherwise train it for plain repair Q&A only.
