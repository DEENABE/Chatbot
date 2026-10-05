param([Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9._-]+![A-Za-z0-9._-]+$')][string]$AppId)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationActivationManager {
  [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string id, [MarshalAs(UnmanagedType.LPWStr)] string args, uint options, out uint pid);
  [PreserveSig] int ActivateForFile(IntPtr a, IntPtr b, IntPtr c, out uint pid);
  [PreserveSig] int ActivateForProtocol(IntPtr a, IntPtr b, out uint pid);
}
public static class PackagedApp {
 [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern int GetApplicationUserModelId(IntPtr p,ref uint length,StringBuilder text);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr p);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 public static long Foreground(){return GetForegroundWindow().ToInt64();}
 public static string Identity(int pid){var p=OpenProcess(0x1000,false,pid);if(p==IntPtr.Zero)return "";try{uint n=0;GetApplicationUserModelId(p,ref n,null);if(n==0||n>1024)return "";var text=new StringBuilder((int)n);return GetApplicationUserModelId(p,ref n,text)==0?text.ToString():"";}finally{CloseHandle(p);}}

 public static uint Open(string id) {
  var type=Type.GetTypeFromCLSID(new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C"));
  var manager=(IApplicationActivationManager)Activator.CreateInstance(type);
  try { uint pid; Marshal.ThrowExceptionForHR(manager.ActivateApplication(id,null,0,out pid)); return pid; }
  finally { Marshal.ReleaseComObject(manager); }
 }
}
'@
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
# Remember which windows of this app already exist, so a multi-window app (Notepad, browsers...) reports the window this
# activation actually created instead of an older one.
$known=@{}
foreach($w in [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)){try{if([PackagedApp]::Identity($w.Current.ProcessId) -ceq $AppId){$known[[long]$w.Current.NativeWindowHandle]=$true}}catch{}}
$appProcessId=[PackagedApp]::Open($AppId)
$startedAt=[DateTime]::UtcNow
$fallback=$null
$stable=[long]0
$deadline=[DateTime]::UtcNow.AddSeconds(8)
$window=$null
$condition=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty,[int]$appProcessId)
do {
 # The activation PID may already have exited (e.g. Notepad hands off to another process): match by AUMID instead.
 $p=Get-Process -Id $appProcessId -ErrorAction SilentlyContinue
 $windows=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)
 foreach($w in $windows){
  try {
   if($w.Current.IsOffscreen -or $w.Current.NativeWindowHandle -eq 0){continue}
   $mine=$w.Current.ProcessId -eq $appProcessId -or [PackagedApp]::Identity($w.Current.ProcessId) -ceq $AppId
   if($mine){
    $isNew=-not $known.ContainsKey([long]$w.Current.NativeWindowHandle)
    $isForeground=$w.Current.NativeWindowHandle -eq [PackagedApp]::Foreground()
    # A window that did not exist before is the one we opened; an existing one is accepted only when it came to the
    # front (single-instance apps reuse their window) or when no new window appears within two seconds.
    if($isNew -or ($isForeground -and ([DateTime]::UtcNow-$startedAt).TotalMilliseconds -gt 800)){
     # Some apps create a short-lived window first. Only accept a handle seen on two consecutive polls.
     $handle=[long]$w.Current.NativeWindowHandle
     if($stable -eq $handle){$window=$w;$p=Get-Process -Id $w.Current.ProcessId;break}
     $stable=$handle;continue
    }
    if(!$fallback){$fallback=$w}
    continue
   }
   $child=$w.FindFirst([Windows.Automation.TreeScope]::Children,$condition)
   if($child){$window=$w;break}
  }catch{}
 }
 if(!$window -and $fallback -and ([DateTime]::UtcNow-$startedAt).TotalMilliseconds -gt 2000){$window=$fallback;$p=Get-Process -Id $fallback.Current.ProcessId -ErrorAction SilentlyContinue}
 if(!$window){Start-Sleep -Milliseconds 200}
}while(!$window -and [DateTime]::UtcNow -lt $deadline)
if(!$window){throw 'APP_WINDOW_UNVERIFIED'}
if(!$p){$p=Get-Process -Id $window.Current.ProcessId -ErrorAction Stop}
@{pid=$p.Id;appUserModelId=$AppId;windowId=$window.Current.NativeWindowHandle;observedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress
