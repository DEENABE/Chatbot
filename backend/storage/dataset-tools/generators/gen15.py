import json, collections
from datetime import datetime, timedelta

JSON_PATH = "repair-sessions.json"
JSONL_PATH = "repair-dataset.jsonl"

NEW = [
("diskpart","diskpart 'clean' refuses to run -- 'DiskPart has encountered an error: Access is denied'",
 "diskpart requires a fully elevated token; the console was launched from a standard shell, so every disk-modifying command is rejected while read-only commands like list disk still work.",
 [("diskpart",0,"Microsoft DiskPart version 10.0.26100",""),
  ("DISKPART> list disk",0,"Disk 0  Online  476 GB\nDisk 1  Online   58 GB",""),
  ("DISKPART> select disk 1",0,"Disk 1 is now the selected disk.",""),
  ("DISKPART> clean",1,"","DiskPart has encountered an error: Access is denied.")],
 "Close diskpart, launch Command Prompt or Terminal as Administrator, then re-run; diskpart never prompts for elevation itself, so it fails at the first write operation instead of at launch."),
("diskpart","Using 'clean' on the wrong disk -- how to confirm the target before any destructive command",
 "The disk numbers shifted after a reboot, so the intended external drive was no longer Disk 2. Confirming size, model and volume letters through detail disk prevented wiping the internal drive.",
 [("DISKPART> list disk",0,"Disk 0  Online  476 GB  *\nDisk 1  Online  931 GB\nDisk 2  Online   58 GB",""),
  ("DISKPART> select disk 1",0,"Disk 1 is now the selected disk.",""),
  ("DISKPART> detail disk",0,"WDC WD10EZEX-08WN4A0\nType: SATA\nVolume 3  D  Data  NTFS  Partition  931 GB  Healthy","")],
 "Always run 'detail disk' after selecting and match the model/size/volume letter to what you expect -- disk numbers are assignment order, not identity, and they change between boots and hotplugs."),
("diskpart","Difference between 'clean' and 'clean all' when repurposing a drive",
 "'clean' only removes partition/volume metadata, leaving all data recoverable; 'clean all' zeroes every sector, which is why it took hours on a 2 TB disk while clean returned instantly.",
 [("DISKPART> select disk 2",0,"Disk 2 is now the selected disk.",""),
  ("DISKPART> clean",0,"DiskPart succeeded in cleaning the disk.",""),
  ("DISKPART> clean all",0,"(runs for several hours on large disks; writes zeros to every sector)","")],
 "Use 'clean' for reuse within your own environment, 'clean all' before disposal or transfer of ownership; note 'clean all' on SSDs is unnecessary wear -- a secure-erase/ATA sanitize via the vendor tool is better."),
("diskpart","Cannot delete a recovery or EFI partition -- 'Cannot delete a protected partition without the force protected parameter'",
 "OEM/EFI/recovery partitions carry a protection flag, so plain delete is refused; the override parameter is required and exists specifically to make the destructive intent explicit.",
 [("DISKPART> select partition 3",0,"Partition 3 is now the selected partition.",""),
  ("DISKPART> delete partition",1,"","Cannot delete a protected partition without the force protected parameter set."),
  ("DISKPART> delete partition override",0,"DiskPart successfully deleted the selected partition.","")],
 "Before using override, confirm WinRE isn't hosted there ('reagentc /info') -- deleting an in-use recovery partition silently breaks Reset/Advanced Startup until WinRE is re-registered elsewhere."),
("diskpart","Disk is read-only in diskpart -- writes fail until the attribute is cleared",
 "The disk carries the read-only attribute (set by a previous operation or a policy), so partition changes and formats are rejected even from an elevated diskpart session.",
 [("DISKPART> select disk 2",0,"Disk 2 is now the selected disk.",""),
  ("DISKPART> attributes disk",0,"Current Read-only State : Yes\nRead-only  : Yes",""),
  ("DISKPART> attributes disk clear readonly",0,"Disk attributes cleared successfully.","")],
 "Clear the attribute at the disk level, and if a single volume is still read-only clear it separately with 'attributes volume clear readonly'; check for a physical write-protect switch on SD cards and USB sticks first."),
("diskpart","Assigning a drive letter with diskpart after a volume mounts without one",
 "The volume is healthy but has no mount point, so it's invisible in Explorer; assigning a letter through diskpart makes it accessible without touching the data.",
 [("DISKPART> list volume",0,"Volume 4     NTFS   Partition   931 GB  Healthy  (no letter)",""),
  ("DISKPART> select volume 4",0,"Volume 4 is the selected volume.",""),
  ("DISKPART> assign letter=E",0,"DiskPart successfully assigned the drive letter or mount point.","")],
 "If the letter is already taken, 'assign letter=' with a free letter or remove it from the other volume first; letters persist per-volume in the mount manager database, so this survives reboots."),
("diskpart","Removing a drive letter to hide a volume without deleting it",
 "The volume needs to stay mounted for a service but hidden from users; removing the letter leaves the file system intact and reachable via its volume GUID path.",
 [("DISKPART> select volume 5",0,"Volume 5 is the selected volume.",""),
  ("DISKPART> remove letter=F",0,"DiskPart successfully removed the drive letter or mount point.",""),
  ("mountvol",0,"\\\\?\\Volume{a1b2c3...}\\  *** NO MOUNT POINTS ***","")],
 "Record the volume GUID from 'mountvol' before removing the letter so scripts and services can still address it; removing a letter does not unmount or affect data in any way."),
("diskpart","Setting the system partition Active on an MBR disk that won't boot",
 "The active flag was lost during partition work, so BIOS had no partition marked bootable; marking the correct small system partition active restored the handoff to the boot manager.",
 [("DISKPART> select disk 0",0,"Disk 0 is now the selected disk.",""),
  ("DISKPART> list partition",0,"Partition 1  Primary  100 MB (System Reserved)\nPartition 2  Primary  475 GB",""),
  ("DISKPART> select partition 1",0,"Partition 1 is now the selected partition.",""),
  ("DISKPART> active",0,"DiskPart marked the current partition as active.","")],
 "Mark the small System Reserved partition active, not the Windows partition; 'active' applies to MBR only -- on GPT/UEFI systems the equivalent is having a correctly typed EFI System Partition."),
("diskpart","Rebuilding the EFI System Partition with diskpart after it was deleted",
 "The EFI partition was removed, so UEFI firmware had nothing to boot; recreating it with the correct type and formatting FAT32 gave bcdboot a valid target to populate.",
 [("DISKPART> select disk 0",0,"Disk 0 is now the selected disk.",""),
  ("DISKPART> create partition efi size=260",0,"DiskPart succeeded in creating the specified partition.",""),
  ("DISKPART> format quick fs=fat32 label=System",0,"DiskPart successfully formatted the volume.",""),
  ("DISKPART> assign letter=S",0,"DiskPart successfully assigned the drive letter or mount point.",""),
  ("bcdboot C:\\Windows /s S: /f UEFI",0,"Boot files successfully created.","")],
 "The EFI partition must be FAT32 and at least ~100 MB (260 MB is the modern recommendation for 4Kn compatibility); after bcdboot, remove the temporary letter with 'remove letter=S'."),
("diskpart","Converting a disk to GPT with diskpart -- 'The specified disk is not convertible' error",
 "diskpart's convert command requires an empty disk; existing partitions block it, which is why the error appears even though the disk is otherwise healthy.",
 [("DISKPART> select disk 2",0,"Disk 2 is now the selected disk.",""),
  ("DISKPART> convert gpt",1,"","The specified disk is not convertible. CDROMs and DVDs are examples of non-convertible disks."),
  ("DISKPART> list partition",0,"Partition 1  Primary  931 GB","")],
 "Either back up and 'clean' the disk first then convert, or use MBR2GPT for an in-place conversion that preserves data on the OS disk; diskpart's convert is destructive by requirement."),
("diskpart","Automount is disabled so new volumes never get drive letters automatically",
 "Automount was turned off (common on servers and after imaging work), so every newly attached volume mounts without a letter until assigned manually.",
 [("DISKPART> automount",0,"Automatic mounting of new volumes disabled.",""),
  ("DISKPART> automount enable",0,"Automatic mounting of new volumes enabled.",""),
  ("DISKPART> automount scrub",0,"DiskPart successfully scrubbed the mount point settings.","')")],
 "Re-enable automount, then run 'automount scrub' to clear stale mount-point entries for volumes that no longer exist -- those stale entries are what block letters from being reused."),
("diskpart","'list disk' shows no disks at all inside WinRE",
 "The recovery environment lacks the storage controller driver for this machine's NVMe/RAID mode, so no disks enumerate; the hardware is fine, the WinRE image simply can't see it.",
 [("DISKPART> list disk",0,"There are no fixed disks to show.",""),
  ("wpeutil InitializeNetwork",0,"",""),
  ("drvload X:\\drivers\\iaStorVD.inf",0,"Driver loaded successfully.",""),
  ("DISKPART> rescan",0,"DiskPart has finished scanning your configuration and mounted volumes.","")],
 "Load the vendor's storage driver in WinRE with drvload then rescan, or switch the BIOS from RAID/VMD to AHCI if the OS was installed that way; installation media with the driver slipstreamed avoids this entirely."),
("diskpart","Extending a partition in diskpart fails -- 'There is not enough usable space for this operation'",
 "Extend requires unallocated space immediately after the selected partition; the free space sits before it, so diskpart correctly reports it as unusable for this operation.",
 [("DISKPART> select volume 2",0,"Volume 2 is the selected volume.",""),
  ("DISKPART> extend",1,"","There is not enough usable space for this operation."),
  ("DISKPART> list partition",0,"Partition 1  Primary  200 GB (unallocated space follows partition 3, not 2)","")],
 "Move or remove the partition sitting between the volume and the free space (a third-party tool can relocate it), or extend a different volume that is adjacent; diskpart cannot move partitions."),
("diskpart","Finding the maximum shrink size before running shrink",
 "Querying the maximum first showed only a fraction of the free space is reclaimable, explaining why shrink appeared to 'ignore' the free space -- immovable files cap the reclaimable region.",
 [("DISKPART> select volume 2",0,"Volume 2 is the selected volume.",""),
  ("DISKPART> shrink querymax",0,"The maximum number of reclaimable bytes is:  38 GB",""),
  ("DISKPART> shrink desired=30000",0,"DiskPart successfully shrunk the volume by: 29 GB","")],
 "Always run 'shrink querymax' first; to raise the ceiling, disable hibernation, move the page file, and delete shadow copies, then re-query before shrinking."),
("diskpart","Changing a partition type ID so Windows stops treating a data partition as recovery",
 "The partition carries the recovery type GUID from a previous OEM layout, so Windows hides it and refuses normal operations; resetting the type ID to basic data made it behave like a normal volume.",
 [("DISKPART> select partition 4",0,"Partition 4 is now the selected partition.",""),
  ("DISKPART> detail partition",0,"Type    : de94bba4-06d1-4d40-a16a-bfd50179d6ac (Windows Recovery)\nHidden  : Yes",""),
  ("DISKPART> set id=ebd0a0a2-b9e5-4433-87c0-68b6b72699c7",0,"DiskPart successfully set the partition ID.",""),
  ("DISKPART> gpt attributes=0x0000000000000000",0,"DiskPart successfully assigned the attributes to the selected GPT partition.","")],
 "Clear both the type ID and the GPT hidden/required attributes -- changing only the ID leaves it hidden; verify with 'detail partition' before assigning a drive letter."),
("diskpart","Two cloned disks conflict -- changing a disk signature with diskpart",
 "Both disks carry the same MBR signature after cloning, so Windows keeps the second offline to avoid a collision; assigning a new unique ID resolves the conflict non-destructively.",
 [("DISKPART> select disk 1",0,"Disk 1 is now the selected disk.",""),
  ("DISKPART> uniqueid disk",0,"Disk ID: A1B2C3D4",""),
  ("DISKPART> uniqueid disk id=B5C6D7E8",0,"DiskPart successfully set the disk ID.",""),
  ("DISKPART> online disk",0,"DiskPart successfully onlined the selected disk.","")],
 "Changing the signature is safe for data but breaks BitLocker bindings and boot entries referencing that disk -- if the clone is meant to boot, fix the BCD afterwards with bcdboot."),
("diskpart","Bringing a disk online and clearing read-only in one pass on a server",
 "The disk arrived offline and read-only under the Offline Shared SAN policy, so both the offline state and the read-only attribute had to be cleared before the volume was usable.",
 [("DISKPART> select disk 3",0,"Disk 3 is now the selected disk.",""),
  ("DISKPART> attributes disk clear readonly",0,"Disk attributes cleared successfully.",""),
  ("DISKPART> online disk",0,"DiskPart successfully onlined the selected disk.",""),
  ("DISKPART> san",0,"SAN Policy  : Offline Shared","")],
 "On clustered/SAN-attached servers leave the SAN policy at Offline Shared -- bringing shared LUNs online automatically on multiple nodes risks file-system corruption."),
("diskpart","Creating a partition layout for a fresh UEFI Windows install manually",
 "Setup couldn't create partitions automatically on this preconfigured disk, so the standard UEFI layout (EFI, MSR, Windows) was created by hand before applying the image.",
 [("DISKPART> select disk 0",0,"Disk 0 is now the selected disk.",""),
  ("DISKPART> clean",0,"DiskPart succeeded in cleaning the disk.",""),
  ("DISKPART> convert gpt",0,"DiskPart successfully converted the selected disk to GPT format.",""),
  ("DISKPART> create partition efi size=260",0,"DiskPart succeeded in creating the specified partition.",""),
  ("DISKPART> format quick fs=fat32 label=System",0,"DiskPart successfully formatted the volume.",""),
  ("DISKPART> create partition msr size=16",0,"DiskPart succeeded in creating the specified partition.",""),
  ("DISKPART> create partition primary",0,"DiskPart succeeded in creating the specified partition.",""),
  ("DISKPART> format quick fs=ntfs label=Windows",0,"DiskPart successfully formatted the volume.","")],
 "Keep this order (EFI, MSR, Windows) and leave the MSR unformatted with no letter; the recovery partition is normally created last, after Windows is applied."),
("diskpart","Attaching and expanding a VHDX from diskpart for a virtual machine",
 "The virtual disk needed more space, so it was expanded at the container level with diskpart, then the guest volume had to be extended separately -- expanding the VHDX alone doesn't grow the file system.",
 [("DISKPART> select vdisk file=\"D:\\VMs\\data.vhdx\"",0,"DiskPart successfully selected the virtual disk file.",""),
  ("DISKPART> detail vdisk",0,"Virtual size: 100 GB\nPhysical size: 62 GB\nState: Added",""),
  ("DISKPART> expand vdisk maximum=204800",0,"DiskPart successfully expanded the virtual disk file.",""),
  ("DISKPART> attach vdisk",0,"DiskPart successfully attached the virtual disk file.","")],
 "Ensure no VM has the VHDX in use before expanding, and remember to extend the volume inside the guest afterwards; use 'compact vdisk' on a detached, zeroed dynamic disk to reclaim space instead."),
("diskpart","Reactivating a foreign/invalid dynamic disk with diskpart",
 "The dynamic disk was moved from another machine so its LDM database is marked foreign; importing/reactivating rebuilt the configuration without touching the volume data.",
 [("DISKPART> list disk",0,"Disk 2  Foreign  931 GB",""),
  ("DISKPART> select disk 2",0,"Disk 2 is now the selected disk.",""),
  ("DISKPART> import",0,"DiskPart successfully imported the foreign disk.",""),
  ("DISKPART> list volume",0,"Volume 5  E  Data  NTFS  Simple  931 GB  Healthy","")],
 "Import all members of a spanned/striped set together or the volume stays incomplete; if the disk shows 'Online (Errors)', use 'select disk' then 'online disk' followed by a volume-level 'recover'."),
("diskpart","Formatting a large drive as NTFS with a specific allocation unit size",
 "The default cluster size wasn't suitable for the workload (many very large files), so the volume was formatted with a larger allocation unit to reduce metadata overhead.",
 [("DISKPART> select volume 6",0,"Volume 6 is the selected volume.",""),
  ("DISKPART> format fs=ntfs unit=64k quick label=Media",0,"DiskPart successfully formatted the volume.",""),
  ("fsutil fsinfo ntfsinfo E:",0,"Bytes Per Cluster : 65536","")],
 "64K clusters suit large sequential files but waste space with many small files, and NTFS compression is unavailable above 4K clusters -- match the unit size to the actual workload."),
("diskpart","Volume shows RAW in diskpart -- deciding between format and recovery",
 "diskpart reports the file system as RAW, meaning the file-system metadata is unreadable; the data may still be present, so formatting would destroy the only recovery opportunity.",
 [("DISKPART> list volume",0,"Volume 4  F  (no label)  RAW  Partition  1863 GB  Healthy",""),
  ("DISKPART> select volume 4",0,"Volume 4 is the selected volume.",""),
  ("DISKPART> detail partition",0,"Type: ebd0a0a2-... (Basic data)  Offset: 1048576","")],
 "Do not format. Image the volume first, then run read-only recovery tooling against the image; only format if the data is confirmed expendable or already recovered."),
("diskpart","Using diskpart from a script non-interactively",
 "Interactive diskpart can't be automated reliably, so the commands were placed in a script file and piped in -- which also creates an auditable record of exactly what ran.",
 [("Set-Content C:\\Scripts\\prep.txt \"select disk 2`r`nclean`r`nconvert gpt`r`ncreate partition primary`r`nformat quick fs=ntfs label=Data`r`nassign letter=E\"",0,"",""),
  ("diskpart /s C:\\Scripts\\prep.txt",0,"DiskPart successfully assigned the drive letter or mount point.","")],
 "Always hard-code a verified disk number and log the output ('diskpart /s prep.txt > log.txt'); better still, use the Storage PowerShell cmdlets (Clear-Disk, New-Partition) which support -WhatIf and error handling."),
("diskpart","PowerShell equivalents for common diskpart operations",
 "The Storage module covers the same operations with proper error handling and pipeline support, which makes automation safer than piping text into diskpart.",
 [("Get-Disk | Select-Object Number, FriendlyName, PartitionStyle, OperationalStatus",0,"2  Samsung T7  GPT  Online",""),
  ("Clear-Disk -Number 2 -RemoveData -Confirm:$false",0,"",""),
  ("Initialize-Disk -Number 2 -PartitionStyle GPT",0,"",""),
  ("New-Partition -DiskNumber 2 -UseMaximumSize -DriveLetter E | Format-Volume -FileSystem NTFS -NewFileSystemLabel Data -Confirm:$false",0,"DriveLetter E  FileSystemLabel Data  FileSystem NTFS","")],
 "Prefer these cmdlets for scripting -- they support -WhatIf, return objects you can validate, and fail with catchable exceptions rather than text that has to be parsed."),
("diskpart","Checking whether a disk is GPT or MBR before planning an install",
 "The asterisk in the Gpt column of 'list disk' is the quickest indicator, confirmed with detail disk -- this determines whether the machine can boot UEFI or must use legacy BIOS.",
 [("DISKPART> list disk",0,"  Disk ###  Status   Size     Free     Dyn  Gpt\n  Disk 0    Online   476 GB   0 B           *",""),
  ("Get-Disk 0 | Select-Object PartitionStyle",0,"PartitionStyle : GPT","")],
 "GPT requires UEFI boot mode, MBR requires Legacy/CSM -- a mismatch between the disk layout and the firmware mode is the most common cause of 'no bootable device' after an install."),
("diskpart","Deleting a volume from a USB drive that Explorer's format won't touch",
 "Explorer's format refused because the drive holds a non-Windows partition layout from a bootable Linux image; diskpart's clean removes it regardless of layout.",
 [("DISKPART> list disk",0,"Disk 3  Online  29 GB  (USB)",""),
  ("DISKPART> select disk 3",0,"Disk 3 is now the selected disk.",""),
  ("DISKPART> clean",0,"DiskPart succeeded in cleaning the disk.",""),
  ("DISKPART> create partition primary",0,"DiskPart succeeded in creating the specified partition.",""),
  ("DISKPART> format quick fs=fat32 label=USB",0,"DiskPart successfully formatted the volume.","")],
 "Triple-check the disk number for USB operations -- 'clean' is instant and irreversible, and USB disk numbers shift depending on plug order."),
("diskpart","Disk shows the correct size in BIOS but only 2 TB in Windows",
 "The disk is initialized as MBR, which cannot address beyond 2 TB, so the remainder appears as unallocated and unusable -- a partition-scheme limit, not a hardware or driver problem.",
 [("DISKPART> list disk",0,"Disk 1  Online  3726 GB  1863 GB free   (Gpt column blank = MBR)",""),
  ("Get-Disk 1 | Select-Object PartitionStyle, Size",0,"PartitionStyle : MBR  Size : 4000787030016","")],
 "Back up the data, then convert to GPT (diskpart 'clean' + 'convert gpt' for data disks, or MBR2GPT for an OS disk); MBR's 2 TB ceiling cannot be worked around by any tool."),
]

