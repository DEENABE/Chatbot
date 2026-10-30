using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace ChanakyaCoding {
  // Process lifetime supervision, not filesystem/network isolation. The UI requires explicit local-execution consent.
  public static class ProjectProcessHost {
    [StructLayout(LayoutKind.Sequential)] struct Security { public int Length; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential)] struct Startup {
      public int Size; public IntPtr Reserved, Desktop, Title;
      public int X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
      public short Show, ReservedLength; public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Startup; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
      public long ProcessTime, JobTime; public uint Flags;
      public UIntPtr MinimumWorkingSet, MaximumWorkingSet; public uint ActiveProcesses;
      public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct Limits { public BasicLimits Basic; public Io Io; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob; }
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security security, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string name, uint access, uint share, ref Security security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr data, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string executable, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo process);
    static readonly object OutputLock = new object();
    static IntPtr Job = IntPtr.Zero;
    static volatile bool Stopped;
    static void Check(bool value) { if (!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static void Emit(object value) { lock (OutputLock) Console.WriteLine(new JavaScriptSerializer().Serialize(value)); }
    static string Quote(string value) {
      StringBuilder result = new StringBuilder("\""); int slashes = 0;
      foreach (char c in value) {
        if (c == '\\') { slashes++; continue; }
        if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); }
        else { result.Append('\\', slashes); result.Append(c); }
        slashes = 0;
      }
      result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
    }
    static Thread Drain(IntPtr handle, string channel) {
      Thread thread = new Thread(() => {
        try { using (FileStream stream = new FileStream(new SafeFileHandle(handle, true), FileAccess.Read))
          using (StreamReader reader = new StreamReader(stream, Encoding.UTF8, true, 4096)) {
            char[] chars = new char[4096]; int count;
            while ((count = reader.Read(chars, 0, chars.Length)) > 0) Emit(new { type = channel, text = new string(chars, 0, count) });
          }
        } catch { }
      });
      thread.IsBackground = true; thread.Start(); return thread;
    }
    public static void Run() {
      int exitCode = 1; IntPtr outputRead = IntPtr.Zero, outputWrite = IntPtr.Zero, errorRead = IntPtr.Zero, errorWrite = IntPtr.Zero, input = IntPtr.Zero, environment = IntPtr.Zero, attributes = IntPtr.Zero, handles = IntPtr.Zero;
      ProcessInfo process = new ProcessInfo(); bool attributesReady = false;
      try {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        string line = Console.ReadLine(); if (line == null || line.Length > 1048576) throw new Exception("Invalid process request");
        var request = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(line);
        string executable = Convert.ToString(request["executable"]), cwd = Convert.ToString(request["cwd"]);
        if (!Path.IsPathRooted(executable) || !Path.IsPathRooted(cwd)) throw new Exception("Absolute process identity required");
        StringBuilder command = new StringBuilder(Quote(executable));
        foreach (object arg in (System.Collections.IEnumerable)request["args"]) command.Append(" ").Append(Quote(Convert.ToString(arg)));
        var supplied = (Dictionary<string, object>)request["environment"];
        var entries = new List<string>();
        foreach (var entry in supplied) { string value = Convert.ToString(entry.Value); if (entry.Key.IndexOfAny(new char[] {'=', '\0'}) >= 0 || value.IndexOf('\0') >= 0) throw new Exception("Invalid environment"); entries.Add(entry.Key + "=" + value); }
        entries.Sort(StringComparer.OrdinalIgnoreCase); environment = Marshal.StringToHGlobalUni(String.Join("\0", entries.ToArray()) + "\0\0");
        Job = CreateJobObject(IntPtr.Zero, null); Check(Job != IntPtr.Zero);
        Limits limits = new Limits(); limits.Basic.Flags = 0x2000; IntPtr limitBytes = Marshal.AllocHGlobal(Marshal.SizeOf(limits));
        try { Marshal.StructureToPtr(limits, limitBytes, false); Check(SetInformationJobObject(Job, 9, limitBytes, (uint)Marshal.SizeOf(limits))); } finally { Marshal.FreeHGlobal(limitBytes); }
        Thread control = new Thread(() => { try { while (true) { string action = Console.ReadLine(); if (action == null || action == "stop") break; } } catch { } Stopped = true; if (Job != IntPtr.Zero) TerminateJobObject(Job, 130); }); control.IsBackground = true; control.Start();
        Security security = new Security(); security.Length = Marshal.SizeOf(security); security.Inherit = 1;
        Check(CreatePipe(out outputRead, out outputWrite, ref security, 0)); Check(CreatePipe(out errorRead, out errorWrite, ref security, 0));
        Check(SetHandleInformation(outputRead, 1, 0)); Check(SetHandleInformation(errorRead, 1, 0));
        input = CreateFileW("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero); Check(input != new IntPtr(-1));
        IntPtr attributeSize = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
        attributes = Marshal.AllocHGlobal(attributeSize); Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref attributeSize)); attributesReady = true;
        handles = Marshal.AllocHGlobal(IntPtr.Size * 3); Marshal.WriteIntPtr(handles, 0, input); Marshal.WriteIntPtr(handles, IntPtr.Size, outputWrite); Marshal.WriteIntPtr(handles, IntPtr.Size * 2, errorWrite);
        Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero));
        StartupEx startup = new StartupEx(); startup.Startup.Size = Marshal.SizeOf(startup); startup.Startup.Flags = 0x100; startup.Startup.Input = input; startup.Startup.Output = outputWrite; startup.Startup.Error = errorWrite; startup.Attributes = attributes;
        if (Stopped) throw new Exception("Process cancelled before launch");
        Check(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080404, environment, cwd, ref startup, out process));
        try { Check(AssignProcessToJobObject(Job, process.Process)); if (Stopped) throw new Exception("Process cancelled before launch"); Check(ResumeThread(process.Thread) != 0xffffffff); }
        catch { TerminateProcess(process.Process, 130); throw; }
        CloseHandle(outputWrite); outputWrite = IntPtr.Zero; CloseHandle(errorWrite); errorWrite = IntPtr.Zero;
        Thread stdout = Drain(outputRead, "stdout"); outputRead = IntPtr.Zero; Thread stderr = Drain(errorRead, "stderr"); errorRead = IntPtr.Zero;
        Emit(new { type = "started", pid = process.ProcessId });
        Check(WaitForSingleObject(process.Process, 0xffffffff) == 0); uint code; Check(GetExitCodeProcess(process.Process, out code)); exitCode = unchecked((int)code);
        TerminateJobObject(Job, (uint)exitCode); stdout.Join(3000); stderr.Join(3000);
        Emit(new { type = "exit", exitCode = exitCode });
      } catch (Exception error) { Emit(new { type = "error", message = error.Message }); }
      finally {
        IntPtr job = Job; Job = IntPtr.Zero; if (job != IntPtr.Zero) { TerminateJobObject(job, 130); CloseHandle(job); }
        foreach (IntPtr handle in new IntPtr[] { outputRead, outputWrite, errorRead, errorWrite, input, process.Thread, process.Process }) if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
        if (attributesReady) DeleteProcThreadAttributeList(attributes); if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes); if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles); if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
      }
      Environment.Exit(exitCode);
    }
  }
}
