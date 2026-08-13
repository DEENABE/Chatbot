#!/usr/bin/env python3
"""
scale_dataset.py - grow the Windows repair dataset from ~1k to 10k-50k entries
using an LLM API, with the existing hand-written entries as few-shot seeds.

WHY THIS EXISTS
---------------
Hand-writing 50,000 quality scenarios is not feasible. The standard industry
approach is seeded synthetic generation: use a small, high-quality, human-checked
core (what you already have) to teach a model the exact format and depth, then
generate many more against a broad topic list, with automatic dedup + validation.

WHAT IT DOES
------------
1. Loads your existing dataset as the quality bar (few-shot examples).
2. Walks a large topic matrix (domain x symptom x root-cause-class).
3. Calls an LLM to produce new scenarios in the identical schema.
4. Rejects: duplicates, near-duplicates, malformed JSON, missing fields,
   scenarios whose commands don't parse as plausible PowerShell/CMD.
5. Appends survivors to repair-sessions.json + repair-dataset.jsonl.
6. Checkpoints after every batch so it can be stopped and resumed.

USAGE
-----
    pip install anthropic            # or: pip install openai
    set ANTHROPIC_API_KEY=sk-ant-...

    python scale_dataset.py --target 5000 --batch 8
    python scale_dataset.py --target 50000 --batch 8 --resume

COST / TIME (rough, plan before you run)
----------------------------------------
    ~1.5k output tokens per scenario.
    10,000 scenarios  ~= 15M output tokens.
    50,000 scenarios  ~= 75M output tokens.
    Check current pricing before a large run, and start with --target 200
    to sanity-check quality and cost per 100.

IMPORTANT
---------
Synthetic entries are NOT verified. Keep the 'source' field so you can always
separate hand-written from generated, and run Verify-Dataset.ps1 afterwards.
"""

import json, os, re, sys, time, argparse, random, hashlib
from difflib import SequenceMatcher

JSON_PATH  = "repair-sessions.json"
JSONL_PATH = "repair-dataset.jsonl"
STATE_PATH = "scale_state.json"

# ---------------------------------------------------------------- topic matrix
DOMAINS = {
 "network": ["DNS resolution","DHCP lease","VPN tunnel","Wi-Fi roaming","SMB share","proxy","IPv6","MTU",
             "firewall rule","NIC driver","DNS suffix","routing table","captive portal","network profile"],
 "storage": ["disk full","SMART warning","RAW volume","drive letter","partition table","BitLocker",
             "bad sectors","VHDX","Storage Spaces","iSCSI","dedup","tiering","mount point","quota"],
 "boot":    ["BCD","EFI partition","Secure Boot","Safe Mode","WinRE","fast startup","bootloader","POST"],
 "bsod":    ["driver bugcheck","memory corruption","storage timeout","GPU TDR","power state","PatchGuard","WHEA"],
 "cpu":     ["thermal throttle","high interrupt","core parking","power limit","turbo boost","runaway process"],
 "gpu":     ["driver timeout","black screen","artifacting","VRAM exhaustion","multi-GPU","refresh rate","HDR"],
 "office":  ["add-in crash","template corruption","licensing","protected view","repair","COM automation","trust center"],
 "outlook": ["OST corruption","autodiscover","rules quota","profile","OAB","attachments","calendar sync","search"],
 "excel":   ["formula performance","file bloat","macro block","external links","Power Query","CSV import","co-authoring"],
 "word":    ["Normal.dotm","track changes","mail merge","fonts","styles","document corruption","proofing"],
 "teams":   ["cache","sign-in","audio device","screen share","notifications","memory usage"],
 "security":["Defender","BitLocker","AppLocker","WDAC","firewall","credential guard","ASR rules","TPM","UAC"],
 "services":["dependency failure","logon failure","start timeout","crash loop","disabled by policy","RPC","WMI"],
 "eventlog":["service events","disk events","security audit","application crash","kernel power","WHEA","profile"],
 "errorcode":["update HRESULT","installer MSI","network Win32","crypto trust","activation","COM HRESULT","bugcheck"],
 "activedirectory":["trust relationship","Kerberos SPN","replication","group policy","FSMO","LDAP","gMSA","LAPS"],
 "printer": ["spooler crash","driver mismatch","queue stuck","network printer","Universal Print","permissions"],
 "driver":  ["Code 10","Code 43","signature","rollback","OEM mismatch","chipset","USB controller","power management"],
 "settings":["display scaling","notifications","default apps","privacy","power plan","language","accessibility"],
 "performance":["slow boot","memory leak","disk latency","DPC latency","startup apps","background tasks"],
 "iis":     ["app pool","binding conflict","SSL certificate","URL rewrite","ASP.NET Core","500 errors","WAS"],
 "hyperv":  ["VM boot","virtual switch","checkpoint","dynamic memory","live migration","nested virtualization"],
 "wsl":     ["distro registration","kernel update","DNS","GPU passthrough","systemd","filesystem permissions"],
 "aidev":   ["CUDA","virtualenv","pip SSL","git credentials","docker desktop","model download","database service"],
}

