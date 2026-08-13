#!/usr/bin/env python3
"""
clean_dataset.py - remove template clones and evidence-free records from a
merged Windows repair dataset.

WHY
---
When two sources are combined, one may contain "template families": the same
scenario emitted 10-15 times with only "(Type 1)...(Type 15)" changed, while
the commands, stdout and summary stay byte-identical. Training on those teaches
the model to memorise one answer rather than to reason, and it silently skews
the domain distribution.

It also flags records whose steps produce no stdout at all - those provide no
evidence for the stated root cause, which is the opposite of what a diagnostic
agent should learn.

WHAT IT DOES
------------
  1. Fingerprints every record by (summary + command sequence), ignoring the goal.
  2. Keeps ONE record per fingerprint - the one with the most evidence.
  3. Reports (and optionally drops) records where every step has empty stdout.
  4. Rewrites both repair-sessions.json and repair-dataset.jsonl, mirrored.
  5. Writes a report of exactly what was removed.

USAGE
-----
    python clean_dataset.py                      # audit only, writes nothing
    python clean_dataset.py --apply              # drop clones, keep evidence-free
    python clean_dataset.py --apply --drop-empty # also drop evidence-free records
"""
import json, argparse, hashlib, collections, os, shutil
from datetime import datetime

JSON_PATH  = "repair-sessions.json"
JSONL_PATH = "repair-dataset.jsonl"

def fingerprint(rec):
    """Content identity ignoring the goal wording."""
    body = rec.get("summary", "") + "|" + "|".join(
        s.get("command", "") for s in rec.get("steps", []))
    return hashlib.md5(body.encode("utf-8")).hexdigest()

def evidence_score(rec):
    """Higher = more useful as training data."""
    steps = rec.get("steps", [])
    out_chars = sum(len(s.get("stdout", "") or "") for s in steps)
    has_fail  = any(s.get("exitCode", 0) for s in steps)
    return (out_chars, len(steps), len(rec.get("summary", "")), int(has_fail))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write the cleaned files")
    ap.add_argument("--drop-empty", action="store_true",
                    help="also remove records where every step has empty stdout")
    ap.add_argument("--json", default=JSON_PATH)
    ap.add_argument("--jsonl", default=JSONL_PATH)
    args = ap.parse_args()

    data = json.load(open(args.json, encoding="utf-8"))
    print(f"loaded {len(data)} records from {args.json}")

    # ---------------- group by content fingerprint ----------------
    groups = collections.defaultdict(list)
    for r in data:
        groups[fingerprint(r)].append(r)

    clone_families = {k: v for k, v in groups.items() if len(v) > 1}
    clone_records  = sum(len(v) for v in clone_families.values())
    removable      = clone_records - len(clone_families)

    print(f"\n=== TEMPLATE CLONE ANALYSIS ===")
    print(f"  distinct content fingerprints : {len(groups)}")
    print(f"  clone families (>1 copy)      : {len(clone_families)}")
    print(f"  records inside clone families : {clone_records}")
    print(f"  removable duplicate copies    : {removable}")

    if clone_families:
        print(f"\n  largest clone families:")
        for k, v in sorted(clone_families.items(), key=lambda x: -len(x[1]))[:8]:
            print(f"    x{len(v):3d}  {v[0]['goal'][:66]}")

    # ---------------- evidence check ----------------
    def is_empty(r):
        st = r.get("steps", [])
        return bool(st) and all(not (s.get("stdout") or "").strip() for s in st)

    empty_records = [r for r in data if is_empty(r)]
    print(f"\n=== EVIDENCE CHECK ===")
    print(f"  records with NO command output : {len(empty_records)} "
          f"({len(empty_records)*100//max(1,len(data))}%)")
    print(f"  records with a failing step    : "
          f"{sum(1 for r in data if any(s.get('exitCode',0) for s in r.get('steps',[])))}")

    # ---------------- build the keep list ----------------
    keep = []
    for fp, members in groups.items():
        best = max(members, key=evidence_score)   # keep the most evidence-rich copy
        keep.append(best)
    keep.sort(key=lambda r: r.get("createdAt", ""))

    dropped_empty = 0
    if args.drop_empty:
        before = len(keep)
        keep = [r for r in keep if not is_empty(r)]
        dropped_empty = before - len(keep)

    print(f"\n=== RESULT ===")
    print(f"  before                : {len(data)}")
    print(f"  clone copies removed  : {removable}")
    if args.drop_empty:
        print(f"  evidence-free removed : {dropped_empty}")
    print(f"  after                 : {len(keep)}")

    if not args.apply:
        print("\n(audit only - nothing written. Add --apply to write the cleaned files.)")
        return

    # ---------------- backup + write ----------------
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    for p in (args.json, args.jsonl):
        if os.path.exists(p):
            shutil.copy2(p, f"{p}.{stamp}.bak")
    print(f"\nbackups written with suffix .{stamp}.bak")

    json.dump(keep, open(args.json, "w", encoding="utf-8"),
              indent=2, ensure_ascii=False)

    lines = []
    for r in keep:
        cmds = "\n".join(
            f"- {s['command']}" + (f"  [FAILED: {(s.get('stderr') or '')[:70]}]"
                                   if s.get("exitCode") else "")
            for s in r.get("steps", []))
        sub = f" ({r['subdomain']})" if r.get("subdomain") else ""
        note = "" if r.get("resolved", True) else "\nNOTE: not resolved - see recommendation."
        lines.append(json.dumps({"messages": [
            {"role": "system",
             "content": f"You are a Windows repair expert specializing in {r.get('domain','windows')}{sub} problems. "
                        f"Diagnose with read-only commands first, then apply safe fixes. "
                        f"When a command fails, interpret the error and adapt."},
            {"role": "user", "content": r["goal"]},
            {"role": "assistant",
             "content": f"{r['summary']}\nCommands used:\n{cmds}\nRecommendation: {r['recommendation']}{note}"}
        ]}, ensure_ascii=False) + "\n")
    open(args.jsonl, "w", encoding="utf-8").writelines(lines)

    # ---------------- report ----------------
    report = {
        "cleanedAt": datetime.now().isoformat(),
        "before": len(data), "after": len(keep),
        "cloneCopiesRemoved": removable,
        "evidenceFreeRemoved": dropped_empty,
        "cloneFamilies": [
            {"count": len(v), "goal": v[0]["goal"], "domain": v[0].get("domain")}
            for v in sorted(clone_families.values(), key=lambda x: -len(x))[:50]
        ],
    }
    json.dump(report, open("cleanup-report.json", "w", encoding="utf-8"),
              indent=2, ensure_ascii=False)

    print(f"wrote {args.json} ({len(keep)} records)")
    print(f"wrote {args.jsonl} ({len(lines)} lines)")
    print("wrote cleanup-report.json")

if __name__ == "__main__":
    main()
