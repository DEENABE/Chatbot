using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Automation;
using System.Windows.Automation.Text;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using Accessibility;

// App-neutral Windows accessibility backend. All targets are re-read under the
// caller's desktop mutex immediately before mutation. No shell or model keys.
public static class DesktopAccessibility {
 [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 public static void Initialize(){SetProcessDpiAwarenessContext(new IntPtr(-4));SetThreadDpiAwarenessContext(new IntPtr(-4));}
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 // Some accessibility providers activate a child HWND. Bind foreground and
 // dialog tracking to its top-level root, retaining the exact process checks.
 static IntPtr ForegroundRoot(){var current=GetForegroundWindow();return current==IntPtr.Zero?current:GetAncestor(current,2);}
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h,uint message,ref int start,ref int end);
 [DllImport("user32.dll",EntryPoint="SendMessageW",CharSet=CharSet.Unicode)] static extern IntPtr ControlMessage(IntPtr h,uint message,IntPtr first,IntPtr second);
 [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",SetLastError=true)] static extern bool AttachThreadInput(uint from,uint to,bool attach);
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 // Prefer the application's accessibility provider. The Win32 fallback shares
 // BOTH the current foreground and target queues temporarily; attaching only
 // to the foreground queue can still leave the target unable to take focus.
 static bool Focus(IntPtr h){
  for(int attempt=0;attempt<6;attempt++){
   if(ForegroundRoot()==h)return true;
   if(IsIconic(h)){ShowWindowAsync(h,9);System.Threading.Thread.Sleep(80);}
   try{AutomationElement.FromHandle(h).SetFocus();}catch{}
   if(ForegroundRoot()==h)return true;
   uint pid;uint foregroundThread=GetWindowThreadProcessId(ForegroundRoot(),out pid),targetThread=GetWindowThreadProcessId(h,out pid),self=GetCurrentThreadId();bool foregroundAttached=false,targetAttached=false;
   try{
    if(foregroundThread!=0&&foregroundThread!=self)foregroundAttached=AttachThreadInput(self,foregroundThread,true);
    if(targetThread!=0&&targetThread!=self&&targetThread!=foregroundThread)targetAttached=AttachThreadInput(self,targetThread,true);
    BringWindowToTop(h);SetForegroundWindow(h);
    if(Environment.GetEnvironmentVariable("CHANAKYA_DEBUG_UI")=="1"&&ForegroundRoot()!=h)Console.Error.WriteLine("FOCUS attempt="+attempt+" window="+h.ToInt64()+" foreground="+ForegroundRoot().ToInt64()+" threads="+self+"/"+foregroundThread+"/"+targetThread+" attached="+foregroundAttached+"/"+targetAttached+" error="+Marshal.GetLastWin32Error());
   }finally{
    if(targetAttached)AttachThreadInput(self,targetThread,false);
    if(foregroundAttached)AttachThreadInput(self,foregroundThread,false);
   }
   System.Threading.Thread.Sleep(60);
  }
  return ForegroundRoot()==h;
 }
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h,int n);
 [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h,int n);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
 delegate bool WindowVisitor(IntPtr h,IntPtr value);
 [DllImport("user32.dll")] static extern bool EnumWindows(WindowVisitor visitor,IntPtr value);
 [StructLayout(LayoutKind.Sequential)] struct GUIINFO {public uint size,flags;public IntPtr active,focus,capture,menuOwner,moveSize,caret;public RECT caretRect;}
 [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread,ref GUIINFO info);
 static bool ControlFocused(AutomationElement element){
  if(element.Current.HasKeyboardFocus)return true;
  return NativeFocused(element.Current.NativeWindowHandle);
 }
 [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h,uint flag);
 [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h,uint command);
 static IntPtr RootOwner(IntPtr h){
  var current=GetAncestor(h,2);uint pid;GetWindowThreadProcessId(current,out pid);var seen=new HashSet<IntPtr>();
  for(int i=0;i<32&&current!=IntPtr.Zero;i++){
   if(!seen.Add(current))throw new Exception("AMBIGUOUS_WINDOW");var owner=GetWindow(current,4);if(owner==IntPtr.Zero)return current;
   var next=GetAncestor(owner,2);uint ownerPid;GetWindowThreadProcessId(next,out ownerPid);if(ownerPid!=pid)return current;current=next;
  }throw new Exception("AMBIGUOUS_WINDOW");
 }
 [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h,uint message,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] static extern uint GetDoubleClickTime();
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder name,int length);
 [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h,ref POINT p);
 [StructLayout(LayoutKind.Sequential)] struct RECT {public int left,top,right,bottom;}
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
 [StructLayout(LayoutKind.Sequential)] struct POINT {public int x,y;public POINT(int a,int b){x=a;y=b;}}
 [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
 [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT {public int dx,dy;public uint mouseData,dwFlags,time;public IntPtr dwExtraInfo;}
 [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT {public ushort wVk,wScan;public uint dwFlags,time;public IntPtr dwExtraInfo;}
 [StructLayout(LayoutKind.Explicit)] struct INPUTUNION {[FieldOffset(0)] public MOUSEINPUT mi;[FieldOffset(0)] public KEYBDINPUT ki;}
 [StructLayout(LayoutKind.Sequential)] struct INPUT {public uint type;public INPUTUNION u;}
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint n,INPUT[] inputs,int size);
 [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr h,uint id,ref Guid iid,[MarshalAs(UnmanagedType.Interface)] out IAccessible a);
 [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible a,int start,int count,[Out,MarshalAs(UnmanagedType.LPArray,SizeParamIndex=2)] object[] children,out int obtained);
 [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 // The API is wide-character only; without CharSet.Unicode the marshalled buffer is half the needed size and overruns.
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern int GetApplicationUserModelId(IntPtr p,ref uint n,StringBuilder id);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern int GetPackageFamilyName(IntPtr p,ref uint n,StringBuilder name);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr p,uint flags,StringBuilder name,ref uint size);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr p);
 static readonly Regex Secret=new Regex(@"password|passcode|credential|one.time|verification code|security code|credit.?card|card.?number|\bcvv\b|\bpin\b|\botp\b|api.?key|access.?token|secret|sign.?in|log.?in",RegexOptions.IgnoreCase);
 public class Control {
  public string locator,signature,provider,label,role,automationId,parentId,shortcut,valueHash,selectionHash,text;
  public string[] actions;
  public bool enabled,selected,focused,directType;
  public double x,y,width,height;
  internal AutomationElement uia;
  internal IAccessible acc;
  internal object child;
 }
 public class Snapshot {
  public bool success=true;
  public int processId;
  public long windowId;
  public long rootWindowId;
  public bool isDialog;
  public bool inputVerified;
  public string windowTitle,provider,screenFingerprint;
  public bool truncated;
  public Control[] controls;
 }
 public class Frame {public bool success=true;public int processId,width,height,x,y;public long windowId,rootWindowId;public string image,frameHash;}
 public static Frame Capture(string exe,string id,long window,int pid){
  var root=Window(exe,id,window,pid);var handle=new IntPtr(Handle(root));
  if(Secret.IsMatch(root.Current.Name)||ForegroundRoot()!=handle)throw new Exception("VISION_PRIVACY_UNVERIFIED");
  RECT r;if(!GetWindowRect(handle,out r))throw new Exception("VISION_UNAVAILABLE");
  int width=r.right-r.left,height=r.bottom-r.top;
  if(width<10||height<10||width>3840||height>2160||width*height>8300000)throw new Exception("VISION_UNAVAILABLE");
  using(var bitmap=new Bitmap(width,height,PixelFormat.Format32bppArgb)){
   using(var graphics=Graphics.FromImage(bitmap)){
    IntPtr dc=graphics.GetHdc();bool ok;try{ok=PrintWindow(handle,dc,2);}finally{graphics.ReleaseHdc(dc);}
    if(!ok)throw new Exception("VISION_UNAVAILABLE");
    var children=root.FindAll(TreeScope.Descendants,Condition.TrueCondition);
    if(children.Count>2000)throw new Exception("VISION_PRIVACY_UNVERIFIED");
    // Redact known password/sensitive controls (including their whole subtree).
    // Unknown custom rendering remains local-only and requires operator opt-in.
    foreach(AutomationElement child in children){var p=child.Current;
     if(p.IsPassword||Secret.IsMatch((p.Name??"")+" "+(p.AutomationId??""))||(p.LabeledBy!=null&&Secret.IsMatch(p.LabeledBy.Current.Name))){
      var box=p.BoundingRectangle;if(!box.IsEmpty)graphics.FillRectangle(Brushes.Black,(float)(box.X-r.left),(float)(box.Y-r.top),(float)box.Width,(float)box.Height);
     }
    }
   }
   using(var stream=new MemoryStream()){bitmap.Save(stream,ImageFormat.Png);byte[] bytes=stream.ToArray();string hash;using(var h=SHA256.Create())hash=BitConverter.ToString(h.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();
    var result=new Frame{processId=root.Current.ProcessId,windowId=window,rootWindowId=RootOwner(handle).ToInt64(),width=width,height=height,x=r.left,y=r.top,image=Convert.ToBase64String(bytes),frameHash=hash};Array.Clear(bytes,0,bytes.Length);return result;
   }
  }
 }
 public static Snapshot VisualAct(string exe,string id,long window,int pid,string hash,double x,double y,double width,double height,string operation){
  if(operation!="click"&&operation!="doubleClick")throw new Exception("UNSUPPORTED_ACTION");
  var frame=Capture(exe,id,window,pid);frame.image=null;
  if(frame.frameHash!=hash)throw new Exception("STALE_SNAPSHOT");
  if(Double.IsNaN(x)||Double.IsNaN(y)||Double.IsInfinity(x)||Double.IsInfinity(y)||width<2||height<2||x<0||y<0||x+width>frame.width||y+height>frame.height)throw new Exception("UNGROUNDED_ACTION");
  var before=Read(exe,id,window,false,pid);
  Mouse(new Control{x=frame.x+x,y=frame.y+y,width=width,height=height},before,operation=="doubleClick");
  return WaitForChange(exe,id,before);
 }
 static string Hash(string s){using(var h=SHA256.Create())return BitConverter.ToString(h.ComputeHash(Encoding.UTF8.GetBytes(s??""))).Replace("-","").ToLowerInvariant();}
 static string Short(string s){s=s??"";return s.Length>300?s.Substring(0,300):s;}
 static string Aumid(int pid){var p=OpenProcess(0x1000,false,pid);if(p==IntPtr.Zero)return "";try{uint n=0;GetApplicationUserModelId(p,ref n,null);if(n==0||n>2048)return "";var s=new StringBuilder((int)n);return GetApplicationUserModelId(p,ref n,s)==0?s.ToString():"";}finally{CloseHandle(p);}}
 static string PackageFamily(int pid){var p=OpenProcess(0x1000,false,pid);if(p==IntPtr.Zero)return "";try{uint n=0;GetPackageFamilyName(p,ref n,null);if(n==0||n>1024)return "";var s=new StringBuilder((int)n+1);return GetPackageFamilyName(p,ref n,s)==0?s.ToString():"";}finally{CloseHandle(p);}}
 static string ImagePath(int pid){var p=OpenProcess(0x1000,false,pid);if(p==IntPtr.Zero)return "";try{uint n=1024;var s=new StringBuilder(1024);return QueryFullProcessImageName(p,0,s,ref n)?s.ToString():"";}finally{CloseHandle(p);}}
 // An AUMID is "<PackageFamilyName>!<AppId>". Store apps (Windows 11 Notepad, Calculator...) are recorded by AUMID only, and
 // GetApplicationUserModelId does not always report it for their process. The process still belongs to the package family,
 // and its image lives in WindowsApps\<Name>_<Version>_<Arch>__<PublisherId>\, so either proves the identity.
 static bool PackageMatches(int pid,string id){
  int bang=id.IndexOf('!');if(bang<=0)return false;string family=id.Substring(0,bang);
  if(String.Equals(PackageFamily(pid),family,StringComparison.OrdinalIgnoreCase))return true;
  int cut=family.LastIndexOf('_');if(cut<=0)return false;string name=family.Substring(0,cut),publisher=family.Substring(cut+1);
  var m=Regex.Match(ImagePath(pid),@"\\WindowsApps\\([^\\]+)\\",RegexOptions.IgnoreCase);if(!m.Success)return false;
  string folder=m.Groups[1].Value;
  return folder.StartsWith(name+"_",StringComparison.OrdinalIgnoreCase)&&folder.EndsWith("__"+publisher,StringComparison.OrdinalIgnoreCase);
 }
 static bool Identity(AutomationElement w,string exe,string id){try{int pid=w.Current.ProcessId;if(!String.IsNullOrEmpty(id)&&(Aumid(pid)==id||PackageMatches(pid,id)))return true;return !String.IsNullOrEmpty(exe)&&String.Equals(Process.GetProcessById(pid).MainModule.FileName,exe,StringComparison.OrdinalIgnoreCase);}catch{return false;}}
 static long Handle(AutomationElement w){try{return w.Current.NativeWindowHandle;}catch{return 0;}}
 // Opt-in diagnostics (CHANAKYA_DEBUG_UI=1) for window selection failures; never includes control text.
 static void Trace(string why,long requested,int expectedPid,List<AutomationElement> found){
  if(Environment.GetEnvironmentVariable("CHANAKYA_DEBUG_UI")!="1")return;
  Console.Error.WriteLine(why+" requested="+requested+" expectedPid="+expectedPid+" foreground="+GetForegroundWindow().ToInt64()+" candidates="+String.Join(",",found.Select(w=>{try{return Handle(w)+"/pid"+w.Current.ProcessId;}catch{return "?";}})));
 }
 static AutomationElement Window(string exe,string id,long requested,int expectedPid){
  // Bound actions do not need a desktop-wide scan. Verify the exact live HWND
  // and executable again. Enumeration remains for initial discovery/UWP hosts.
  if(requested!=0){try{
   var handle=new IntPtr(requested);var exact=AutomationElement.FromHandle(handle);
   if(IsWindow(handle)&&GetAncestor(handle,2)==handle&&Handle(exact)==requested&&Identity(exact,exe,id)&&(expectedPid==0||exact.Current.ProcessId==expectedPid))return exact;
  }catch{}}
  var all=AutomationElement.RootElement.FindAll(TreeScope.Children,Condition.TrueCondition);var matches=new List<AutomationElement>();
  foreach(AutomationElement w in all){try{
   if(Identity(w,exe,id)&&(expectedPid==0||w.Current.ProcessId==expectedPid))matches.Add(w);
   else if(!String.IsNullOrEmpty(id)) {
    var children=w.FindAll(TreeScope.Children,Condition.TrueCondition);
    foreach(AutomationElement c in children)if(Identity(c,exe,id)&&(expectedPid==0||w.Current.ProcessId==expectedPid)){matches.Add(w);break;}
   }
  }catch{}
  }
  // A process can own hidden helper windows that disappear mid-read; prefer the visible ones.
  var shown=matches.Where(w=>IsWindowVisible(new IntPtr(Handle(w)))).ToList();if(shown.Count>0)matches=shown;
  var candidates=matches.ToList();
  if(requested!=0){matches=matches.Where(w=>Handle(w)==requested).ToList();}
  if(matches.Count==0){Trace("WINDOW_NOT_FOUND",requested,expectedPid,candidates);throw new Exception("WINDOW_NOT_FOUND");}
  var fg=ForegroundRoot().ToInt64();var active=matches.Where(w=>Handle(w)==fg).ToList();
  if(active.Count==1)return active[0];
  if(matches.Count!=1){Trace("AMBIGUOUS_WINDOW",requested,expectedPid,matches);throw new Exception("AMBIGUOUS_WINDOW");}return matches[0];
 }
 static void Seal(Control c){c.signature=Hash(String.Join("|",new[]{c.provider,c.locator,c.label,c.role,c.automationId,c.parentId,c.shortcut,c.enabled.ToString(),c.selected.ToString(),c.valueHash,c.selectionHash,String.Join(",",c.actions)}));}
 // Every property and pattern state a snapshot needs, fetched in ONE cross-process round trip per element. Reading them
 // one by one (c.Current.X, TryGetCurrentPattern...) cost ~30 round trips per element, i.e. several seconds per read on
 // WinUI apps such as Windows 11 Notepad and Settings. Elements are still fully live for actions (AutomationElementMode.Full).
 static readonly AutomationProperty[] NodeProperties={AutomationElement.NameProperty,AutomationElement.AutomationIdProperty,AutomationElement.ControlTypeProperty,
  AutomationElement.IsPasswordProperty,AutomationElement.IsOffscreenProperty,AutomationElement.IsKeyboardFocusableProperty,AutomationElement.IsEnabledProperty,
  AutomationElement.HasKeyboardFocusProperty,AutomationElement.BoundingRectangleProperty,AutomationElement.NativeWindowHandleProperty,AutomationElement.ClassNameProperty,
  AutomationElement.AcceleratorKeyProperty,AutomationElement.RuntimeIdProperty,AutomationElement.LabeledByProperty,
  AutomationElement.IsScrollPatternAvailableProperty,AutomationElement.IsInvokePatternAvailableProperty,AutomationElement.IsExpandCollapsePatternAvailableProperty,
  AutomationElement.IsSelectionItemPatternAvailableProperty,AutomationElement.IsTogglePatternAvailableProperty,AutomationElement.IsValuePatternAvailableProperty,
  AutomationElement.IsTextPatternAvailableProperty,ScrollPattern.VerticallyScrollableProperty,ScrollPattern.HorizontallyScrollableProperty,
  SelectionItemPattern.IsSelectedProperty,TogglePattern.ToggleStateProperty,ValuePattern.ValueProperty,ValuePattern.IsReadOnlyProperty};
 static CacheRequest nodeCache;
 static CacheRequest NodeCache(){
  if(nodeCache!=null)return nodeCache;
  var request=new CacheRequest();request.TreeScope=TreeScope.Element;request.AutomationElementMode=AutomationElementMode.Full;
  foreach(var property in NodeProperties)request.Add(property);
  nodeCache=request;return request;
 }
 static T Cached<T>(AutomationElement e,AutomationProperty p,T fallback){try{object v=e.GetCachedPropertyValue(p,true);return v is T?(T)v:fallback;}catch{return fallback;}}
 static bool NativeFocused(int native){
  if(native==0)return false;uint pid;
  var handle=new IntPtr(native);uint thread=GetWindowThreadProcessId(handle,out pid);var info=new GUIINFO{size=(uint)Marshal.SizeOf(typeof(GUIINFO))};
  return thread!=0&&GetGUIThreadInfo(thread,ref info)&&info.focus==handle;
 }
 static void UiaChildren(AutomationElement root,List<Control> controls){
  var queue=new Queue<Tuple<AutomationElement,string,int>>();queue.Enqueue(Tuple.Create(root,"",0));var walker=TreeWalker.ControlViewWalker;int visited=0;var cache=NodeCache();
  while(queue.Count>0&&visited<500){var n=queue.Dequeue();if(n.Item3>=12)continue;AutomationElement c=null;try{c=walker.GetFirstChild(n.Item1,cache);}catch{continue;}
   while(c!=null&&visited++<500){try{
    string label=Short(Cached(c,AutomationElement.NameProperty,"")),aid=Short(Cached(c,AutomationElement.AutomationIdProperty,""));
    var labeledBy=Cached<AutomationElement>(c,AutomationElement.LabeledByProperty,null);
    bool secret=Cached(c,AutomationElement.IsPasswordProperty,false)||Secret.IsMatch(label+" "+aid)||(labeledBy!=null&&Secret.IsMatch(labeledBy.Current.Name));
    if(!Cached(c,AutomationElement.IsOffscreenProperty,false)&&!secret){
     var runtime=Cached<int[]>(c,AutomationElement.RuntimeIdProperty,null)??c.GetRuntimeId();
     string locator=String.Join(".",runtime);var actions=new List<string>();object pattern;
     var controlType=Cached<ControlType>(c,AutomationElement.ControlTypeProperty,ControlType.Custom);
     bool selected=false,enabled=Cached(c,AutomationElement.IsEnabledProperty,false);
     int native=Cached(c,AutomationElement.NativeWindowHandleProperty,0);string className=Cached(c,AutomationElement.ClassNameProperty,"")??"";
     if(Cached(c,AutomationElement.IsKeyboardFocusableProperty,false))actions.Add("focus");
     if(Cached(c,AutomationElement.IsScrollPatternAvailableProperty,false)){
      if(Cached(c,ScrollPattern.VerticallyScrollableProperty,false)){actions.Add("scrollDown");actions.Add("scrollUp");}
      if(Cached(c,ScrollPattern.HorizontallyScrollableProperty,false)){actions.Add("scrollLeft");actions.Add("scrollRight");}
     }
     if(Cached(c,AutomationElement.IsInvokePatternAvailableProperty,false))actions.Add("invoke");
     if(Cached(c,AutomationElement.IsExpandCollapsePatternAvailableProperty,false)){actions.Add("expand");actions.Add("collapse");}
     if(Cached(c,AutomationElement.IsSelectionItemPatternAvailableProperty,false)){actions.Add("select");selected=Cached(c,SelectionItemPattern.IsSelectedProperty,false);}
     if(Cached(c,AutomationElement.IsTogglePatternAvailableProperty,false)){actions.Add("toggle");selected=Cached(c,TogglePattern.ToggleStateProperty,ToggleState.Off)==ToggleState.On;}
     string valueHash="",text="",selectionHash="";bool directType=false;bool hasText=Cached(c,AutomationElement.IsTextPatternAvailableProperty,false);
     if(Cached(c,AutomationElement.IsValuePatternAvailableProperty,false)){
      string value=Cached(c,ValuePattern.ValueProperty,"")??"";valueHash=Hash(value);text=Short(value);
      if(!Cached(c,ValuePattern.IsReadOnlyProperty,true)){actions.Add("setValue");directType=value.Length<=10000&&(value.Length==0||controlType==ControlType.Edit&&native!=0&&Regex.IsMatch(className,"edit",RegexOptions.IgnoreCase));}
     }
     else if(controlType==ControlType.Document&&hasText&&c.TryGetCurrentPattern(TextPattern.Pattern,out pattern)){text=((TextPattern)pattern).DocumentRange.GetText(300);valueHash=Hash(text);}
     if(hasText&&c.TryGetCurrentPattern(TextPattern.Pattern,out pattern)){selectionHash=Hash(String.Join("|",((TextPattern)pattern).GetSelection().Select(range=>range.GetText(300))));}
     else if(controlType==ControlType.Edit&&native!=0){int start=0,end=0;SendMessage(new IntPtr(native),0xB0,ref start,ref end);selectionHash=Hash(start+":"+end);}
     var r=Cached(c,AutomationElement.BoundingRectangleProperty,System.Windows.Rect.Empty);
     if(enabled&&(controlType==ControlType.Button||controlType==ControlType.Hyperlink||controlType==ControlType.ListItem||controlType==ControlType.TreeItem||controlType==ControlType.MenuItem||controlType==ControlType.TabItem)){
      // Occlusion can hide the clickable point while the app is in the
      // background. Advertise the supported operation from visible bounds;
      // Mouse() focuses and obtains a fresh point, then verifies hit identity.
      if(!r.IsEmpty&&r.Width>0&&r.Height>0){actions.Add("click");actions.Add("doubleClick");}
     }
     bool focused=Cached(c,AutomationElement.HasKeyboardFocusProperty,false)||NativeFocused(native);
     var item=new Control{provider="UIA",locator=locator,label=label,automationId=aid,role=controlType.ProgrammaticName.Replace("ControlType.",""),parentId=n.Item2,enabled=enabled,selected=selected,focused=focused,directType=directType,shortcut=Short(Cached(c,AutomationElement.AcceleratorKeyProperty,"")),valueHash=valueHash,selectionHash=selectionHash,text=text,actions=actions.ToArray(),x=r.IsEmpty?0:r.X,y=r.IsEmpty?0:r.Y,width=r.IsEmpty?0:r.Width,height=r.IsEmpty?0:r.Height,uia=c};Seal(item);controls.Add(item);
     queue.Enqueue(Tuple.Create(c,locator,n.Item3+1));
    }
   }catch{}try{c=walker.GetNextSibling(c,cache);}catch{break;}}
  }
 }
 static string Role(int r){switch(r){case 12:return "MenuItem";case 43:return "Button";case 42:return "Edit";case 60:return "TabItem";case 44:return "CheckBox";case 45:return "RadioButton";case 46:return "ComboBox";case 36:return "List";case 34:return "ListItem";case 35:return "TreeItem";case 20:return "Group";case 41:return "Text";case 30:return "Hyperlink";case 18:return "Dialog";case 16:return "Pane";default:return "AccessibleRole"+r;}}
 static void Msaa(IAccessible a,object child,string locator,string parent,List<Control> result,int depth,ref int visited){
  if(depth>12||visited++>=500)return;
  try{
   string label=Short(a.get_accName(child));int state=Convert.ToInt32(a.get_accState(child));
   if((state&0x20018000)!=0||Secret.IsMatch(label))return;
   int role=Convert.ToInt32(a.get_accRole(child));string defaultAction=Short(a.get_accDefaultAction(child));var actions=new List<string>();
   if(!String.IsNullOrEmpty(defaultAction))actions.Add("invoke");
   if(role==60||role==34||role==35||role==45)actions.Add("select");
   if(role==42&&(state&0x40)==0)actions.Add("setValue");
   int x,y,w,h;a.accLocation(out x,out y,out w,out h,child);
   if((state&0x100000)!=0)actions.Add("focus");
   if(w>0&&h>0&&(role==43||role==34||role==35||role==12||role==60)){actions.Add("click");actions.Add("doubleClick");}
   var c=new Control{provider="MSAA",locator=locator,label=label,role=Role(role),automationId="",parentId=parent,enabled=(state&1)==0,selected=(state&2)!=0,focused=(state&4)!=0,shortcut=Short(a.get_accKeyboardShortcut(child)),valueHash=role==42?Hash(a.get_accValue(child)):"",text=role==42?Short(a.get_accValue(child)):"",actions=actions.ToArray(),x=x,y=y,width=w,height=h,acc=a,child=child};Seal(c);result.Add(c);
   if(!(child is int)||Convert.ToInt32(child)!=0)return;
   int count=Math.Min(a.accChildCount,500-visited);if(count<=0)return;object[] items=new object[count];int got;
   if(AccessibleChildren(a,0,count,items,out got)<0)return;
   for(int i=0;i<got;i++){var sub=items[i] as IAccessible;if(sub!=null)Msaa(sub,0,locator+"/"+i,locator,result,depth+1,ref visited);else if(items[i] is int)Msaa(a,items[i],locator+"/"+i,locator,result,depth+1,ref visited);}
  }catch{}
 }
 public static Snapshot Read(string exe,string id,long requested,bool focus,int expectedPid=0,bool restoreMinimized=false){
  return ReadStable(exe,id,requested,focus,expectedPid,restoreMinimized,1);
 }
 static Snapshot ReadStable(string exe,string id,long requested,bool focus,int expectedPid,bool restoreMinimized,int restoreRetries){
  var root=Window(exe,id,requested,expectedPid);IntPtr handle;
  // A window can close between selection and reading; report that as WINDOW_NOT_FOUND, not as a failed inspection.
  try{handle=new IntPtr(root.Current.NativeWindowHandle);GC.KeepAlive(root.Current.Name);}catch(ElementNotAvailableException){throw new Exception("WINDOW_NOT_FOUND");}
  // Restore only the exact executable/PID/HWND already validated above. Do not
  // turn a minimized window into an empty MSAA snapshot or relaunch the app.
  if(IsIconic(handle)){
   if(!restoreMinimized&&!focus)throw new Exception("WINDOW_MINIMIZED");
   ShowWindowAsync(handle,9);
   for(int i=0;i<20&&IsIconic(handle);i++)System.Threading.Thread.Sleep(50);
   if(IsIconic(handle))throw new Exception("WINDOW_MINIMIZED");
   System.Threading.Thread.Sleep(100);
  }
  if(focus){Focus(handle);System.Threading.Thread.Sleep(120);}
  if(Secret.IsMatch(root.Current.Name))throw new Exception("SENSITIVE_WINDOW");
  var controls=new List<Control>();UiaChildren(root,controls);string provider="UIA";
  if(!controls.Any(c=>c.actions.Length>0)){
   Guid guid=new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");IAccessible a;
   if(AccessibleObjectFromWindow(handle,0xFFFFFFFC,ref guid,out a)>=0&&a!=null){var fallback=new List<Control>();int visited=0;Msaa(a,0,"0","",fallback,0,ref visited);if(fallback.Count>controls.Count){controls=fallback;provider="MSAA";}}
  }
  // Bind each control to its freshly observed parent context, not unrelated
  // changing status bars or clocks elsewhere in the same authorized window.
  var contexts=new Dictionary<string,string>();string title=Short(root.Current.Name);
  foreach(var item in controls){string parentSignature="";contexts.TryGetValue(item.parentId??"",out parentSignature);item.signature=Hash(item.signature+"|"+title+"|"+parentSignature);contexts[item.locator]=item.signature;}
  var snapshot=new Snapshot{windowId=handle.ToInt64(),rootWindowId=RootOwner(handle).ToInt64(),isDialog=GetWindow(handle,4)!=IntPtr.Zero,processId=root.Current.ProcessId,windowTitle=Short(root.Current.Name),provider=provider,controls=controls.ToArray(),truncated=controls.Count>=499,screenFingerprint=Hash(String.Join(";",controls.Select(c=>c.signature+":"+c.focused)))};
  // A provider traversal can outlast a minimize transition. Never return its
  // empty/offscreen tree as a fresh actionable snapshot. Authorized restoration
  // starts one complete read with the same HWND/PID identity checks; a repeated
  // transition is refused without replaying the caller's action.
  if(IsIconic(handle)){
   if((!restoreMinimized&&!focus)||restoreRetries==0)throw new Exception("WINDOW_MINIMIZED");
   return ReadStable(exe,id,handle.ToInt64(),focus,snapshot.processId,restoreMinimized,restoreRetries-1);
  }
  return snapshot;
 }
 // Follow only owned dialogs in the same process and owner family. A different
 // foreground application or an unrelated sibling window can never become a target.
 public static Snapshot Observe(string exe,string id,long window,bool focus,int pid,long rootWindow,bool restoreMinimized=false){
  if(window==0)return Read(exe,id,window,focus,pid,restoreMinimized);
  IntPtr old=new IntPtr(window),fg=ForegroundRoot();uint fgPid;
  GetWindowThreadProcessId(fg,out fgPid);
  long family=IsWindow(old)?RootOwner(old).ToInt64():rootWindow;
  if(Environment.GetEnvironmentVariable("CHANAKYA_DEBUG_UI")=="1")Console.Error.WriteLine("OBSERVE window="+window+" foreground="+fg.ToInt64()+" pid="+pid+" foregroundPid="+fgPid+" family="+family+" enabled="+IsWindowEnabled(old));
  // A provider can leave foreground on the button that opened a modal. When
  // the bound owner is disabled, find its one enabled, visible owned dialog
  // by native HWND/PID/owner identity, independent of the UIA desktop tree.
  if(pid>0&&family!=0&&IsWindow(old)&&!IsWindowEnabled(old)){
   var dialogs=new List<IntPtr>();
   EnumWindows((handle,value)=>{uint candidatePid;GetWindowThreadProcessId(handle,out candidatePid);var owner=GetWindow(handle,4);
    if(candidatePid==pid&&handle!=old&&owner!=IntPtr.Zero&&!IsWindowEnabled(owner)&&IsWindowVisible(handle)&&IsWindowEnabled(handle)&&RootOwner(handle).ToInt64()==family){
     try{var type=AutomationElement.FromHandle(handle).Current.ControlType;if(type!=ControlType.Menu&&type!=ControlType.ToolTip)dialogs.Add(handle);}catch{}
    }return true;
   },IntPtr.Zero);
   if(dialogs.Count==1)return Read(exe,id,dialogs[0].ToInt64(),focus,pid,restoreMinimized);
   if(dialogs.Count>1)throw new Exception("AMBIGUOUS_WINDOW");
  }
  if(pid>0&&fgPid==pid&&family!=0&&RootOwner(fg).ToInt64()==family&&fg!=old){
   // Owned menus/tooltips can temporarily be foreground HWNDs without being
   // application dialogs. Keep the original binding for those transient views.
   try{var candidate=AutomationElement.FromHandle(fg);object pattern;
    if(candidate.Current.ControlType==ControlType.Window||candidate.TryGetCurrentPattern(WindowPattern.Pattern,out pattern))return Read(exe,id,fg.ToInt64(),focus,pid,restoreMinimized);
    if(Environment.GetEnvironmentVariable("CHANAKYA_DEBUG_UI")=="1")Console.Error.WriteLine("OWNED_VIEW foreground="+fg.ToInt64()+" type="+candidate.Current.ControlType.ProgrammaticName+" handle="+Handle(candidate));
   }catch(Exception e){if(e.Message!="WINDOW_NOT_FOUND")throw;}
  }
  return Read(exe,id,IsWindow(old)?window:family,focus,pid,restoreMinimized);
 }
 static void TraceMouse(string stage,Snapshot before,IntPtr receiver,uint pid,IntPtr root,IntPtr foreground,bool? hitMatches){
  if(Environment.GetEnvironmentVariable("CHANAKYA_DEBUG_UI")!="1")return;
  // Match flags identify the failed guard without revealing control content or
  // pointer coordinates. The native values were captured at that guard.
  Console.Error.WriteLine("MOUSE_GUARD stage="+stage+" processMatches="+(pid==before.processId)+" windowMatches="+(root.ToInt64()==before.windowId)+" foregroundMatches="+(foreground.ToInt64()==before.windowId)+" receiverPresent="+(receiver!=IntPtr.Zero)+" hitMatches="+(hitMatches.HasValue?hitMatches.Value.ToString():"unchecked"));
 }
 static void Mouse(Control c,Snapshot before,bool twice){
  var handle=new IntPtr(before.windowId);
  if(!Focus(handle))throw new Exception("FOCUS_UNVERIFIED");
  double x=c.x+c.width/2,y=c.y+c.height/2;
  if(c.uia!=null){System.Windows.Point point;if(!c.uia.TryGetClickablePoint(out point))throw new Exception("CONTROL_NOT_CLICKABLE");x=point.X;y=point.Y;}
  if(c.width<=0||c.height<=0||x<c.x||y<c.y||x>=c.x+c.width||y>=c.y+c.height)throw new Exception("UNGROUNDED_ACTION");
  var pointAt=new POINT((int)x,(int)y);uint pid;IntPtr target=WindowFromPoint(pointAt);GetWindowThreadProcessId(target,out pid);
  var targetRoot=GetAncestor(target,2);var foreground=ForegroundRoot();
  if(pid!=before.processId||targetRoot!=handle||foreground!=handle){TraceMouse("initialNative",before,target,pid,targetRoot,foreground,null);throw new Exception("TARGET_OCCLUDED");}
  if(!SetCursorPos(pointAt.x,pointAt.y))throw new Exception("INPUT_BLOCKED");
  // Re-check after moving: hovering can open a popup or move another window.
  target=WindowFromPoint(pointAt);targetRoot=GetAncestor(target,2);foreground=ForegroundRoot();
  if(targetRoot!=handle||foreground!=handle){GetWindowThreadProcessId(target,out pid);TraceMouse("hoverNative",before,target,pid,targetRoot,foreground,null);throw new Exception("TARGET_OCCLUDED");}
  if(c.uia!=null&&!HitMatches(c.uia,x,y)){
   target=WindowFromPoint(pointAt);GetWindowThreadProcessId(target,out pid);targetRoot=GetAncestor(target,2);foreground=ForegroundRoot();
   TraceMouse("uiaHit",before,target,pid,targetRoot,foreground,false);throw new Exception("TARGET_OCCLUDED");
  }
  var down=new INPUT{type=0};down.u.mi=new MOUSEINPUT{dwFlags=2};var up=new INPUT{type=0};up.u.mi=new MOUSEINPUT{dwFlags=4};
  Dispatch(new List<INPUT>{down,up});
  if(twice){System.Threading.Thread.Sleep((int)Math.Min(30,Math.Max(1,GetDoubleClickTime()/4)));
   foreground=ForegroundRoot();target=WindowFromPoint(pointAt);targetRoot=GetAncestor(target,2);bool? hitMatches=null;
   if(foreground==handle&&targetRoot==handle&&c.uia!=null)hitMatches=HitMatches(c.uia,x,y);
   if(foreground!=handle||targetRoot!=handle||hitMatches==false){GetWindowThreadProcessId(target,out pid);TraceMouse("secondClick",before,target,pid,targetRoot,foreground,hitMatches);throw new Exception("UI_EXECUTION_UNCERTAIN");}
   var receiver=WindowFromPoint(pointAt);var nativeClass=new StringBuilder(256);GetClassName(receiver,nativeClass,nativeClass.Capacity);
   // Accessibility hit testing can exceed a user's very short double-click
   // interval. Classic list/tree controls have an equivalent native message,
   // directed to the revalidated receiver rather than another global click.
   if(Regex.IsMatch(nativeClass.ToString(),"LISTBOX|SysListView32|SysTreeView32",RegexOptions.IgnoreCase)){
    var client=pointAt;if(!ScreenToClient(receiver,ref client))throw new Exception("UI_EXECUTION_UNCERTAIN");
    var coordinates=new IntPtr((client.x&0xffff)|((client.y&0xffff)<<16));
    if(!PostMessage(receiver,0x203,new IntPtr(1),coordinates)||!PostMessage(receiver,0x202,IntPtr.Zero,coordinates))throw new Exception("UI_EXECUTION_UNCERTAIN");
   }else Dispatch(new List<INPUT>{down,up});
  }
 }
 static bool HitMatches(AutomationElement expected,double x,double y){
  int visited=0;
  try{var actual=AutomationElement.FromPoint(new System.Windows.Point(x,y));var walker=TreeWalker.ControlViewWalker;var identity=expected.GetRuntimeId();
   for(int i=0;i<30&&actual!=null;i++){visited++;if(actual.GetRuntimeId().SequenceEqual(identity))return true;actual=walker.GetParent(actual);}
  }catch(Exception failure){
   if(Environment.GetEnvironmentVariable("CHANAKYA_DEBUG_UI")=="1")Console.Error.WriteLine("MOUSE_HIT status=providerError type="+failure.GetType().FullName+" hresult="+failure.HResult);
   return false;
  }
  if(Environment.GetEnvironmentVariable("CHANAKYA_DEBUG_UI")=="1")Console.Error.WriteLine("MOUSE_HIT status=identityAbsent visited="+visited);
  return false;
 }
 public static object Close(string exe,string id,long window,int pid){
  var before=Read(exe,id,window,false,pid);var h=new IntPtr(before.windowId);
  if(!PostMessage(h,0x10,IntPtr.Zero,IntPtr.Zero))throw new Exception("INPUT_BLOCKED");
  for(int i=0;i<15;i++){System.Threading.Thread.Sleep(100);if(!IsWindow(h))return new {success=true,closed=true,processId=before.processId,windowId=before.windowId};
   var now=Observe(exe,id,window,false,before.processId,before.rootWindowId);if(now.windowId!=window||now.screenFingerprint!=before.screenFingerprint)return now;}
  return Read(exe,id,window,false,pid);
 }
 public static Snapshot Act(string exe,string id,long window,string fingerprint,string locator,string signature,string operation,string value,int expectedPid=0){
  var before=Read(exe,id,window,false,expectedPid,true);
  // Read() resolves all native references again. The exact control and parent
  // context signatures below must still match before the single mutation.
  var found=before.controls.Where(item=>item.locator==locator&&item.signature==signature).ToArray();
  // Restored windows can expose a partial provider tree for a few frames.
  // Wait only in preflight; never replay a side effect or accept changed IDs.
  for(int retry=0;found.Length==0&&retry<3;retry++){
   System.Threading.Thread.Sleep(200);before=Read(exe,id,window,false,expectedPid,true);found=before.controls.Where(item=>item.locator==locator&&item.signature==signature).ToArray();
  }
  if(found.Length!=1){if(Environment.GetEnvironmentVariable("CHANAKYA_DEBUG_UI")=="1")Console.Error.WriteLine("STALE_CONTROL expected="+signature+" current="+String.Join(",",before.controls.Where(item=>item.locator==locator).Select(item=>item.signature+"/"+item.role+"/"+String.Join("+",item.actions))));throw new Exception("STALE_SNAPSHOT");}
  if(!found[0].enabled||!found[0].actions.Contains(operation))throw new Exception("UNGROUNDED_ACTION");
  var c=found[0];
  if(operation=="click"||operation=="doubleClick")Mouse(c,before,operation=="doubleClick");
  else
  if(c.uia!=null){switch(operation){
   case "focus":
    if(ControlFocused(c.uia))break;
    Focus(new IntPtr(before.windowId));
    if(c.uia.Current.NativeWindowHandle!=0){
     IntPtr child=new IntPtr(c.uia.Current.NativeWindowHandle);uint pid;uint thread=GetWindowThreadProcessId(child,out pid),self=GetCurrentThreadId();
     if(pid!=before.processId||GetAncestor(child,2).ToInt64()!=before.windowId)throw new Exception("FOCUS_UNVERIFIED");
     bool attached=false;try{attached=AttachThreadInput(self,thread,true);if(attached)SetFocus(child);}finally{if(attached)AttachThreadInput(self,thread,false);}
    }else c.uia.SetFocus();
    System.Threading.Thread.Sleep(80);
    break;
   case "collapse":((ExpandCollapsePattern)c.uia.GetCurrentPattern(ExpandCollapsePattern.Pattern)).Collapse();break;
   case "scrollDown":((ScrollPattern)c.uia.GetCurrentPattern(ScrollPattern.Pattern)).Scroll(ScrollAmount.NoAmount,ScrollAmount.SmallIncrement);break;
   case "scrollUp":((ScrollPattern)c.uia.GetCurrentPattern(ScrollPattern.Pattern)).Scroll(ScrollAmount.NoAmount,ScrollAmount.SmallDecrement);break;
   case "scrollLeft":((ScrollPattern)c.uia.GetCurrentPattern(ScrollPattern.Pattern)).Scroll(ScrollAmount.SmallDecrement,ScrollAmount.NoAmount);break;
   case "scrollRight":((ScrollPattern)c.uia.GetCurrentPattern(ScrollPattern.Pattern)).Scroll(ScrollAmount.SmallIncrement,ScrollAmount.NoAmount);break;
   case "invoke":((InvokePattern)c.uia.GetCurrentPattern(InvokePattern.Pattern)).Invoke();break;
   case "expand":((ExpandCollapsePattern)c.uia.GetCurrentPattern(ExpandCollapsePattern.Pattern)).Expand();break;
   case "select":((SelectionItemPattern)c.uia.GetCurrentPattern(SelectionItemPattern.Pattern)).Select();break;
   case "toggle":((TogglePattern)c.uia.GetCurrentPattern(TogglePattern.Pattern)).Toggle();break;
   case "setValue":((ValuePattern)c.uia.GetCurrentPattern(ValuePattern.Pattern)).SetValue(value);break;
   default:throw new Exception("UNSUPPORTED_ACTION");
  }}else{switch(operation){
   case "focus":c.acc.accSelect(1,c.child);break;
   case "invoke":c.acc.accDoDefaultAction(c.child);break;
   case "select":c.acc.accSelect(2,c.child);break;
   case "setValue":c.acc.set_accValue(c.child,value);break;
   default:throw new Exception("UNSUPPORTED_ACTION");
  }}
  // Wait for observed transition; never repeat the side effect on a timeout.
  var after=WaitForChange(exe,id,before);
  return after;
 }
 // Re-read the SAME window (an app may have several) until the UI changed, then until it stops changing: apps update
 // titles, dirty markers and status text shortly after the visible change, and a snapshot taken mid-update would
 // otherwise look stale to the next verification.
 // Every Observe is a full UI Automation read, which takes seconds on WinUI apps (Windows 11 Notepad, Settings). The wait is
 // bounded by time, not by a number of reads (it used to allow 20 reads), so one action always fits inside the caller's timeout.
 const int ChangeBudgetMs=4000;
 static Snapshot WaitForChange(string exe,string id,Snapshot before){
  var watch=Stopwatch.StartNew();Snapshot after=null;
  do{
   System.Threading.Thread.Sleep(after==null?150:120);
   after=Observe(exe,id,before.windowId,false,before.processId,before.rootWindowId,true);
   if(after.screenFingerprint!=before.screenFingerprint||after.windowId!=before.windowId)break;
  }while(watch.ElapsedMilliseconds<ChangeBudgetMs);
  // One settle read, only while it is cheap: a fast app gets a stable snapshot, a slow app returns the change it showed.
  if(after.screenFingerprint!=before.screenFingerprint&&watch.ElapsedMilliseconds<ChangeBudgetMs/2){
   System.Threading.Thread.Sleep(100);after=Observe(exe,id,after.windowId,false,before.processId,before.rootWindowId,true);
  }
  return after;
 }
 // The control that has keyboard focus, but only if it lives inside the given top-level window of the given process.
 // Focus settles asynchronously, so retry briefly; an app may have several windows in one process.
 static AutomationElement FocusedIn(IntPtr handle,int pid){
  for(int i=0;i<10;i++){
   try{
    var focused=AutomationElement.FocusedElement;
    if(focused!=null&&focused.Current.ProcessId==pid){
     var walker=TreeWalker.ControlViewWalker;var root=AutomationElement.RootElement;var top=focused;
     for(int guard=0;guard<60;guard++){
      if(Handle(top)==handle.ToInt64())return focused;
      var parent=walker.GetParent(top);if(parent==null||parent.Equals(root))break;top=parent;
     }
    }
   }catch{}
   System.Threading.Thread.Sleep(80);
  }
  return null;
 }
 static readonly Dictionary<string,ushort> NamedKeys=new Dictionary<string,ushort>{{"tab",0x09},{"enter",0x0D},{"escape",0x1B},{"space",0x20},{"backspace",0x08},{"delete",0x2E},{"up",0x26},{"down",0x28},{"left",0x25},{"right",0x27},{"home",0x24},{"end",0x23},{"pageup",0x21},{"pagedown",0x22}};
 static readonly HashSet<string> Extended=new HashSet<string>{"up","down","left","right","home","end","pageup","pagedown","delete"};
 static INPUT Key(ushort vk,ushort scan,uint flags){var i=new INPUT{type=1};i.u.ki=new KEYBDINPUT{wVk=vk,wScan=scan,dwFlags=flags,time=0,dwExtraInfo=IntPtr.Zero};return i;}
 static void Dispatch(List<INPUT> items){
  var array=items.ToArray();
  if(SendInput((uint)array.Length,array,Marshal.SizeOf(typeof(INPUT)))!=array.Length)throw new Exception("UI_EXECUTION_UNCERTAIN");
 }
 // Keyboard input into the authorized window only. The target must be the foreground window, the focused control must
 // belong to the same process, and it must not be a password or sensitive field. Text goes only into text controls.
 // kind: "type" (payload = text) or "key" (payload = chord such as ctrl+f). The chord was already classified by the caller;
 // the list below is a second, independent allow-list.
 public static Snapshot Input(string exe,string id,long window,string kind,string payload,string locator,string signature,int expectedPid=0){
  var before=Read(exe,id,window,false,expectedPid,true);
  var handle=new IntPtr(before.windowId);
  var field=before.controls.FirstOrDefault(c=>(kind=="type"?c.locator==locator&&c.signature==signature:c.focused)&&(c.role=="Edit"||c.role=="Document"||c.role=="ComboBox"));
  if(kind=="type"){
   for(int retry=0;field==null&&retry<3;retry++){
    System.Threading.Thread.Sleep(200);before=Read(exe,id,window,false,expectedPid,true);field=before.controls.FirstOrDefault(c=>c.locator==locator&&c.signature==signature&&(c.role=="Edit"||c.role=="Document"||c.role=="ComboBox"));
   }
   if(field==null){if(Environment.GetEnvironmentVariable("CHANAKYA_DEBUG_UI")=="1")Console.Error.WriteLine("TYPE_TARGET_STALE provider="+before.provider+" controls="+before.controls.Length+" locatorPresent="+before.controls.Any(c=>c.locator==locator));throw new Exception("STALE_SNAPSHOT");}
  }
  // ValuePattern edits are scoped to an exact live field and do not require
  // stealing foreground from an elevated or unrelated window. Global input
  // retains the stronger foreground/focused-element checks below.
  AutomationElement focused=kind=="type"?field==null?null:field.uia:null;
  if(kind!="type"||focused==null&&field!=null){
   if(!Focus(handle))throw new Exception("FOCUS_UNVERIFIED");focused=FocusedIn(handle,before.processId);
  }
  if(focused==null)throw new Exception("FOCUS_UNVERIFIED");
  if(kind=="type"&&!field.focused&&!field.directType)throw new Exception("NO_EDITABLE_FOCUS");
  if(focused.Current.IsPassword||Secret.IsMatch(focused.Current.Name??"")||Secret.IsMatch(focused.Current.AutomationId??""))throw new Exception("SENSITIVE_FOCUS");
  var type=focused.Current.ControlType;
  if(kind=="type"&&(field==null||field.locator!=locator||field.signature!=signature))throw new Exception("STALE_SNAPSHOT");
  var items=new List<INPUT>();
  string expectedText=null;
  if(kind=="type"){
   if(type!=ControlType.Edit&&type!=ControlType.Document&&type!=ControlType.ComboBox)throw new Exception("NO_EDITABLE_FOCUS");
   if(String.IsNullOrEmpty(payload)||payload.Length>500)throw new Exception("INVALID_INPUT");
   foreach(char ch in payload)if(ch<0x20||ch==0x7f)throw new Exception("INVALID_INPUT");
   // Prefer the live accessibility value API when the insertion/selection
   // position is known. Preserve all text outside the selection. Keyboard is
   // the fallback, checked before every character to stop on focus changes.
   object valueObject;bool inserted=false;
   if(focused.TryGetCurrentPattern(ValuePattern.Pattern,out valueObject)){
    var vp=(ValuePattern)valueObject;string old=vp.Current.Value??"";int start=old.Length,end=old.Length;bool known=old.Length==0;
    if(type==ControlType.Edit&&focused.Current.NativeWindowHandle!=0&&Regex.IsMatch(focused.Current.ClassName??"","edit",RegexOptions.IgnoreCase)){
     SendMessage(new IntPtr(focused.Current.NativeWindowHandle),0xB0,ref start,ref end);known=start>=0&&end>=start&&end<=old.Length;
    }else{object tpObject;if(focused.TryGetCurrentPattern(TextPattern.Pattern,out tpObject)){
     var tp=(TextPattern)tpObject;var selected=tp.GetSelection();if(selected.Length==1){
      var prefix=tp.DocumentRange.Clone();prefix.MoveEndpointByRange(TextPatternRangeEndpoint.End,selected[0],TextPatternRangeEndpoint.Start);start=prefix.GetText(10001).Length;
      prefix=tp.DocumentRange.Clone();prefix.MoveEndpointByRange(TextPatternRangeEndpoint.End,selected[0],TextPatternRangeEndpoint.End);end=prefix.GetText(10001).Length;known=start>=0&&end>=start&&end<=old.Length;
     }
    }}
    if(known&&!vp.Current.IsReadOnly&&old.Length<=10000){
     if(Hash(old)!=field.valueHash)throw new Exception("STALE_SNAPSHOT");
     expectedText=old.Substring(0,start)+payload+old.Substring(end);vp.SetValue(expectedText);inserted=true;
     if(type==ControlType.Edit&&focused.Current.NativeWindowHandle!=0&&Regex.IsMatch(focused.Current.ClassName??"","edit",RegexOptions.IgnoreCase)){
      var editHandle=new IntPtr(focused.Current.NativeWindowHandle);uint ownerPid;GetWindowThreadProcessId(editHandle,out ownerPid);
      if(ownerPid!=before.processId||GetAncestor(editHandle,2)!=handle)throw new Exception("UI_EXECUTION_UNCERTAIN");
      int caret=start+payload.Length;ControlMessage(editHandle,0xB1,new IntPtr(caret),new IntPtr(caret));
      int actualStart=0,actualEnd=0;SendMessage(editHandle,0xB0,ref actualStart,ref actualEnd);if(actualStart!=caret||actualEnd!=caret)throw new Exception("UI_EXECUTION_UNCERTAIN");
     }
    }
   }
   if(!inserted){
    if(!Focus(handle))throw new Exception("FOCUS_UNVERIFIED");var actual=FocusedIn(handle,before.processId);
    if(actual==null||!actual.GetRuntimeId().SequenceEqual(focused.GetRuntimeId()))throw new Exception("FOCUS_UNVERIFIED");
    foreach(char ch in payload){
     var now=AutomationElement.FocusedElement;
     if(ForegroundRoot()!=handle||now==null||now.Current.ProcessId!=before.processId||!now.GetRuntimeId().SequenceEqual(focused.GetRuntimeId()))throw new Exception("UI_EXECUTION_UNCERTAIN");
     Dispatch(new List<INPUT>{Key(0,ch,0x4),Key(0,ch,0x4|0x2)});System.Threading.Thread.Sleep(15);
   }
   }
   items.Clear();
  }else if(kind=="key"){
   var mods=new List<ushort>();ushort vk=0,namedVk;string keyName=null;
   foreach(var raw in (payload??"").ToLowerInvariant().Split('+')){var part=raw.Trim();
    if(part=="ctrl")mods.Add(0x11);else if(part=="shift")mods.Add(0x10);else if(part=="alt")mods.Add(0x12);
    else if(vk!=0)throw new Exception("INVALID_INPUT");
    else if(part.Length==1&&part[0]>='a'&&part[0]<='z'){vk=(ushort)(0x41+(part[0]-'a'));keyName=part;}
    else if(part.Length==1&&part[0]>='0'&&part[0]<='9'){vk=(ushort)(0x30+(part[0]-'0'));keyName=part;}
    else if(part.Length>=2&&part[0]=='f'&&Regex.IsMatch(part,"^f([1-9]|1[0-2])$")){vk=(ushort)(0x70+int.Parse(part.Substring(1))-1);keyName=part;}
    else if(NamedKeys.TryGetValue(part,out namedVk)){vk=namedVk;keyName=part;}
    else throw new Exception("INVALID_INPUT");}
   if(vk==0)throw new Exception("INVALID_INPUT");
   if(mods.Contains(0x12)&&(keyName=="f4"||keyName=="tab"||keyName=="escape"))throw new Exception("INPUT_REFUSED");
   if(mods.Contains(0x11)&&(keyName=="escape"||mods.Contains(0x12)&&keyName=="delete"))throw new Exception("INPUT_REFUSED");
   uint ext=Extended.Contains(keyName)?1u:0u;
   foreach(var m in mods)items.Add(Key(m,0,0));
   items.Add(Key(vk,0,ext));items.Add(Key(vk,0,ext|0x2));
   for(int i=mods.Count-1;i>=0;i--)items.Add(Key(mods[i],0,0x2));
  }else throw new Exception("UNSUPPORTED_ACTION");
  if(items.Count>0){
   var actual=FocusedIn(handle,before.processId);
   if(ForegroundRoot()!=handle||actual==null||!actual.GetRuntimeId().SequenceEqual(focused.GetRuntimeId()))throw new Exception("FOCUS_UNVERIFIED");
   Dispatch(items);
  }
  var after=WaitForChange(exe,id,before);
  if(kind=="type"){
   var current=after.controls.FirstOrDefault(c=>c.locator==field.locator&&c.provider==field.provider);
   if(current!=null&&current.valueHash!=field.valueHash){object pattern;string value=current.text??"";
    if(current.uia!=null&&current.uia.TryGetCurrentPattern(ValuePattern.Pattern,out pattern))value=((ValuePattern)pattern).Current.Value??"";
    else if(current.uia!=null&&current.uia.TryGetCurrentPattern(TextPattern.Pattern,out pattern))value=((TextPattern)pattern).DocumentRange.GetText(10000);
    else if(current.acc!=null)try{value=current.acc.get_accValue(current.child)??value;}catch{}
    after.inputVerified=expectedText!=null?current.valueHash==Hash(expectedText):value.Contains(payload);
   }
  }
  return after;
 }
}