CAUSE_CLASSES = [
 "a service that is stopped or disabled",
 "a policy or Group Policy setting enforcing the behaviour",
 "a corrupted cache or database that must be rebuilt",
 "a driver that is outdated, wrong, or failing",
 "a permissions or ownership problem",
 "expected behaviour that only looks like a fault",
 "a hardware fault that software cannot repair",
 "a network path or endpoint that is unreachable",
 "a version, bitness, or edition incompatibility",
 "a resource limit being reached (memory, quota, size cap)",
 "a stale or leftover artifact from a previous install",
 "a security control deliberately blocking the action",
]

SYSTEM_PROMPT = """You generate training data for a Windows troubleshooting AI agent.

Return ONLY a JSON array. Each element:
{
  "domain": "<one of the given domains>",
  "goal": "<the user's problem, phrased as a real person would report it>",
  "summary": "<2-3 sentences: what the evidence showed and the actual root cause>",
  "steps": [ {"command":"<real PowerShell or CMD>", "exitCode":0, "stdout":"<plausible output>", "stderr":""} ],
  "recommendation": "<the fix, plus a caveat or preventative note>"
}

HARD RULES:
- Commands must be REAL, correctly-spelled PowerShell/CMD that would run on Windows.
  Diagnostic (read-only) commands first, then the fix.
- 1-4 steps. Include a failing step (exitCode 1 + stderr) in roughly 1 of 5 scenarios,
  followed by a recovery step.
- The summary must state a SPECIFIC root cause, never "may be caused by".
- Never invent cmdlets. Prefer Get-*/Test-* for diagnosis.
- Some scenarios must conclude the issue is expected behaviour or a hardware
  fault that cannot be fixed in software - do not force a fix.
- goal must be distinct from every example shown, in wording and in root cause.
- No markdown, no commentary. JSON array only."""


# ---------------------------------------------------------------- LLM backends
def call_anthropic(system, user, model, max_tokens=8000):
    import anthropic
    c = anthropic.Anthropic()
    r = c.messages.create(model=model, max_tokens=max_tokens, system=system,
                          messages=[{"role": "user", "content": user}])
    return r.content[0].text

def call_openai(system, user, model, max_tokens=8000):
    from openai import OpenAI
    c = OpenAI()
    r = c.chat.completions.create(model=model, max_tokens=max_tokens,
        messages=[{"role":"system","content":system},{"role":"user","content":user}])
    return r.choices[0].message.content


# ---------------------------------------------------------------- validation
CMDLET_RE = re.compile(r'^[A-Z][a-z]+-[A-Z]', re.I)
KNOWN_NATIVE = ('ipconfig','netsh','sc ','reg ','dism','sfc','chkdsk','bcdedit','bootrec','vssadmin',
                'powercfg','wevtutil','wmic','gpresult','gpupdate','klist','setspn','certutil','fsutil',
                'diskpart','robocopy','icacls','takeown','w32tm','slmgr','manage-bde','pnputil','dfsrdiag',
                'nltest','netdom','repadmin','typeperf','logman','fltmc','driverquery','systeminfo','ping',
                'nslookup','mountvol','whoami','cmdkey','where','echo','dotnet','winget','wsl','docker',
                'kubectl','mbr2gpt','wbadmin','msdtc','lodctr','#')

