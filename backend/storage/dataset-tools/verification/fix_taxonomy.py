#!/usr/bin/env python3
"""
fix_taxonomy.py - normalise domain/subdomain values and regenerate
topic-coverage-report.json.

WHY
---
When records come from more than one source, the subdomain field drifts:
  - full sentences land in it ("WI-FI 7 320MHZ CHANNEL WIDTH DESYNCHRONIZED...")
  - case variants split one bucket into many ("DNS" / "dns", "wifi" / "Wi-Fi")
  - some records have null
That produces a coverage report with hundreds of one-record "subdomains",
which is useless for spotting real gaps.

WHAT IT DOES
------------
  1. Rejects malformed subdomains (too long, ALL CAPS sentences, null).
  2. Canonicalises case/spelling variants to a single label.
  3. Re-derives a subdomain from the goal/summary/commands when it is unusable.
  4. Writes the corrected records back (with backup).
  5. Regenerates topic-coverage-report.json with real counts, gap analysis
     and per-domain quality metrics.

USAGE
-----
    python fix_taxonomy.py                 # audit only
    python fix_taxonomy.py --apply         # fix records + write report
"""
import json, re, argparse, collections, shutil, os
from datetime import datetime, timezone

JSON_PATH   = "repair-sessions.json"
JSONL_PATH  = "repair-dataset.jsonl"
REPORT_PATH = "topic-coverage-report.json"

# ---------------------------------------------------------------- canonical map
CANON = {
    'dns':'DNS','dnssec':'DNS','name resolution':'DNS','dns-advanced':'DNS',
    'dhcp':'DHCP','wifi':'Wi-Fi','wi-fi':'Wi-Fi','wlan':'Wi-Fi','wireless':'Wi-Fi',
    'hotspot':'Wi-Fi','captive portal':'Wi-Fi','mobile tethering':'Wi-Fi',
    'ethernet':'Ethernet','nic':'Ethernet','lan':'Ethernet',
    'tcp/ip':'TCP/IP','tcp-ip':'TCP/IP','tcpip':'TCP/IP','ipv6':'TCP/IP','ipv4':'TCP/IP',
    'mtu':'TCP/IP','winsock':'TCP/IP','arp':'TCP/IP','qos':'TCP/IP','reset':'TCP/IP',
    'vpn':'VPN','proxy':'proxy','firewall':'firewall','routing':'routing','smb':'SMB',
    'metered connection':'Wi-Fi',
    'cpu':'CPU','processor':'CPU','ram':'RAM','memory':'RAM','disk':'disk','storage':'disk',
    'gpu':'GPU','graphics':'GPU','thermal':'thermal','startup':'startup','processes':'processes',
    'power management':'power management','power':'power management','battery':'power management',
    'ntfs':'NTFS','usb':'USB','permissions':'permissions','drive letters':'drive letters',
    'disk health':'disk health','filesystem corruption':'filesystem corruption',
    'storage spaces':'Storage Spaces','vhd/vhdx':'VHD/VHDX','vhd':'VHD/VHDX','partitions':'partitions',
    'services':'services','windows update':'Windows Update','task scheduler':'Task Scheduler',
    'registry':'registry','event viewer':'Event Viewer','drivers':'drivers',
    'system configuration':'system configuration','windows features':'Windows features',
    'windows security':'Windows Security','defender':'Defender','account lockout':'account security',
    'account security':'account security','security services':'security services',
    'appx':'AppX/Store','appx/store':'AppX/Store','store':'AppX/Store','bitlocker':'BitLocker',
    'security policy':'security policy','tpm':'BitLocker',
    'pairing':'pairing','bluetooth service':'pairing','pnp devices':'drivers',
    'radio state':'radio state','shell':'shell','group policy':'Group Policy',
    'directory services':'directory services','outlook':'Outlook','excel':'Excel','word':'Word',
    'teams':'Teams','onedrive':'OneDrive','printing':'printing','audio':'audio','display':'display',
    'camera/biometrics':'camera/biometrics','hyper-v':'Hyper-V','wsl':'WSL','containers':'containers',
    'iis':'IIS','sql server':'SQL Server','certificates':'certificates','firmware':'firmware',
    'powershell':'PowerShell','cmd/batch':'CMD/batch','backup/restore':'backup/restore',
    'remote desktop':'Remote Desktop','cloud management':'cloud management',
    'ai/dev tooling':'AI/dev tooling','system':'system configuration',
}