with open(JSON_PATH, encoding="utf-8") as f:
    data = json.load(f)
with open(JSONL_PATH, encoding="utf-8") as f:
    jsonl_lines = [l for l in f if l.strip()]

existing_ids = set(d["id"] for d in data)
existing_goals = set(d["goal"] for d in data)
prefix_index = collections.defaultdict(list)
for g in existing_goals:
    prefix_index[' '.join(g.lower().split()[:4])].append(g)

n = 1
def next_id():
    global n
    while True:
        cand = f"new-win-repair-{n:03d}"
        n += 1
        if cand not in existing_ids:
            existing_ids.add(cand); return cand

skipped, near = [], []
base_time = datetime(2026, 8, 4, 9, 0, 0)
i = 0
for domain, goal, summary, commands, recommendation in NEW:
    if goal in existing_goals:
        skipped.append(goal); continue
    key = ' '.join(goal.lower().split()[:4])
    if key in prefix_index: near.append((goal, prefix_index[key][0]))
    created = base_time + timedelta(minutes=5 * i); i += 1
    steps = [{"command": c, "blocked": False, "exitCode": ec, "stdout": o, "stderr": e, "reason": None} for c, ec, o, e in commands]
    data.append({
        "id": next_id(), "createdAt": created.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "goal": goal, "domain": domain,
        "plan": ["Identify the correct target disk/volume before any change",
                 "Run the read-only diskpart queries that confirm the situation",
                 "Apply the minimal command that fixes it, avoiding destructive shortcuts"],
        "steps": steps, "resolved": True, "summary": summary, "recommendation": recommendation,
        "feedback": {"worked": True, "note": "", "at": (created + timedelta(minutes=3)).strftime("%Y-%m-%dT%H:%M:%S.000Z")}})
    existing_goals.add(goal); prefix_index[key].append(goal)
    cmd_lines = "\n".join(f"- {c[0]}" + ("  [FAILED: " + c[3][:70] + "]" if c[1] != 0 else "") for c in commands)
    chat = {"messages": [
        {"role": "system", "content": f"You are a Windows repair expert specializing in {domain} problems. Diagnose with read-only commands first, then apply safe fixes. When a command fails, interpret the error and adapt."},
        {"role": "user", "content": goal},
        {"role": "assistant", "content": f"{summary}\nCommands used:\n{cmd_lines}\nRecommendation: {recommendation}"}]}
    jsonl_lines.append(json.dumps(chat, ensure_ascii=False) + "\n")

with open(JSON_PATH, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2, ensure_ascii=False); f.write("\n")
with open(JSONL_PATH, "w", encoding="utf-8") as f:
    f.writelines(jsonl_lines)

print("Added:", i, "| exact dups skipped:", len(skipped), "| near-dup collisions:", len(near))
for a,b in near: print("   NEAR:", a[:65], "<>", b[:65])
print("Total JSON:", len(data), "| Total JSONL:", len(jsonl_lines))