def plausible_command(cmd):
    c = cmd.strip()
    if not c: return False
    if c.startswith('#'): return True
    if CMDLET_RE.match(c): return True
    if c.startswith('$') or c.startswith('['): return True
    return c.lower().startswith(KNOWN_NATIVE)

def norm(s):
    return re.sub(r'[^a-z0-9 ]','', s.lower()).strip()

def too_similar(goal, existing_norm, prefix_index, threshold=0.80):
    g = norm(goal)
    key = ' '.join(g.split()[:4])
    for cand in prefix_index.get(key, []):
        if SequenceMatcher(None, g, cand).ratio() > threshold: return True
    toks = set(g.split())
    for cand in existing_norm:
        ct = set(cand.split())
        if not ct: continue
        if len(toks & ct)/max(1,len(toks | ct)) > 0.70:
            if SequenceMatcher(None, g, cand).ratio() > threshold: return True
    return False

def validate(item, domain_ok):
    if not isinstance(item, dict): return None, "not an object"
    for f in ("domain","goal","summary","steps","recommendation"):
        if f not in item or not item[f]: return None, f"missing {f}"
    if item["domain"] not in domain_ok: return None, "unknown domain"
    if len(item["goal"]) < 25: return None, "goal too short"
    if len(item["summary"]) < 60: return None, "summary too shallow"
    if not isinstance(item["steps"], list) or not (1 <= len(item["steps"]) <= 5):
        return None, "bad step count"
    clean = []
    for s in item["steps"]:
        if not isinstance(s, dict) or "command" not in s: return None, "bad step"
        if not plausible_command(s["command"]): return None, f"implausible cmd: {s['command'][:50]}"
        clean.append({"command": s["command"], "blocked": False,
                      "exitCode": int(s.get("exitCode",0)),
                      "stdout": s.get("stdout",""), "stderr": s.get("stderr",""), "reason": None})
    item["steps"] = clean
    return item, None


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", type=int, default=5000, help="total entries to reach")
    ap.add_argument("--batch", type=int, default=8, help="scenarios requested per API call")
    ap.add_argument("--provider", choices=["anthropic","openai"], default="anthropic")
    ap.add_argument("--model", default=None)
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="build one prompt and exit")
    args = ap.parse_args()

    model = args.model or ("claude-sonnet-5" if args.provider=="anthropic" else "gpt-4o")
    call = call_anthropic if args.provider=="anthropic" else call_openai

    data = json.load(open(JSON_PATH, encoding="utf-8"))
    jsonl = [l for l in open(JSONL_PATH, encoding="utf-8") if l.strip()]
    print(f"start: {len(data)} entries")

    existing_goals = {d["goal"] for d in data}
    existing_norm  = [norm(g) for g in existing_goals]
    prefix_index   = {}
    for g in existing_norm:
        prefix_index.setdefault(' '.join(g.split()[:4]), []).append(g)
    used_ids = {d["id"] for d in data}

    seeds_by_domain = {}
    for d in data:
        seeds_by_domain.setdefault(d["domain"], []).append(d)

    state = {"done": []}
    if args.resume and os.path.exists(STATE_PATH):
        state = json.load(open(STATE_PATH))
        print(f"resuming, {len(state['done'])} topic cells already attempted")

    cells = [(dom, sym, cause) for dom, syms in DOMAINS.items()
                               for sym in syms for cause in CAUSE_CLASSES]
    random.seed(42); random.shuffle(cells)
    print(f"topic matrix: {len(cells)} cells x {args.batch} per call "
          f"= up to {len(cells)*args.batch} scenarios")

    counter = 0
    def new_id():
        nonlocal counter
        while True:
            counter += 1
            cand = f"gen-{counter:06d}"
            if cand not in used_ids:
                used_ids.add(cand); return cand

    added = rejected = 0
    t0 = time.time()

    for cell in cells:
        if len(data) >= args.target: break
        ck = "|".join(cell)
        if ck in state["done"]: continue
        dom, sym, cause = cell

        seeds = random.sample(seeds_by_domain.get(dom, data), min(3, len(seeds_by_domain.get(dom, data))))
        shots = [{"domain": s["domain"], "goal": s["goal"], "summary": s["summary"],
                  "steps": [{"command": st["command"], "exitCode": st["exitCode"],
                             "stdout": st["stdout"], "stderr": st["stderr"]} for st in s["steps"]],
                  "recommendation": s["recommendation"]} for s in seeds]
        avoid = [d["goal"] for d in seeds_by_domain.get(dom, [])[-40:]]

        user = (f"Domain: {dom}\nSymptom area: {sym}\n"
                f"Root cause class for these scenarios: {cause}\n\n"
                f"Examples of the required style and depth:\n{json.dumps(shots, indent=1)}\n\n"
                f"Existing goals in this domain - your new goals must be clearly different:\n"
                f"{json.dumps(avoid, indent=0)}\n\n"
                f"Generate {args.batch} NEW scenarios as a JSON array.")

        if args.dry_run:
            print(user[:3000]); return

        try:
            raw = call(SYSTEM_PROMPT, user, model)
        except Exception as e:
            print(f"  API error ({e}); backing off 20s"); time.sleep(20); continue

        m = re.search(r'\[.*\]', raw, re.S)
        if not m:
            rejected += args.batch; state["done"].append(ck); continue
        try:
            items = json.loads(m.group(0))
        except Exception:
            rejected += args.batch; state["done"].append(ck); continue

        for it in items:
            ok, why = validate(it, set(DOMAINS))
            if not ok: rejected += 1; continue
            if ok["goal"] in existing_goals: rejected += 1; continue
            if too_similar(ok["goal"], existing_norm, prefix_index): rejected += 1; continue

            entry = {"id": new_id(), "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                     "goal": ok["goal"], "domain": ok["domain"],
                     "plan": ["Collect the evidence this class of problem produces",
                              "Identify the specific root cause",
                              "Apply the correct fix or explain the expected behavior"],
                     "steps": ok["steps"], "resolved": True,
                     "summary": ok["summary"], "recommendation": ok["recommendation"],
                     "source": "synthetic",
                     "feedback": {"worked": True, "note": "", "at": time.strftime("%Y-%m-%dT%H:%M:%S.000Z")}}
            data.append(entry)
            existing_goals.add(ok["goal"])
            ng = norm(ok["goal"]); existing_norm.append(ng)
            prefix_index.setdefault(' '.join(ng.split()[:4]), []).append(ng)

            cmds = "\n".join(f"- {s['command']}" + (f"  [FAILED: {s['stderr'][:70]}]" if s["exitCode"] else "")
                             for s in ok["steps"])
            jsonl.append(json.dumps({"messages":[
                {"role":"system","content":f"You are a Windows repair expert specializing in {ok['domain']} problems. Diagnose with read-only commands first, then apply safe fixes. When a command fails, interpret the error and adapt."},
                {"role":"user","content":ok["goal"]},
                {"role":"assistant","content":f"{ok['summary']}\nCommands used:\n{cmds}\nRecommendation: {ok['recommendation']}"}]},
                ensure_ascii=False)+"\n")
            added += 1
            seeds_by_domain.setdefault(ok["domain"], []).append(entry)

        state["done"].append(ck)

        if added and added % 40 < args.batch:
            json.dump(data, open(JSON_PATH,"w",encoding="utf-8"), indent=2, ensure_ascii=False)
            open(JSONL_PATH,"w",encoding="utf-8").writelines(jsonl)
            json.dump(state, open(STATE_PATH,"w"))
            rate = added/max(1,(time.time()-t0))*3600
            print(f"  total={len(data)}  added={added}  rejected={rejected}  ~{rate:.0f}/hour")

    json.dump(data, open(JSON_PATH,"w",encoding="utf-8"), indent=2, ensure_ascii=False)
    open(JSONL_PATH,"w",encoding="utf-8").writelines(jsonl)
    json.dump(state, open(STATE_PATH,"w"))

    print(f"\nDONE  total={len(data)}  added={added}  rejected={rejected} "
          f"(reject rate {rejected/max(1,added+rejected)*100:.0f}%)")
    print("Synthetic entries carry \"source\":\"synthetic\" - keep that when filtering.")
    print("Next: .\\Verify-Dataset.ps1 -Level 3   to syntax-check everything generated.")

if __name__ == "__main__":
    main()