KEYWORD_RULES = [
    (r'\bDNS\b|Resolve-DnsName|nslookup|DNSSEC|SRV record','DNS'),
    (r'DHCP|APIPA|169\.254|lease','DHCP'),
    (r'Wi-?Fi|WLAN|SSID|802\.11|wireless|hotspot|captive','Wi-Fi'),
    (r'Ethernet|LinkSpeed|\bNIC\b|gigabit|jumbo','Ethernet'),
    (r'\bVPN\b|IKEv2|L2TP|SSTP|NAT-T|DirectAccess|IP-HTTPS','VPN'),
    (r'proxy|WinHTTP|WPAD|PAC file','proxy'),
    (r'firewall|MpsSvc|NetFirewall|\bBFE\b|filtering platform','firewall'),
    (r'Winsock|MTU|TCP/IP|netsh int ip|TIME_WAIT|ephemeral port|IPv6','TCP/IP'),
    (r'\broute\b|gateway|metric|subnet|VLAN|\bBGP\b','routing'),
    (r'\bSMB\b|share|LanmanWork|LanmanServer|\bUNC\b|port 445|BranchCache','SMB'),
    (r'Bluetooth|bthserv|pairing|A2DP|Hands-Free','pairing'),
    (r'\bCPU\b|processor|throttl|turbo|core park|interrupt time|\bDPC\b','CPU'),
    (r'\bRAM\b|memory|WorkingSet|pagefile|standby cache|compression','RAM'),
    (r'\bGPU\b|graphics|nvlddmkm|\bTDR\b|VRAM|DirectX|HAGS','GPU'),
    (r'\bdisk\b|SSD|HDD|NVMe|SMART|chkdsk|bad block|storport|latency','disk'),
    (r'startup|boot time|StartupCommand|logon time','startup'),
    (r'power|battery|sleep|hibernat|powercfg|standby|wake','power management'),
    (r'NTFS|\bMFT\b|USN|alternate data stream|junction|hard link','NTFS'),
    (r'\bUSB\b|removable|flash drive|USBSTOR','USB'),
    (r'partition|diskpart|volume|GPT|MBR|EFI','partitions'),
    (r'permission|access denied|ownership|takeown|icacls|\bACL\b','permissions'),
    (r'drive letter|mount point|automount','drive letters'),
    (r'Storage Spaces|storage pool|virtual disk|dedup|tiering','Storage Spaces'),
    (r'VHD|VHDX|vdisk','VHD/VHDX'),
    (r'Windows Update|wuauserv|WSUS|\bKB\d|cumulative|servicing|\bCBS\b|WinSxS','Windows Update'),
    (r'Scheduled Task|ScheduledTask|Task Scheduler','Task Scheduler'),
    (r'registry|HKLM|HKCU|regedit|\bhive\b','registry'),
    (r'Event ID|Get-WinEvent|Event Viewer','Event Viewer'),
    (r'driver|PnpDevice|Code \d\d|pnputil|\.sys\b','drivers'),
    (r'Defender|MpComputerStatus|MpPreference|malware|ransomware|\bASR\b','Defender'),
    (r'BitLocker|manage-bde|recovery key|\bTPM\b','BitLocker'),
    (r'lockout|4740|4625|4771|Kerberos|credential','account security'),
    (r'AppLocker|\bWDAC\b|SmartScreen|Controlled Folder|\bUAC\b|Credential Guard','security policy'),
    (r'Appx|Store|MSIX|winget|Gaming Services','AppX/Store'),
    (r'Explorer|taskbar|Start menu|context menu|shell','shell'),
    (r'Group Policy|\bGPO\b|gpupdate|gpresult|gpsvc','Group Policy'),
    (r'Active Directory|domain|\bSPN\b|FSMO|SYSVOL|LDAP|gMSA|LAPS|Netlogon','directory services'),
    (r'Outlook|\bOST\b|\bPST\b|mailbox|\bOAB\b','Outlook'),
    (r'Excel|workbook|xlsx|Power Query','Excel'),
    (r'\bWord\b|docx|Normal\.dotm|track changes','Word'),
    (r'Teams','Teams'),
    (r'OneDrive|SharePoint','OneDrive'),
    (r'printer|spooler|print job|\bIPP\b','printing'),
    (r'audio|sound|speaker|microphone|AudioSrv|codec','audio'),
    (r'monitor|display|resolution|refresh rate|\bHDR\b|scaling|\bDPI\b','display'),
    (r'camera|webcam|Windows Hello|biometric|fingerprint','camera/biometrics'),
    (r'Hyper-V|virtual switch|checkpoint','Hyper-V'),
    (r'\bWSL\b|ext4\.vhdx|distro','WSL'),
    (r'Docker|container|compose','containers'),
    (r'\bIIS\b|app pool|web\.config|HTTP\.sys','IIS'),
    (r'SQL Server|Invoke-Sqlcmd|tempdb','SQL Server'),
    (r'certificate|\bCRL\b|OCSP|\bPKI\b|Schannel|\bTLS\b','certificates'),
    (r'BIOS|UEFI|firmware|CMOS|Secure Boot','firmware'),
    (r'PowerShell|execution policy|cmdlet|WinRM|PSSession','PowerShell'),
    (r'robocopy|xcopy|errorlevel|cmd\.exe|batch','CMD/batch'),
    (r'backup|restore point|shadow copy|\bVSS\b|File History|wbadmin','backup/restore'),
    (r'\bRDP\b|Remote Desktop|mstsc|rdpclip|Terminal Server','Remote Desktop'),
    (r'Intune|Autopilot|Entra|Azure AD|\bMDM\b','cloud management'),
    (r'CUDA|\bpip\b|python|ollama|virtualenv','AI/dev tooling'),
    (r'\bservice\b|Get-Service|Start-Service|7001|7023|7034','services'),
]

