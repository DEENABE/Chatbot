using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace LocalOS {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DisplayDevice {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceString;
    public uint StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceKey;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DevMode {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string deviceName;
    public ushort specVersion, driverVersion, size, driverExtra;
    public uint fields;
    public int x, y;
    public uint orientation, fixedOutput;
    public short color, duplex, yResolution, ttOption, collate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string formName;
    public ushort logPixels;
    public uint bitsPerPel, width, height, displayFlags, frequency, icmMethod, icmIntent, mediaType, ditherType, reserved1, reserved2, panningWidth, panningHeight;
  }
  public class Mode { public uint width, height, frequency; public int x, y; public Mode(DevMode d) { width=d.width; height=d.height; frequency=d.frequency; x=d.x; y=d.y; } }
  public class Monitor { public string device, name; public bool primary; public Mode current; public List<Mode> modes = new List<Mode>(); }
  [StructLayout(LayoutKind.Sequential)] public struct PowerStatus { public byte acLineStatus, batteryFlag, batteryLifePercent, systemStatusFlag; public uint batteryLifeTime, batteryFullLifeTime; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct AppBarData { public uint size; public IntPtr hwnd; public uint callbackMessage, edge; public Rect rect; public IntPtr param; }

  public static class Desktop {
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool EnumDisplayDevices(string device, uint index, ref DisplayDevice output, uint flags);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool EnumDisplaySettings(string device, int index, ref DevMode mode);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int ChangeDisplaySettingsEx(string device, ref DevMode mode, IntPtr hwnd, uint flags, IntPtr param);
    [DllImport("user32.dll")] static extern int SetDisplayConfig(uint paths, IntPtr pathArray, uint modes, IntPtr modeArray, uint flags);
    [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint paths, out uint modes);
    [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint paths, IntPtr pathArray, ref uint modes, IntPtr modeArray, out uint topology);
    [DllImport("kernel32.dll")] static extern bool GetSystemPowerStatus(out PowerStatus status);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool SystemParametersInfo(uint action, uint param, string value, uint flags);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr wp, string lp, uint flags, uint timeout, out IntPtr result);
    [DllImport("shell32.dll")] static extern UIntPtr SHAppBarMessage(uint message, ref AppBarData data);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindow(string className, string title);
    public static Monitor[] Displays() {
      var result = new List<Monitor>();
      for (uint i=0;i<64;i++) {
        var d=new DisplayDevice(); d.cb=Marshal.SizeOf(d);
        if(!EnumDisplayDevices(null,i,ref d,0)) break;
        if((d.StateFlags & 1)==0) continue;
        var m=new Monitor { device=d.DeviceName, name=d.DeviceString, primary=(d.StateFlags & 4)!=0 };
        var mode=new DevMode(); mode.size=(ushort)Marshal.SizeOf(mode);
        if(EnumDisplaySettings(d.DeviceName,-1,ref mode)) m.current=new Mode(mode);
        var seen=new HashSet<string>();
        for(int j=0;j<2048;j++) {
          mode=new DevMode(); mode.size=(ushort)Marshal.SizeOf(mode);
          if(!EnumDisplaySettings(d.DeviceName,j,ref mode)) break;
          var key=mode.width+"/"+mode.height+"/"+mode.frequency;
          if(mode.bitsPerPel==32 && seen.Add(key)) m.modes.Add(new Mode(mode));
        }
        result.Add(m);
      }
      return result.ToArray();
    }
    public static void SetMode(string device,uint width,uint height,uint frequency) {
      var known=false;
      foreach(var d in Displays()) if(d.device==device) known=true;
      if(!known) throw new ArgumentException("Unknown active display");
      for(int i=0;i<2048;i++) {
        var m=new DevMode(); m.size=(ushort)Marshal.SizeOf(m);
        if(!EnumDisplaySettings(device,i,ref m)) break;
        if(m.width!=width || m.height!=height || m.frequency!=frequency || m.bitsPerPel!=32) continue;
        m.fields=0x40000|0x80000|0x100000|0x400000;
        int code=ChangeDisplaySettingsEx(device,ref m,IntPtr.Zero,2,IntPtr.Zero);
        if(code!=0) throw new InvalidOperationException("Display test failed: "+code);
        code=ChangeDisplaySettingsEx(device,ref m,IntPtr.Zero,1,IntPtr.Zero);
        if(code!=0) throw new InvalidOperationException("Display change failed or needs restart: "+code);
        return;
      }
      throw new ArgumentException("Resolution/refresh rate was not enumerated by this driver");
    }
    public static uint Topology() {
      uint paths,modes,topology;
      int code=GetDisplayConfigBufferSizes(4,out paths,out modes);
      if(code!=0 || paths>128 || modes>512) throw new InvalidOperationException("Display topology unavailable: "+code);
      IntPtr p=Marshal.AllocHGlobal((int)Math.Max(paths,1)*256), m=Marshal.AllocHGlobal((int)Math.Max(modes,1)*256);
      try { code=QueryDisplayConfig(4,ref paths,p,ref modes,m,out topology); if(code!=0) throw new InvalidOperationException("QueryDisplayConfig failed: "+code); return topology; }
      finally { Marshal.FreeHGlobal(p); Marshal.FreeHGlobal(m); }
    }
    public static void SetTopology(uint topology) {
      if(topology!=1 && topology!=2 && topology!=4 && topology!=8) throw new ArgumentException("Invalid topology");
      int code=SetDisplayConfig(0,IntPtr.Zero,0,IntPtr.Zero,0x80|topology);
      if(code!=0) throw new InvalidOperationException("SetDisplayConfig failed: "+code);
    }
    public static PowerStatus Power() { PowerStatus p; if(!GetSystemPowerStatus(out p)) throw new InvalidOperationException("Power status unavailable"); return p; }
    public static void Wallpaper(string path) { if(!SystemParametersInfo(20,0,path,3)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
    public static void NotifyPreferences() { IntPtr output; SendMessageTimeout(new IntPtr(0xffff),0x001A,IntPtr.Zero,"ImmersiveColorSet",2,2000,out output); }
    public static bool AutoHide() { var d=new AppBarData(); d.size=(uint)Marshal.SizeOf(d); d.hwnd=FindWindow("Shell_TrayWnd",null); return (SHAppBarMessage(4,ref d).ToUInt64() & 1)!=0; }
    public static void SetAutoHide(bool enabled) { var d=new AppBarData(); d.size=(uint)Marshal.SizeOf(d); d.hwnd=FindWindow("Shell_TrayWnd",null); if(d.hwnd==IntPtr.Zero) throw new InvalidOperationException("No interactive taskbar"); var current=SHAppBarMessage(4,ref d).ToUInt64(); d.param=new IntPtr((long)(enabled ? current|1UL : current & ~1UL)); SHAppBarMessage(10,ref d); }
  }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int flow,uint mask,out IMMDeviceCollection devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int flow,int role,out IMMDevice device);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id,out IMMDevice device);
    [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr callback);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr callback);
  }
  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int Item(uint index,out IMMDevice device);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid,uint context,IntPtr parameters,[MarshalAs(UnmanagedType.IUnknown)] out object obj);
    [PreserveSig] int OpenPropertyStore(uint access,out IPropertyStore store);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out uint state);
  }
  [StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid format; public uint id; }
  [StructLayout(LayoutKind.Explicit,Size=24)] struct PropVariant { [FieldOffset(0)] public ushort type; [FieldOffset(8)] public IntPtr pointer; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index,out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key,out PropVariant value);
    [PreserveSig] int SetValue(ref PropertyKey key,ref PropVariant value);
    [PreserveSig] int Commit();
  }
  [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioEndpointVolume {
    [PreserveSig] int RegisterControlChangeNotify(IntPtr p);
    [PreserveSig] int UnregisterControlChangeNotify(IntPtr p);
    [PreserveSig] int GetChannelCount(out uint count);
    [PreserveSig] int SetMasterVolumeLevel(float level,ref Guid context);
    [PreserveSig] int SetMasterVolumeLevelScalar(float level,ref Guid context);
    [PreserveSig] int GetMasterVolumeLevel(out float level);
    [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
    [PreserveSig] int SetChannelVolumeLevel(uint channel,float level,ref Guid context);
    [PreserveSig] int SetChannelVolumeLevelScalar(uint channel,float level,ref Guid context);
    [PreserveSig] int GetChannelVolumeLevel(uint channel,out float level);
    [PreserveSig] int GetChannelVolumeLevelScalar(uint channel,out float level);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute,ref Guid context);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }
  public class Endpoint { public string id,name,direction; public bool multimediaDefault; }
  public class AudioState { public List<Endpoint> endpoints=new List<Endpoint>(); public float? percent; public bool? muted; }
  public static class Audio {
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant value);
    static void Check(int hr) { Marshal.ThrowExceptionForHR(hr); }
    static string Id(IMMDevice d) { string id; Check(d.GetId(out id)); return id; }
    static string Name(IMMDevice d) {
      IPropertyStore s; Check(d.OpenPropertyStore(0,out s));
      try { var key=new PropertyKey{format=new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"),id=14}; PropVariant p; Check(s.GetValue(ref key,out p)); try { return p.type==31 ? Marshal.PtrToStringUni(p.pointer) : Id(d); } finally { PropVariantClear(ref p); } }
      finally { Marshal.ReleaseComObject(s); }
    }
    static IAudioEndpointVolume Volume(IMMDeviceEnumerator e) {
      IMMDevice d; Check(e.GetDefaultAudioEndpoint(0,1,out d));
      try { var guid=new Guid("5CDF2C82-841E-4546-9722-0CF74078229A"); object obj; Check(d.Activate(ref guid,23,IntPtr.Zero,out obj)); return (IAudioEndpointVolume)obj; }
      finally { Marshal.ReleaseComObject(d); }
    }
    public static AudioState Inspect() {
      var e=(IMMDeviceEnumerator)new MMDeviceEnumerator(); var result=new AudioState();
      try {
        for(int flow=0;flow<=1;flow++) {
          string defaultId=null; IMMDevice def;
          if(e.GetDefaultAudioEndpoint(flow,1,out def)>=0) { defaultId=Id(def); Marshal.ReleaseComObject(def); }
          IMMDeviceCollection devices; Check(e.EnumAudioEndpoints(flow,1,out devices));
          try { uint count; Check(devices.GetCount(out count)); for(uint i=0;i<count;i++) { IMMDevice d; Check(devices.Item(i,out d)); try { string id=Id(d); result.endpoints.Add(new Endpoint{id=id,name=Name(d),direction=flow==0?"output":"input",multimediaDefault=id==defaultId}); } finally { Marshal.ReleaseComObject(d); } } }
          finally { Marshal.ReleaseComObject(devices); }
        }
        if(result.endpoints.Exists(x=>x.direction=="output" && x.multimediaDefault)) { var volume=Volume(e); try { float level; bool muted; Check(volume.GetMasterVolumeLevelScalar(out level)); Check(volume.GetMute(out muted)); result.percent=level*100; result.muted=muted; } finally { Marshal.ReleaseComObject(volume); } }
        return result;
      } finally { Marshal.ReleaseComObject(e); }
    }
    public static void Set(float? percent,bool? muted) {
      var e=(IMMDeviceEnumerator)new MMDeviceEnumerator();
      try { var volume=Volume(e); try { var context=Guid.Empty; if(percent.HasValue) { if(percent<0 || percent>100) throw new ArgumentException("Volume range"); Check(volume.SetMasterVolumeLevelScalar(percent.Value/100,ref context)); } if(muted.HasValue) Check(volume.SetMute(muted.Value,ref context)); } finally { Marshal.ReleaseComObject(volume); } }
      finally { Marshal.ReleaseComObject(e); }
    }
  }
}
