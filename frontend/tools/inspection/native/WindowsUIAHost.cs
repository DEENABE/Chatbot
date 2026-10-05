using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

// READ ONLY. No input APIs, focus changes, or pattern execution are present.
public static class WindowsUIAHost {
 public sealed class Target {public string applicationName,windowHandle,executablePath,appUserModelId,packageFamilyName;public int processId;}
 public sealed class Options {public int maxDepth=12,maxElements=1000,timeoutMs=5000;public bool debug=false;}
 public sealed class Request {public string id;public Target target;public Options options;}
 public sealed class Bounds {public double x,y,width,height;}
 public sealed class Node {public string id,parentId,windowHandle,name,controlType,automationId,className;public bool enabled,offscreen,focusable,hasKeyboardFocus,isPassword,valueRedacted,isModal;public int depth;public int[] runtimeId;public Bounds bounds;public string[] patterns;public List<Node> children=new List<Node>();}
 public sealed class WindowInfo {public string windowHandle,ownerHandle,title,type;public int processId;public bool foreground,modal,toolWindow;public Node root;}
 public sealed class Result {public string id,provider="WindowsUIA",error,windowHandle,activeWindowHandle,capturedAt,dpiAwareness;public int processId,helperProcessId,rawElementCount,skippedElementCount;public bool success,truncated,regionsInaccessible;public long elapsedMs;public List<WindowInfo> windows=new List<WindowInfo>();}
 delegate bool EnumWindow(IntPtr hwnd,IntPtr data);
 [DllImport("user32.dll")]static extern bool IsWindow(IntPtr hwnd);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")]static extern bool IsWindowEnabled(IntPtr hwnd);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll")]static extern IntPtr GetWindow(IntPtr hwnd,uint command);
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]static extern bool EnumThreadWindows(uint thread,EnumWindow callback,IntPtr data);
 [DllImport("user32.dll")]static extern bool EnumChildWindows(IntPtr parent,EnumWindow callback,IntPtr data);
 [DllImport("user32.dll",EntryPoint="GetWindowLongW")]static extern int GetWindowLong(IntPtr hwnd,int index);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr hwnd,StringBuilder text,int length);
 [DllImport("user32.dll")]static extern bool SetProcessDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")]static extern IntPtr GetThreadDpiAwarenessContext();
 [DllImport("user32.dll")]static extern bool AreDpiAwarenessContextsEqual(IntPtr a,IntPtr b);
 [DllImport("kernel32.dll")]static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern int GetPackageFamilyName(IntPtr process,ref uint size,StringBuilder name);
 static readonly AutomationProperty[] Properties={AutomationElement.NameProperty,AutomationElement.ControlTypeProperty,AutomationElement.AutomationIdProperty,AutomationElement.ClassNameProperty,AutomationElement.IsEnabledProperty,AutomationElement.IsOffscreenProperty,AutomationElement.IsKeyboardFocusableProperty,AutomationElement.HasKeyboardFocusProperty,AutomationElement.BoundingRectangleProperty,AutomationElement.IsPasswordProperty,AutomationElement.ProcessIdProperty,AutomationElement.RuntimeIdProperty,WindowPattern.IsModalProperty};
 static readonly AutomationProperty[] Availability={AutomationElement.IsInvokePatternAvailableProperty,AutomationElement.IsValuePatternAvailableProperty,AutomationElement.IsSelectionPatternAvailableProperty,AutomationElement.IsSelectionItemPatternAvailableProperty,AutomationElement.IsExpandCollapsePatternAvailableProperty,AutomationElement.IsTogglePatternAvailableProperty,AutomationElement.IsRangeValuePatternAvailableProperty,AutomationElement.IsScrollPatternAvailableProperty,AutomationElement.IsTextPatternAvailableProperty};
 static readonly string[] PatternNames={"Invoke","Value","Selection","SelectionItem","ExpandCollapse","Toggle","RangeValue","Scroll","Text"};
 static string Clip(string value){return String.IsNullOrEmpty(value)?"":value.Substring(0,Math.Min(300,value.Length));}
 static string Handle(IntPtr value){return value.ToInt64().ToString(CultureInfo.InvariantCulture);}
 static string Package(int pid){var p=OpenProcess(0x1000,false,pid);if(p==IntPtr.Zero)return "";try{uint size=0;GetPackageFamilyName(p,ref size,null);if(size==0||size>2048)return "";var text=new StringBuilder((int)size);return GetPackageFamilyName(p,ref size,text)==0?text.ToString():"";}finally{CloseHandle(p);}}
 static int Pid(IntPtr hwnd){uint pid;GetWindowThreadProcessId(hwnd,out pid);return (int)pid;}
 static void Deadline(Stopwatch clock,int timeout){if(clock.ElapsedMilliseconds>=timeout)throw new TimeoutException();}
 static string ProcessPath(int pid){try{using(var p=Process.GetProcessById(pid))return p.MainModule.FileName;}catch(System.ComponentModel.Win32Exception){throw new UnauthorizedAccessException();}catch(ArgumentException){throw new Exception("TARGET_PROCESS_NOT_FOUND");}}
 static HashSet<int> ProcessTree(Target target,Stopwatch clock,Options opts,Result result){
  var found=new HashSet<int>{target.processId};var queue=new Queue<int>();queue.Enqueue(target.processId);
  while(queue.Count>0&&found.Count<64){Deadline(clock,opts.timeoutMs);int parent=queue.Dequeue();
   try{using(var query=new ManagementObjectSearcher("SELECT ProcessId,CreationDate FROM Win32_Process WHERE ParentProcessId="+parent)){
    query.Options.Timeout=TimeSpan.FromMilliseconds(Math.Max(1,opts.timeoutMs-clock.ElapsedMilliseconds));
    using(var rows=query.Get())foreach(ManagementObject row in rows){using(row){int pid=Convert.ToInt32(row["ProcessId"]);if(found.Count>=64){result.truncated=true;break;}
     // Reject a stale parent-PID link following PID reuse.
     try{if(ManagementDateTimeConverter.ToDateTime((string)row["CreationDate"])<Process.GetProcessById(parent).StartTime)continue;}catch{continue;}
     if(found.Add(pid))queue.Enqueue(pid);
    }}
   }}catch(ManagementException){result.regionsInaccessible=true;}
  }if(queue.Count>0)result.truncated=true;return found;
 }
 static bool HostedTarget(IntPtr hwnd,Target target){
  if(!String.Equals(ProcessPath(Pid(hwnd)),Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"System32","ApplicationFrameHost.exe"),StringComparison.OrdinalIgnoreCase))return false;
  var package=Package(target.processId);if(String.IsNullOrEmpty(package))return false;
  if(!String.IsNullOrEmpty(target.packageFamilyName)&&package!=target.packageFamilyName)return false;
  if(!String.IsNullOrEmpty(target.appUserModelId)&&!target.appUserModelId.StartsWith(package+"!",StringComparison.Ordinal))return false;
  bool matched=false;int count=0;
  EnumChildWindows(hwnd,delegate(IntPtr child,IntPtr unused){if(++count>256)return false;if(Package(Pid(child))==package){matched=true;return false;}return true;},IntPtr.Zero);return matched;
 }
 static bool OwnedBy(IntPtr hwnd,IntPtr main){var seen=new HashSet<long>();for(int i=0;i<32&&hwnd!=IntPtr.Zero;i++){if(hwnd==main)return true;if(!seen.Add(hwnd.ToInt64()))return false;hwnd=GetWindow(hwnd,4);}return false;}
 static CacheRequest Cache(){var cache=new CacheRequest{TreeScope=TreeScope.Subtree,AutomationElementMode=AutomationElementMode.Full,TreeFilter=new PropertyCondition(AutomationElement.IsControlElementProperty,true)};foreach(var p in Properties)cache.Add(p);foreach(var p in Availability)cache.Add(p);return cache;}
 static T Cached<T>(AutomationElement element,AutomationProperty property,T fallback){try{var v=element.GetCachedPropertyValue(property,true);return v is T?(T)v:fallback;}catch{return fallback;}}
 static Node ReadNode(AutomationElement element,Node parent,int depth,string window,Result result){
  string type=Cached<ControlType>(element,AutomationElement.ControlTypeProperty,ControlType.Custom).ProgrammaticName.Replace("ControlType.","");bool password=Cached<bool>(element,AutomationElement.IsPasswordProperty,false);
  // Edit/Document Name may itself contain document content. Suppress it at source.
  bool redact=password||type=="Edit"||type=="Document";
  var node=new Node{id="raw-"+(++result.rawElementCount),parentId=parent==null?null:parent.id,depth=depth,windowHandle=window,controlType=type,
   name=redact?"":Clip(Cached<string>(element,AutomationElement.NameProperty,"")),automationId=password?"":Clip(Cached<string>(element,AutomationElement.AutomationIdProperty,"")),className=Clip(Cached<string>(element,AutomationElement.ClassNameProperty,"")),
   enabled=Cached<bool>(element,AutomationElement.IsEnabledProperty,false),offscreen=Cached<bool>(element,AutomationElement.IsOffscreenProperty,true),focusable=Cached<bool>(element,AutomationElement.IsKeyboardFocusableProperty,false),hasKeyboardFocus=Cached<bool>(element,AutomationElement.HasKeyboardFocusProperty,false),isPassword=password,valueRedacted=redact,isModal=Cached<bool>(element,WindowPattern.IsModalProperty,false),runtimeId=Cached<int[]>(element,AutomationElement.RuntimeIdProperty,null)};
  var rect=Cached<System.Windows.Rect>(element,AutomationElement.BoundingRectangleProperty,System.Windows.Rect.Empty);node.bounds=new Bounds{x=rect.IsEmpty?0:rect.X,y=rect.IsEmpty?0:rect.Y,width=rect.IsEmpty?0:rect.Width,height=rect.IsEmpty?0:rect.Height};
  var patterns=new List<string>();for(int i=0;i<Availability.Length;i++)if(Cached<bool>(element,Availability[i],false))patterns.Add(PatternNames[i]);node.patterns=patterns.ToArray();return node;
 }
 static void InspectWindow(IntPtr hwnd,WindowInfo info,Result result,Stopwatch clock,Options opts){
  var cache=Cache();AutomationElement root;
  using(cache.Activate()){root=AutomationElement.FromHandle(hwnd);root=root.GetUpdatedCache(cache);}
  // Revalidate after the provider call: HWNDs may be destroyed and reused.
  if(!IsWindow(hwnd)||Pid(hwnd)!=info.processId||Cached<int>(root,AutomationElement.ProcessIdProperty,-1)!=info.processId)throw new UnauthorizedAccessException();
  info.root=ReadNode(root,null,0,info.windowHandle,result);info.title=info.root.name;info.modal=info.root.isModal||info.ownerHandle!="0"&& !IsWindowEnabled(new IntPtr(Int64.Parse(info.ownerHandle)));
  if(info.modal)info.type="Dialog";
  var queue=new Queue<Tuple<AutomationElement,Node>>();queue.Enqueue(Tuple.Create(root,info.root));
  while(queue.Count>0){Deadline(clock,opts.timeoutMs);var entry=queue.Dequeue();AutomationElementCollection children;
   try{children=entry.Item1.CachedChildren;}catch{result.skippedElementCount++;result.regionsInaccessible=true;continue;}
   if(entry.Item2.isPassword)continue;
   if(entry.Item2.depth>=opts.maxDepth){if(children.Count>0)result.truncated=true;continue;}
   foreach(AutomationElement child in children){Deadline(clock,opts.timeoutMs);if(result.rawElementCount>=opts.maxElements){result.truncated=true;return;}
    try{var updated=child;var node=ReadNode(updated,entry.Item2,entry.Item2.depth+1,info.windowHandle,result);entry.Item2.children.Add(node);queue.Enqueue(Tuple.Create(updated,node));}
    catch(ElementNotAvailableException){result.skippedElementCount++;result.regionsInaccessible=true;}catch(UnauthorizedAccessException){result.skippedElementCount++;result.regionsInaccessible=true;}catch(InvalidOperationException){result.skippedElementCount++;result.regionsInaccessible=true;}
   }
  }
 }
 static Result Inspect(Request request){
  var result=new Result{id=request.id,capturedAt=DateTime.UtcNow.ToString("o"),helperProcessId=Process.GetCurrentProcess().Id};var clock=Stopwatch.StartNew();var opts=request.options??new Options();
  try{
   if(request.target==null||opts.maxDepth<0||opts.maxDepth>32||opts.maxElements<1||opts.maxElements>5000||opts.timeoutMs<100||opts.timeoutMs>30000)throw new Exception("UIA_CONNECTION_FAILED");
   var target=request.target;long value;if(!Int64.TryParse(target.windowHandle,NumberStyles.None,CultureInfo.InvariantCulture,out value)||value<=0)throw new Exception("TARGET_WINDOW_NOT_FOUND");
   var main=new IntPtr(value);if(!IsWindow(main))throw new Exception("TARGET_WINDOW_NOT_FOUND");
   var executable=ProcessPath(target.processId);if(!String.Equals(Path.GetFullPath(executable),Path.GetFullPath(target.executablePath),StringComparison.OrdinalIgnoreCase))throw new UnauthorizedAccessException();
   var tree=ProcessTree(target,clock,opts,result);if(!tree.Contains(Pid(main))&&!HostedTarget(main,target))throw new UnauthorizedAccessException();
   result.windowHandle=Handle(main);result.processId=target.processId;
   try{result.dpiAwareness=AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(),new IntPtr(-4))?"PerMonitorV2":"PerMonitor";}catch{result.dpiAwareness="manifest";}
   var foreground=GetForegroundWindow();var windows=new HashSet<IntPtr>{main};
   foreach(int pid in tree){Deadline(clock,opts.timeoutMs);try{using(var process=Process.GetProcessById(pid))foreach(ProcessThread thread in process.Threads){Deadline(clock,opts.timeoutMs);EnumThreadWindows((uint)thread.Id,delegate(IntPtr candidate,IntPtr unused){if(!IsWindowVisible(candidate)||!tree.Contains(Pid(candidate)))return true;var cls=new StringBuilder(128);GetClassName(candidate,cls,128);bool popup=cls.ToString()=="#32768";bool tool=(GetWindowLong(candidate,-20)&0x80)!=0;if(OwnedBy(candidate,main)||popup||tool)windows.Add(candidate);return windows.Count<64;},IntPtr.Zero);}}catch(ArgumentException){result.regionsInaccessible=true;}}
   var ordered=windows.OrderByDescending(h=>h==foreground).ThenByDescending(h=>h!=main).ToArray();
   foreach(var hwnd in ordered){Deadline(clock,opts.timeoutMs);if(result.rawElementCount>=opts.maxElements){result.truncated=true;break;}
    if(!IsWindow(hwnd)){result.skippedElementCount++;result.regionsInaccessible=true;continue;}
    if(!tree.Contains(Pid(hwnd))&&!(hwnd==main&&HostedTarget(hwnd,target)))throw new UnauthorizedAccessException();
    var cls=new StringBuilder(128);GetClassName(hwnd,cls,128);var owner=GetWindow(hwnd,4);var info=new WindowInfo{windowHandle=Handle(hwnd),ownerHandle=Handle(owner),processId=Pid(hwnd),foreground=hwnd==foreground,type=cls.ToString()=="#32768"?"Popup":"Window",toolWindow=(GetWindowLong(hwnd,-20)&0x80)!=0};
    try{InspectWindow(hwnd,info,result,clock,opts);result.windows.Add(info);}catch(ElementNotAvailableException){result.skippedElementCount++;result.regionsInaccessible=true;}
    if(result.activeWindowHandle==null||info.foreground)result.activeWindowHandle=info.windowHandle;
   }
   result.success=result.rawElementCount>0;if(!result.success)result.error="UIA_TREE_EMPTY";
  }catch(TimeoutException){result.truncated=true;result.error="UIA_INSPECTION_TIMEOUT";}catch(UnauthorizedAccessException){result.error="UIA_ACCESS_DENIED";}catch(Exception error){var known=new[]{"TARGET_PROCESS_NOT_FOUND","TARGET_WINDOW_NOT_FOUND","UIA_CONNECTION_FAILED","UIA_TREE_EMPTY"};result.error=known.Contains(error.Message)?error.Message:"UIA_CONNECTION_FAILED";}
  result.elapsedMs=clock.ElapsedMilliseconds;return result;
 }
 [MTAThread]public static void Main(){
  Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);try{SetProcessDpiAwarenessContext(new IntPtr(-4));}catch{}
  var json=new JavaScriptSerializer{MaxJsonLength=8*1024*1024,RecursionLimit=128};string line;
  while((line=Console.ReadLine())!=null){Request request=null;try{if(line.Length>16384)throw new Exception();request=json.Deserialize<Request>(line);}catch{Console.WriteLine(json.Serialize(new Result{error="UIA_CONNECTION_FAILED"}));continue;}
   Result response=null;var worker=new Thread(()=>response=Inspect(request));worker.IsBackground=true;worker.SetApartmentState(ApartmentState.MTA);worker.Start();int timeout=request.options==null?5000:Math.Max(100,Math.Min(30000,request.options.timeoutMs));
   // A UIA provider can block inside native COM. Stop this host rather than reuse
   // a hung worker or allow an unbounded backlog. Node restarts on the next read.
   if(!worker.Join(timeout)){Console.WriteLine(json.Serialize(new Result{id=request.id,error="UIA_INSPECTION_TIMEOUT",truncated=true,elapsedMs=timeout,helperProcessId=Process.GetCurrentProcess().Id}));Console.Out.Flush();Environment.Exit(2);}
   Console.WriteLine(json.Serialize(response));Console.Out.Flush();
  }
 }
}