DOMAIN_DEFAULT = {
    'network':'TCP/IP','bluetooth':'pairing','performance':'CPU','file':'NTFS',
    'security':'Windows Security','windows':'system configuration',
}

def is_bad(sub):
    if not sub or not isinstance(sub, str): return True
    s = sub.strip()
    if not s: return True
    if len(s) > 40: return True
    if s.isupper() and len(s) > 12: return True
    if s.endswith('.') or s.count(' ') > 5: return True
    return False

def derive(rec):
    blob = " ".join([rec.get('goal',''), rec.get('summary',''),
                     " ".join(s.get('command','') for s in rec.get('steps',[]))])
    for pat, sub in KEYWORD_RULES:
        if re.search(pat, blob, re.I): return sub
    return DOMAIN_DEFAULT.get(rec.get('domain',''), 'general')

def canon(sub):
    return CANON.get(sub.strip().lower(), sub.strip())

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--json', default=JSON_PATH)
    ap.add_argument('--jsonl', default=JSONL_PATH)
    ap.add_argument('--report', default=REPORT_PATH)
    args = ap.parse_args()

    data = json.load(open(args.json, encoding='utf-8'))
    print(f"loaded {len(data)} records")

    before_subs = collections.Counter(str(r.get('subdomain')) for r in data)
    n_bad = sum(1 for r in data if is_bad(r.get('subdomain')))
    print(f"\n=== BEFORE ===")
    print(f"  distinct subdomains : {len(before_subs)}")
    print(f"  malformed / null    : {n_bad}")
    print(f"  singletons (count 1): {sum(1 for v in before_subs.values() if v==1)}")

    fixed_bad = fixed_case = 0
    for r in data:
        cur = r.get('subdomain')
        if is_bad(cur):
            r['subdomain'] = derive(r); fixed_bad += 1
        else:
            c = canon(cur)
            if c != cur: r['subdomain'] = c; fixed_case += 1

    after_subs = collections.Counter(r['subdomain'] for r in data)
    print(f"\n=== AFTER ===")
    print(f"  re-derived (was malformed) : {fixed_bad}")
    print(f"  canonicalised (case/alias) : {fixed_case}")
    print(f"  distinct subdomains        : {len(after_subs)}")
    print(f"  singletons                 : {sum(1 for v in after_subs.values() if v==1)}")

    # ------------------------------------------------ coverage report
    dom_sub = collections.defaultdict(collections.Counter)
    for r in data:
        dom_sub[r.get('domain','unknown')][r['subdomain']] += 1

    def quality(recs):
        n = len(recs)
        if not n: return {}
        return {
            "records": n,
            "withCommandOutput": sum(1 for r in recs if any((s.get('stdout') or '').strip() for s in r.get('steps',[]))),
            "withFailingStep": sum(1 for r in recs if any(s.get('exitCode',0) for s in r.get('steps',[]))),
            "unresolved": sum(1 for r in recs if not r.get('resolved', True)),
            "avgSteps": round(sum(len(r.get('steps',[])) for r in recs)/n, 2),
            "avgSummaryChars": round(sum(len(r.get('summary','')) for r in recs)/n),
        }

    by_domain = collections.defaultdict(list)
    for r in data: by_domain[r.get('domain','unknown')].append(r)

    thin = sorted([(d, s, c) for d, subs in dom_sub.items() for s, c in subs.items() if c < 3],
                  key=lambda x: x[2])

    report = {
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")[:-3]+"Z",
        "totalRecordsAnalyzed": len(data),
        "taxonomy": {
            "domains": len(dom_sub),
            "subdomains": len(after_subs),
            "malformedFixed": fixed_bad,
            "canonicalised": fixed_case,
        },
        "coverageBreakdown": {d: dict(sorted(subs.items(), key=lambda x: -x[1]))
                              for d, subs in sorted(dom_sub.items(), key=lambda x: -sum(x[1].values()))},
        "qualityByDomain": {d: quality(recs) for d, recs in
                            sorted(by_domain.items(), key=lambda x: -len(x[1]))},
        "overallQuality": quality(data),
        "thinCoverage": [{"domain": d, "subdomain": s, "records": c} for d, s, c in thin[:40]],
        "topSubdomains": [{"subdomain": s, "records": c} for s, c in after_subs.most_common(25)],
    }

    print(f"\n=== COVERAGE ===")
    for d, subs in sorted(dom_sub.items(), key=lambda x: -sum(x[1].values())):
        print(f"  {d:14s} {sum(subs.values()):5d} records across {len(subs):3d} subdomains")
    q = report["overallQuality"]
    print(f"\n=== QUALITY ===")
    print(f"  with command output : {q['withCommandOutput']}/{q['records']} "
          f"({q['withCommandOutput']*100//q['records']}%)")
    print(f"  with failing step   : {q['withFailingStep']}")
    print(f"  unresolved          : {q['unresolved']}")
    print(f"  avg steps / summary : {q['avgSteps']} / {q['avgSummaryChars']} chars")
    print(f"\n  thin coverage (<3 records): {len(thin)} subdomains")

    if not args.apply:
        print("\n(audit only - nothing written. Add --apply.)")
        return

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    for p in (args.json, args.report):
        if os.path.exists(p): shutil.copy2(p, f"{p}.{stamp}.bak")

    json.dump(data, open(args.json,'w',encoding='utf-8'), indent=2, ensure_ascii=False)
    json.dump(report, open(args.report,'w',encoding='utf-8'), indent=2, ensure_ascii=False)

    # rebuild jsonl so the system prompt carries the corrected subdomain
    lines = []
    for r in data:
        cmds = "\n".join(f"- {s['command']}" + (f"  [FAILED: {(s.get('stderr') or '')[:70]}]" if s.get('exitCode') else "")
                         for s in r.get('steps',[]))
        note = "" if r.get('resolved', True) else "\nNOTE: not resolved - see recommendation."
        lines.append(json.dumps({"messages":[
            {"role":"system","content":f"You are a Windows repair expert specializing in {r.get('domain','windows')} ({r['subdomain']}) problems. Diagnose with read-only commands first, then apply safe fixes. When a command fails, interpret the error and adapt."},
            {"role":"user","content":r['goal']},
            {"role":"assistant","content":f"{r['summary']}\nCommands used:\n{cmds}\nRecommendation: {r['recommendation']}{note}"}
        ]}, ensure_ascii=False)+"\n")
    open(args.jsonl,'w',encoding='utf-8').writelines(lines)

    print(f"\nbackups: .{stamp}.bak")
    print(f"wrote {args.json} ({len(data)})")
    print(f"wrote {args.jsonl} ({len(lines)})")
    print(f"wrote {args.report}")

if __name__ == "__main__":
    main()
