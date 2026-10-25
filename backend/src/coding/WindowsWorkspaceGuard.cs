using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace ChanakyaCoding {
  // Fixed data-only filesystem protocol. No project assembly, executable or script is loaded.
  public static class WindowsWorkspaceGuard {
    const uint Read = 0x80000000, Write = 0x40000000, Delete = 0x10000;
    const uint Attributes = 0x80, Traverse = 0x20, OpenExisting = 3, CreateNew = 1;
    const uint OpenReparse = 0x00200000, BackupSemantics = 0x02000000;
    const int MaxBytes = 1048576, MaxEntries = 5000;
    [StructLayout(LayoutKind.Sequential)] struct FileInfo {
      public uint Attributes;
      public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Modified;
      public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInfo info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder name, uint size, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, IntPtr information, uint size);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateDirectoryW(string name, IntPtr security);
    [DllImport("KtmW32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateTransaction(IntPtr security, IntPtr uow, uint options, uint isolation, uint isolationFlags, uint timeout, string description);
    [DllImport("KtmW32.dll", SetLastError=true)] static extern bool CommitTransaction(IntPtr transaction);
    [DllImport("KtmW32.dll", SetLastError=true)] static extern bool RollbackTransaction(IntPtr transaction);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileTransactedW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template, IntPtr transaction, IntPtr miniVersion, IntPtr extended);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFilePointerEx(SafeFileHandle file, long distance, out long position, uint method);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetEndOfFile(SafeFileHandle file);
    static readonly Regex Device = new Regex(@"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", RegexOptions.IgnoreCase);
    static readonly Regex Sensitive = new Regex(@"^(?:\.git|\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.codex|\.agents|\.chanakya-.*|\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|vault(?:\..*)?|id_rsa|id_ed25519)$|\.(?:pem|key|pfx|p12|kdbx)$", RegexOptions.IgnoreCase);
    sealed class Failure : Exception { public string Code; public Failure(string code, string message) : base(message) { Code = code; } }
    static Failure Fail(string code, string message) { return new Failure(code, message); }
    static Failure NativeFailure(string operation) {
      int code = Marshal.GetLastWin32Error();
      if (code == 2 || code == 3) return Fail("FILE_NOT_FOUND", "The workspace file or directory was not found.");
      if (code == 32 || code == 33 || code == 80 || code == 183) return Fail("FILE_CONFLICT", "Another process changed or locked this workspace entry. Inspect it again.");
      return Fail("WORKSPACE_IO_FAILED", operation + " failed (Windows " + code + ").");
    }
    static string Value(IDictionary<string, object> request, string key, string fallback) {
      object value; return request.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : fallback;
    }
    static string Relative(string value, bool empty) {
      if (value == null || value.Length > 2048 || (!empty && value.Length == 0) || Path.IsPathRooted(value) || value.IndexOf(':') >= 0 || Regex.IsMatch(value, @"[\x00-\x1f<>""|?*]"))
        throw Fail("WORKSPACE_PATH_DENIED", "Use a relative path inside the authorized workspace.");
      string normalized = value.Replace('/', '\\');
      if (normalized.Length == 0) return normalized;
      foreach (string part in normalized.Split('\\')) {
        if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(".") || part.EndsWith(" ") || Device.IsMatch(part))
          throw Fail("WORKSPACE_PATH_DENIED", "Path aliases, traversal and Windows device names are blocked.");
        if (Sensitive.IsMatch(part)) throw Fail("PROTECTED_FILE", "Credential and application-control files are protected.");
      }
      return normalized;
    }
    static string Root(string value) {
      if (String.IsNullOrEmpty(value) || value.Length > 2048 || !Regex.IsMatch(value, @"^[A-Za-z]:\\") || value.StartsWith(@"\\") || value.Substring(2).IndexOf(':') >= 0)
        throw Fail("WORKSPACE_PATH_DENIED", "Choose an authorized local project directory.");
      string root = Path.GetFullPath(value).TrimEnd('\\');
      if (root.Length <= 3 || Regex.IsMatch(root, @"^[a-z]:\\(?:windows|program files(?: \(x86\))?|programdata|\$recycle\.bin|system volume information)(?:\\|$)", RegexOptions.IgnoreCase))
        throw Fail("WORKSPACE_PATH_DENIED", "System directories and volume roots are not coding workspaces.");
      Relative(root.Substring(3), false);
      return root;
    }
    static FileInfo InspectHandle(SafeFileHandle handle, string expected, bool directory) {
      FileInfo info;
      if (!GetFileInformationByHandle(handle, out info)) throw NativeFailure("Handle inspection");
      if ((info.Attributes & 0x400) != 0 || (!directory && info.Links != 1))
        throw Fail("WORKSPACE_PATH_DENIED", "Reparse points, junctions, symbolic links and hard links are blocked.");
      if (((info.Attributes & 0x10) != 0) != directory) throw Fail("INVALID_FILE_TYPE", "The workspace entry has the wrong type.");
      StringBuilder actual = new StringBuilder(4096);
      uint length = GetFinalPathNameByHandleW(handle, actual, (uint)actual.Capacity, 0);
      if (length == 0 || length >= actual.Capacity) throw Fail("WORKSPACE_PATH_DENIED", "The native file identity could not be verified.");
      string real = actual.ToString();
      if (real.StartsWith(@"\\?\")) real = real.Substring(4);
      if (!String.Equals(real.TrimEnd('\\'), expected.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
        throw Fail("WORKSPACE_PATH_DENIED", "This entry resolves through a path alias or outside its authorized identity.");
      return info;
    }
    sealed class Scope : IDisposable {
      public readonly string RootPath;
      public readonly List<string> CreatedDirectories = new List<string>();
      readonly List<SafeFileHandle> directories = new List<SafeFileHandle>();
      readonly HashSet<string> locked = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      readonly List<string> protectedRoots = new List<string>();
      public Scope(string root, IEnumerable protectedValues) {
        RootPath = Root(root);
        if (protectedValues != null) foreach (object value in protectedValues) protectedRoots.Add(Path.GetFullPath(Convert.ToString(value)).TrimEnd('\\'));
        Check(RootPath);
        string current = Path.GetPathRoot(RootPath);
        try {
          Lock(current);
          foreach (string part in RootPath.Substring(current.Length).Split('\\')) { current = Path.Combine(current, part); Lock(current); }
        } catch { Dispose(); throw; }
      }
      public void Check(string target) {
        foreach (string protectedRoot in protectedRoots)
          if (target.Equals(protectedRoot, StringComparison.OrdinalIgnoreCase) || target.StartsWith(protectedRoot + "\\", StringComparison.OrdinalIgnoreCase))
            throw Fail("PROTECTED_FILE", "The application's runtime, approval and checkpoint storage is protected.");
      }
      public void Lock(string directory) {
        if (locked.Contains(directory)) return;
        // Share read/write but never delete: ancestors cannot become junctions or be renamed.
        SafeFileHandle handle = CreateFileW(directory, Attributes | Traverse, 3, IntPtr.Zero, OpenExisting, OpenReparse | BackupSemantics, IntPtr.Zero);
        if (handle.IsInvalid) { handle.Dispose(); throw NativeFailure("Directory locking"); }
        try { InspectHandle(handle, directory, true); directories.Add(handle); locked.Add(directory); }
        catch { handle.Dispose(); throw; }
      }
      public string PathFor(string relative, bool directory, bool createParents) {
        string normalized = Relative(relative, directory);
        Check(Path.Combine(RootPath, normalized));
        string current = RootPath;
        string[] parts = normalized.Length == 0 ? new string[0] : normalized.Split('\\');
        int count = directory ? parts.Length : parts.Length - 1;
        for (int index = 0; index < count; index++) {
          current = Path.Combine(current, parts[index]);
          if (createParents) {
            if (CreateDirectoryW(current, IntPtr.Zero)) CreatedDirectories.Add(current.Substring(RootPath.Length + 1).Replace('\\', '/'));
            else if (Marshal.GetLastWin32Error() != 183) throw NativeFailure("Directory creation");
          }
          Lock(current);
        }
        return directory || parts.Length == 0 ? current : Path.Combine(current, parts[parts.Length - 1]);
      }
      public void Dispose() { for (int index = directories.Count - 1; index >= 0; index--) directories[index].Dispose(); directories.Clear(); }
    }
    static SafeFileHandle OpenFile(string file, uint access, uint creation) {
      SafeFileHandle handle = CreateFileW(file, access, 1, IntPtr.Zero, creation, OpenReparse, IntPtr.Zero);
      if (handle.IsInvalid) { handle.Dispose(); throw NativeFailure("File opening"); }
      try { InspectHandle(handle, file, false); return handle; } catch { handle.Dispose(); throw; }
    }
    static byte[] ReadBytes(SafeFileHandle handle, string file) {
      FileInfo info = InspectHandle(handle, file, false);
      if (info.SizeHigh != 0 || info.SizeLow > MaxBytes) throw Fail("FILE_TOO_LARGE", "Read a smaller source file (maximum 1 MiB).");
      // FileStream owns this handle; duplicate disposal of SafeFileHandle is harmless.
      using (FileStream stream = new FileStream(handle, FileAccess.Read)) {
        byte[] bytes = new byte[checked((int)info.SizeLow)]; int offset = 0;
        while (offset < bytes.Length) { int count = stream.Read(bytes, offset, bytes.Length - offset); if (count == 0) break; offset += count; }
        if (offset != bytes.Length) throw Fail("FILE_CONFLICT", "The file changed while it was read.");
        return bytes;
      }
    }
    static byte[] ReadLocked(SafeFileHandle handle, string file) {
      FileInfo info = InspectHandle(handle, file, false);
      if (info.SizeHigh != 0 || info.SizeLow > MaxBytes) throw Fail("FILE_TOO_LARGE", "Source files are limited to 1 MiB.");
      // Do not close the caller's lock before mutation. ReadFile operates on its existing native handle.
      byte[] bytes = new byte[checked((int)info.SizeLow)];
      uint read;
      if (bytes.Length > 0 && (!ReadFile(handle, bytes, (uint)bytes.Length, out read, IntPtr.Zero) || read != bytes.Length)) throw NativeFailure("Locked file read");
      return bytes;
    }
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(SafeFileHandle handle, byte[] buffer, uint length, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(SafeFileHandle handle, byte[] buffer, uint length, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle handle);
    static string Hash(byte[] bytes) { using (SHA256 sha = SHA256.Create()) { return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); } }
    static void DisposeFile(SafeFileHandle file) {
      IntPtr flag = Marshal.AllocHGlobal(1);
      try { Marshal.WriteByte(flag, 1); if (!SetFileInformationByHandle(file, 4, flag, 1)) throw NativeFailure("Guarded file deletion"); }
      finally { Marshal.FreeHGlobal(flag); }
    }
    static object ReadSource(Scope scope, string relative) {
      string file = scope.PathFor(relative, false, false);
      byte[] bytes; using (SafeFileHandle handle = OpenFile(file, Read, OpenExisting)) bytes = ReadBytes(handle, file);
      return new { path = relative.Replace('\\', '/'), contentBase64 = Convert.ToBase64String(bytes), version = Hash(bytes), size = bytes.Length };
    }
    static object WriteSource(Scope scope, IDictionary<string, object> request) {
      string relative = Value(request, "path", ""), file = scope.PathFor(relative, false, false), expected = Value(request, "expectedVersion", "");
      if (expected != "new" && !Regex.IsMatch(expected, "^[a-f0-9]{64}$")) throw Fail("FILE_VERSION_REQUIRED", "Inspect the file before writing and include its exact version, or use new for creation.");
      byte[] bytes = new UTF8Encoding(false, true).GetBytes(Value(request, "content", ""));
      if (bytes.Length > MaxBytes) throw Fail("FILE_TOO_LARGE", "Source writes are limited to 1 MiB.");
      return ReplaceSource(file, relative, bytes, expected);
    }
    static object ReplaceSource(string file, string relative, byte[] bytes, string expected) {
      // NTFS transactions retain the file lock and make the entire data change atomic.
      // No check-close-reopen window, and no ordinary write fallback on unsupported volumes.
      IntPtr transaction = CreateTransaction(IntPtr.Zero, IntPtr.Zero, 0, 0, 0, 30000, "Chanakya guarded source edit");
      if (transaction == IntPtr.Zero || transaction == new IntPtr(-1)) throw Fail("ISOLATION_UNAVAILABLE", "Windows transactional file isolation is unavailable.");
      bool committed = false;
      try {
        byte[] before = null;
        using (SafeFileHandle handle = CreateFileTransactedW(file, Read | Write, 1, IntPtr.Zero, expected == "new" ? CreateNew : OpenExisting, OpenReparse, IntPtr.Zero, transaction, IntPtr.Zero, IntPtr.Zero)) {
          if (handle.IsInvalid) {
            int code = Marshal.GetLastWin32Error();
            if (code == 1 || code == 50 || code == 87 || code == 6805 || code == 6837)
              throw Fail("ISOLATION_UNAVAILABLE", "This volume does not support guarded atomic edits. No unsafe fallback is used.");
            throw NativeFailure("Transactional file opening");
          }
          InspectHandle(handle, file, false);
          if (expected != "new") {
            before = ReadLocked(handle, file);
            if (Hash(before) != expected) throw Fail("FILE_CONFLICT", "The file changed after inspection. Read it again before applying this change.");
          }
          long position; uint written;
          if (!SetFilePointerEx(handle, 0, out position, 0)) throw NativeFailure("Transactional seek");
          if (bytes.Length > 0 && (!WriteFile(handle, bytes, (uint)bytes.Length, out written, IntPtr.Zero) || written != bytes.Length)) throw NativeFailure("Transactional source write");
          if (!SetEndOfFile(handle) || !FlushFileBuffers(handle)) throw NativeFailure("Transactional file flush");
        }
        if (!CommitTransaction(transaction)) throw NativeFailure("Atomic source commit");
        committed = true;
        return new { path = relative.Replace('\\', '/'), beforeVersion = expected, version = Hash(bytes), beforeContentBase64 = before == null ? null : Convert.ToBase64String(before), changed = before == null || Hash(before) != Hash(bytes), size = bytes.Length };
      } finally { if (!committed) RollbackTransaction(transaction); CloseHandle(transaction); }
    }
    static object RemoveSource(Scope scope, IDictionary<string, object> request) {
      string relative = Value(request, "path", ""), file = scope.PathFor(relative, false, false), expected = Value(request, "expectedVersion", "");
      if (!Regex.IsMatch(expected, "^[a-f0-9]{64}$")) throw Fail("FILE_VERSION_REQUIRED", "File deletion requires the exact inspected version.");
      using (SafeFileHandle handle = OpenFile(file, Read | Delete, OpenExisting)) {
        byte[] bytes = ReadLocked(handle, file);
        if (Hash(bytes) != expected) throw Fail("FILE_CONFLICT", "The file changed after inspection; deletion was refused.");
        DisposeFile(handle);
        return new { path = relative.Replace('\\', '/'), beforeVersion = expected, version = "new", beforeContentBase64 = Convert.ToBase64String(bytes), changed = true, deleted = true };
      }
    }
    static object RemoveDirectory(Scope scope, IDictionary<string, object> request) {
      string relative = Value(request, "path", ""), directory = scope.PathFor(relative, false, false);
      using (SafeFileHandle handle = CreateFileW(directory, Attributes | Delete, 3, IntPtr.Zero, OpenExisting, OpenReparse | BackupSemantics, IntPtr.Zero)) {
        if (handle.IsInvalid) throw NativeFailure("Directory opening");
        InspectHandle(handle, directory, true);
        if (Directory.GetFileSystemEntries(directory).Length != 0) throw Fail("DIRECTORY_NOT_EMPTY", "Only empty directories created by the coding agent can be removed during rollback.");
        DisposeFile(handle); return new { path = relative.Replace('\\', '/'), deleted = true, changed = true };
      }
    }
    static object ListSource(Scope scope, IDictionary<string, object> request) {
      string relative = Value(request, "path", ""), directory = scope.PathFor(relative, true, false);
      bool recursive = Value(request, "recursive", "False").Equals("True", StringComparison.OrdinalIgnoreCase);
      int max = MaxEntries; object option; if (request.TryGetValue("maxEntries", out option)) max = Math.Min(MaxEntries, Math.Max(1, Convert.ToInt32(option)));
      List<object> entries = new List<object>(), errors = new List<object>(); bool truncated = false;
      Action<string, int> walk = null;
      walk = (current, depth) => {
        if (depth > 32) { truncated = true; return; }
        scope.Lock(current);
        string[] children = Directory.GetFileSystemEntries(current); Array.Sort(children, StringComparer.OrdinalIgnoreCase);
        foreach (string child in children) {
          if (entries.Count >= max) { truncated = true; return; }
          string local = child.Substring(scope.RootPath.Length + 1).Replace('\\', '/');
          try {
            Relative(local, false);
            scope.Check(child);
            FileAttributes attributes = File.GetAttributes(child);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw Fail("WORKSPACE_PATH_DENIED", "Link entries were skipped.");
            bool isDirectory = (attributes & FileAttributes.Directory) != 0;
            using (SafeFileHandle handle = CreateFileW(child, Attributes, 3, IntPtr.Zero, OpenExisting, OpenReparse | (isDirectory ? BackupSemantics : 0), IntPtr.Zero)) {
              if (handle.IsInvalid) throw NativeFailure("Entry inspection");
              FileInfo info = InspectHandle(handle, child, isDirectory);
              entries.Add(new { path = local, name = Path.GetFileName(child), type = isDirectory ? "directory" : "file", size = isDirectory ? 0L : ((long)info.SizeHigh << 32) | info.SizeLow });
              if (recursive && isDirectory) walk(child, depth + 1);
            }
          } catch (Failure failure) { errors.Add(new { path = local, code = failure.Code, message = failure.Message }); }
        }
      };
      walk(directory, 0); return new { path = relative.Replace('\\', '/'), entries = entries, errors = errors, truncated = truncated };
    }
    public static string Run(string json) {
      JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = 4194304, RecursionLimit = 64 };
      try {
        IDictionary<string, object> request = serializer.Deserialize<Dictionary<string, object>>(json);
        object protectedValues; request.TryGetValue("protectedRoots", out protectedValues);
        using (Scope scope = new Scope(Value(request, "root", ""), protectedValues as IEnumerable)) {
          string operation = Value(request, "operation", ""); object result;
          switch (operation) {
            case "inspect": result = new { root = scope.RootPath, platform = "windows", nativeGuard = true, atomicCreation = "NTFS_transaction", atomicReplacement = "NTFS_transaction", available = true }; break;
            case "list": result = ListSource(scope, request); break;
            case "read": result = ReadSource(scope, Value(request, "path", "")); break;
            case "mkdir": {
              string directory = scope.PathFor(Value(request, "path", ""), true, true);
              result = new { path = Value(request, "path", "").Replace('\\', '/'), directory = directory, createdDirectories = scope.CreatedDirectories, changed = scope.CreatedDirectories.Count > 0 }; break;
            }
            case "write": result = WriteSource(scope, request); break;
            case "remove": result = RemoveSource(scope, request); break;
            case "remove-empty-directory": result = RemoveDirectory(scope, request); break;
            default: throw Fail("UNKNOWN_TOOL", "Unsupported guarded filesystem operation.");
          }
          return serializer.Serialize(new { success = true, data = result });
        }
      } catch (Failure failure) { return serializer.Serialize(new { success = false, error = new { code = failure.Code, message = failure.Message } }); }
        catch (Exception) { return serializer.Serialize(new { success = false, error = new { code = "WORKSPACE_IO_FAILED", message = "The guarded filesystem operation failed. Inspect the entry and try again." } }); }
    }
  }
}
