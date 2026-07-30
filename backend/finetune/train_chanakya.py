"""
Chanakya-Repair fine-tune — Unsloth LoRA on Qwen2.5.

Run this in Google Colab (free T4 GPU) or on any local NVIDIA-GPU machine.
It reads `repair-dataset.jsonl` (exported by `node src/ai/exportDataset.cli.js`)
and produces a GGUF model you can load into Ollama.

The file is split into `# %%` cells so you can paste them into Colab one at a
time, or run the whole thing with `python train_chanakya.py` on a GPU box.
"""

# ── Config ──────────────────────────────────────────────────────────────
BASE_MODEL   = "unsloth/Qwen2.5-7B-Instruct-bnb-4bit"  # use 3B for small GPUs
DATASET_PATH = "repair-dataset.jsonl"                  # upload this into Colab
OUTPUT_GGUF  = "chanakya-repair-gguf"
MAX_SEQ_LEN  = 2048
EPOCHS       = 3            # 3 for a few-hundred examples; 1-2 for thousands
LEARNING_RATE = 2e-4
QUANT        = "q4_k_m"     # small + fast; use "q8_0" for higher quality

# %% [1] Install (run only in Colab / fresh machine) -----------------------
# !pip install "unsloth[colab-new] @ git+https://github.com/unslothai/unsloth.git"
# !pip install --no-deps trl peft accelerate bitsandbytes

# %% [2] Load the base model in 4-bit --------------------------------------
from unsloth import FastLanguageModel
import torch

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name     = BASE_MODEL,
    max_seq_length = MAX_SEQ_LEN,
    load_in_4bit   = True,
)

# %% [3] Attach LoRA adapters (only these ~1% of weights get trained) ------
model = FastLanguageModel.get_peft_model(
    model,
    r = 16,
    target_modules = ["q_proj", "k_proj", "v_proj", "o_proj",
                      "gate_proj", "up_proj", "down_proj"],
    lora_alpha = 16,
    lora_dropout = 0,
    bias = "none",
    use_gradient_checkpointing = "unsloth",
    random_state = 3407,
)

# %% [4] Load the dataset and apply the Qwen chat template ------------------
from datasets import load_dataset
from unsloth.chat_templates import get_chat_template

tokenizer = get_chat_template(tokenizer, chat_template="qwen-2.5")
dataset = load_dataset("json", data_files=DATASET_PATH, split="train")

def to_text(batch):
    return {
        "text": [
            tokenizer.apply_chat_template(msgs, tokenize=False,
                                          add_generation_prompt=False)
            for msgs in batch["messages"]
        ]
    }

dataset = dataset.map(to_text, batched=True)
print(f"Loaded {len(dataset)} training examples")

# %% [5] Train -------------------------------------------------------------
from trl import SFTTrainer
from transformers import TrainingArguments

trainer = SFTTrainer(
    model = model,
    tokenizer = tokenizer,
    train_dataset = dataset,
    dataset_text_field = "text",
    max_seq_length = MAX_SEQ_LEN,
    args = TrainingArguments(
        per_device_train_batch_size = 2,
        gradient_accumulation_steps = 4,
        warmup_steps = 5,
        num_train_epochs = EPOCHS,
        learning_rate = LEARNING_RATE,
        bf16 = torch.cuda.is_bf16_supported(),
        fp16 = not torch.cuda.is_bf16_supported(),
        optim = "adamw_8bit",
        weight_decay = 0.01,
        lr_scheduler_type = "linear",
        logging_steps = 1,
        seed = 3407,
        output_dir = "outputs",
    ),
)
trainer.train()

# %% [6] Export to GGUF for Ollama -----------------------------------------
model.save_pretrained_gguf(OUTPUT_GGUF, tokenizer, quantization_method=QUANT)
print(f"\nDone. GGUF written under: {OUTPUT_GGUF}/")
print("Download the *.gguf file, put the Modelfile next to it, then run:")
print("  ollama create chanakya-repair -f Modelfile")
