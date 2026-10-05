using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Automation;
using Accessibility;

// App-neutral Windows accessibility backend. All targets are re-read under the
// caller's desktop mutex immediately before mutation. No shell or model keys.
public static class DesktopAccessibility {
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from,uint to,bool attach);
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 // Windows refuses SetForegroundWindow from a process that did not receive the last input. Sharing the input queue of
 // the current foreground window's thread for the duration of the call is the documented, side-effect-free workaround.
 static bool Focus(IntPtr h){
  for(int attempt=0;attempt<6;attempt++){
   if(GetForegroundWindow()==h)return true;
   uint pid;uint foregroundThread=GetWindowThreadProcessId(GetForegroundWindow(),out pid),self=GetCurrentThreadId();bool attached=false;
   try{if(foregroundThread!=0&&foregroundThread!=self)attached=AttachThreadInput(self,foregroundThread,true);ShowWindow(h,9);BringWindowToTop(h);SetForegroundWindow(h);}
   finally{if(attached)AttachThreadInput(self,foregroundThread,false);}
   System.Threading.Thread.Sleep(60);
  }
  return GetForegroundWindow()==h;
 }
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h,int n);
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
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr p);
 static readonly Regex Secret=new Regex(@"password|passcode|credential|one.time|verification code|security code|credit.?card|card.?number|\bcvv\b|\bpin\b|\botp\b|api.?key|access.?token|secret|sign.?in|log.?in",RegexOptions.IgnoreCase);
 public class Control {
  public string locator,signature,provider,label,role,automationId,parentId,shortcut,valueHash;
  public string[] actions;
  public bool enabled,selected,focused;
  public double x,y,width,height;
  internal AutomationElement uia;
  internal IAccessible acc;
  internal object child;
 }
 public class Snapshot {
  public bool success=true;
  public int processId;
  public long windowId;
  public string windowTitle,provider,screenFingerprint;
  public bool truncated;
  public Control[] controls;
 }
 static string Hash(string s){using(var h=SHA256.Create())return BitConverter.ToString(h.ComputeHash(Encoding.UTF8.GetBytes(s??""))).Replace("-","").ToLowerInvariant();}
 static string Short(string s){s=s??"";return s.Length>300?s.Substring(0,300):s;}
 static string Aumid(int pid){var p=OpenProcess(0x1000,false,pid);if(p==IntPtr.Zero)return "";try{uint n=0;GetApplicationUserModelId(p,ref n,null);if(n==0||n>2048)return "";var s=new StringBuilder((int)n);return GetApplicationUserModelId(p,ref n,s)==0?s.ToString():"";}finally{CloseHandle(p);}}
 static bool Identity(AutomationElement w,string exe,string id){try{int pid=w.Current.ProcessId;if(!String.IsNullOrEmpty(id)&&Aumid(pid)==id)return true;return !String.IsNullOrEmpty(exe)&&String.Equals(Process.GetProcessById(pid).MainModule.FileName,exe,StringComparison.OrdinalIgnoreCase);}catch{return false;}}
 static long Handle(AutomationElement w){try{return w.Current.NativeWindowHandle;}catch{return 0;}}
 // Opt-in diagnostics (CHANAKYA_DEBUG_UI=1) for window selection failures; never includes control text.
 static void Trace(string why,long requested,int expectedPid,List<AutomationElement> found){
  if(Environment.GetEnvironmentVariable("CHANAKYA_DEBUG_UI")!="1")return;
  Console.Error.WriteLine(why+" requested="+requested+" expectedPid="+expectedPid+" foreground="+GetForegroundWindow().ToInt64()+" candidates="+String.Join(",",found.Select(w=>{try{return Handle(w)+"/pid"+w.Current.ProcessId;}catch{return "?";}})));
 }
 static AutomationElement Window(string exe,string id,long requested,int expectedPid){
  var all=AutomationElement.RootElement.FindAll(TreeScope.Children,Condition.TrueCondition);var matches=new List<AutomationElement>();
  foreach(AutomationElement w in all){try{
   if(Identity(w,exe,id)&&(expectedPid==0||w.Current.ProcessId==expectedPid))matches.Add(w);
   else if(!String.IsNullOrEmpty(id)) {
    var children=w.FindAll(TreeScope.Children,Condition.TrueCondition);
    foreach(AutomationElement c in children)if(Identity(c,exe,id)&&(expectedPid==0||w.Current.ProcessId==expectedPid)){matches.Add(w);break;}
   }
  }catch{}
  }
  var candidates=matches.ToList();
  if(requested!=0){matches=matches.Where(w=>Handle(w)==requested).ToList();}
  if(matches.Count==0){Trace("WINDOW_NOT_FOUND",requested,expectedPid,candidates);throw new Exception("WINDOW_NOT_FOUND");}
  var fg=GetForegroundWindow().ToInt64();var active=matches.Where(w=>Handle(w)==fg).ToList();
  if(active.Count==1)return active[0];
  if(matches.Count!=1){Trace("AMBIGUOUS_WINDOW",requested,expectedPid,matches);throw new Exception("AMBIGUOUS_WINDOW");}return matches[0];
 }
 static void Seal(Control c){c.signature=Hash(String.Join("|",new[]{c.provider,c.locator,c.label,c.role,c.automationId,c.parentId,c.shortcut,c.enabled.ToString(),c.selected.ToString(),c.valueHash,String.Join(",",c.actions)}));}
 static void UiaChildren(AutomationElement root,List<Control> controls){
  var queue=new Queue<Tuple<AutomationElement,string,int>>();queue.Enqueue(Tuple.Create(root,"",0));var walker=TreeWalker.ControlViewWalker;int visited=0;
  while(queue.Count>0&&visited<500){var n=queue.Dequeue();if(n.Item3>=12)continue;AutomationElement c=null;try{c=walker.GetFirstChild(n.Item1);}catch{continue;}
   while(c!=null&&visited++<500){try{
    var p=c.Current;string label=Short(p.Name),aid=Short(p.AutomationId);bool secret=p.IsPassword||Secret.IsMatch(label+" "+aid)||(p.LabeledBy!=null&&Secret.IsMatch(p.LabeledBy.Current.Name));
    if(!p.IsOffscreen&&!secret){
     string locator=String.Join(".",c.GetRuntimeId());var actions=new List<string>();object pattern;
     bool selected=false;
     if(p.IsKeyboardFocusable)actions.Add("focus");
     if(c.TryGetCurrentPattern(ScrollPattern.Pattern,out pattern)&&((ScrollPattern)pattern).Current.VerticallyScrollable){actions.Add("scrollDown");actions.Add("scrollUp");}
     if(c.TryGetCurrentPattern(InvokePattern.Pattern,out pattern))actions.Add("invoke");
     if(c.TryGetCurrentPattern(ExpandCollapsePattern.Pattern,out pattern)){actions.Add("expand");actions.Add("collapse");}
     if(c.TryGetCurrentPattern(SelectionItemPattern.Pattern,out pattern)){actions.Add("select");selected=((SelectionItemPattern)pattern).Current.IsSelected;}
     if(c.TryGetCurrentPattern(TogglePattern.Pattern,out pattern)){actions.Add("toggle");selected=((TogglePattern)pattern).Current.ToggleState==ToggleState.On;}
     string valueHash="";
     if(c.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)){var v=((ValuePattern)pattern).Current;valueHash=Hash(v.Value);if(!v.IsReadOnly)actions.Add("setValue");}
     var r=p.BoundingRectangle;var item=new Control{provider="UIA",locator=locator,label=label,automationId=aid,role=p.ControlType.ProgrammaticName.Replace("ControlType.",""),parentId=n.Item2,enabled=p.IsEnabled,selected=selected,focused=p.HasKeyboardFocus,shortcut=Short(p.AcceleratorKey),valueHash=valueHash,actions=actions.ToArray(),x=r.IsEmpty?0:r.X,y=r.IsEmpty?0:r.Y,width=r.IsEmpty?0:r.Width,height=r.IsEmpty?0:r.Height,uia=c};Seal(item);controls.Add(item);
     queue.Enqueue(Tuple.Create(c,locator,n.Item3+1));
    }
   }catch{}try{c=walker.GetNextSibling(c);}catch{break;}}
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
   var c=new Control{provider="MSAA",locator=locator,label=label,role=Role(role),automationId="",parentId=parent,enabled=(state&1)==0,selected=(state&2)!=0,focused=(state&4)!=0,shortcut=Short(a.get_accKeyboardShortcut(child)),valueHash=role==42?Hash(a.get_accValue(child)):"",actions=actions.ToArray(),x=x,y=y,width=w,height=h,acc=a,child=child};Seal(c);result.Add(c);
   if(!(child is int)||Convert.ToInt32(child)!=0)return;
   int count=Math.Min(a.accChildCount,500-visited);if(count<=0)return;object[] items=new object[count];int got;
   if(AccessibleChildren(a,0,count,items,out got)<0)return;
   for(int i=0;i<got;i++){var sub=items[i] as IAccessible;if(sub!=null)Msaa(sub,0,locator+"/"+i,locator,result,depth+1,ref visited);else if(items[i] is int)Msaa(a,items[i],locator+"/"+i,locator,result,depth+1,ref visited);}
  }catch{}
 }
 public static Snapshot Read(string exe,string id,long requested,bool focus,int expectedPid=0){
  var root=Window(exe,id,requested,expectedPid);var handle=new IntPtr(root.Current.NativeWindowHandle);
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
  return new Snapshot{windowId=handle.ToInt64(),processId=root.Current.ProcessId,windowTitle=Short(root.Current.Name),provider=provider,controls=controls.ToArray(),truncated=controls.Count>=499,screenFingerprint=Hash(String.Join(";",controls.Select(c=>c.signature)))};
 }
 public static Snapshot Act(string exe,string id,long window,string fingerprint,string locator,string signature,string operation,string value){
  var before=Read(exe,id,window,false);
  // Read() resolves all native references again. The exact control and parent
  // context signatures below must still match before the single mutation.
  var found=before.controls.Where(item=>item.locator==locator&&item.signature==signature).ToArray();
  if(found.Length!=1)throw new Exception("STALE_SNAPSHOT");
  if(!found[0].enabled||!found[0].actions.Contains(operation))throw new Exception("UNGROUNDED_ACTION");
  var c=found[0];
  if(c.uia!=null){switch(operation){
   case "focus":c.uia.SetFocus();break;
   case "collapse":((ExpandCollapsePattern)c.uia.GetCurrentPattern(ExpandCollapsePattern.Pattern)).Collapse();break;
   case "scrollDown":((ScrollPattern)c.uia.GetCurrentPattern(ScrollPattern.Pattern)).Scroll(ScrollAmount.NoAmount,ScrollAmount.SmallIncrement);break;
   case "scrollUp":((ScrollPattern)c.uia.GetCurrentPattern(ScrollPattern.Pattern)).Scroll(ScrollAmount.NoAmount,ScrollAmount.SmallDecrement);break;
   case "invoke":((InvokePattern)c.uia.GetCurrentPattern(InvokePattern.Pattern)).Invoke();break;
   case "expand":((ExpandCollapsePattern)c.uia.GetCurrentPattern(ExpandCollapsePattern.Pattern)).Expand();break;
   case "select":((SelectionItemPattern)c.uia.GetCurrentPattern(SelectionItemPattern.Pattern)).Select();break;
   case "toggle":((TogglePattern)c.uia.GetCurrentPattern(TogglePattern.Pattern)).Toggle();break;
   case "setValue":((ValuePattern)c.uia.GetCurrentPattern(ValuePattern.Pattern)).SetValue(value);break;
   default:throw new Exception("UNSUPPORTED_ACTION");
  }}else{switch(operation){
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
 static Snapshot WaitForChange(string exe,string id,Snapshot before){
  Snapshot after=null;
  for(int i=0;i<12;i++){System.Threading.Thread.Sleep(125);after=Read(exe,id,before.windowId,false,before.processId);if(after.screenFingerprint!=before.screenFingerprint)break;}
  for(int i=0;i<8;i++){System.Threading.Thread.Sleep(100);var again=Read(exe,id,before.windowId,false,before.processId);if(again.screenFingerprint==after.screenFingerprint)break;after=again;}
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
     for(int guard=0;guard<60;guard++){var parent=walker.GetParent(top);if(parent==null||parent.Equals(root))break;top=parent;}
     if(Handle(top)==handle.ToInt64())return focused;
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
  if(SendInput((uint)array.Length,array,Marshal.SizeOf(typeof(INPUT)))!=array.Length)throw new Exception("INPUT_BLOCKED");
 }
 // Keyboard input into the authorized window only. The target must be the foreground window, the focused control must
 // belong to the same process, and it must not be a password or sensitive field. Text goes only into text controls.
 // kind: "type" (payload = text) or "key" (payload = chord such as ctrl+f). The chord was already classified by the caller;
 // the list below is a second, independent allow-list.
 public static Snapshot Input(string exe,string id,long window,string kind,string payload){
  var before=Read(exe,id,window,true);
  var handle=new IntPtr(before.windowId);
  if(!Focus(handle))throw new Exception("FOCUS_UNVERIFIED");
  var focused=FocusedIn(handle,before.processId);
  if(focused==null)throw new Exception("FOCUS_UNVERIFIED");
  if(focused.Current.IsPassword||Secret.IsMatch(focused.Current.Name??"")||Secret.IsMatch(focused.Current.AutomationId??""))throw new Exception("SENSITIVE_FOCUS");
  var type=focused.Current.ControlType;
  var items=new List<INPUT>();
  if(kind=="type"){
   if(type!=ControlType.Edit&&type!=ControlType.Document&&type!=ControlType.ComboBox)throw new Exception("NO_EDITABLE_FOCUS");
   if(String.IsNullOrEmpty(payload)||payload.Length>500)throw new Exception("INVALID_INPUT");
   foreach(char ch in payload)if(ch<0x20||ch==0x7f)throw new Exception("INVALID_INPUT");
   // Modern text boxes (WinUI/XAML) drop or corrupt characters sent in one burst, so send one character at a time.
   foreach(char ch in payload){Dispatch(new List<INPUT>{Key(0,ch,0x4),Key(0,ch,0x4|0x2)});System.Threading.Thread.Sleep(15);}
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
   uint ext=Extended.Contains(keyName)?1u:0u;
   foreach(var m in mods)items.Add(Key(m,0,0));
   items.Add(Key(vk,0,ext));items.Add(Key(vk,0,ext|0x2));
   for(int i=mods.Count-1;i>=0;i--)items.Add(Key(mods[i],0,0x2));
  }else throw new Exception("UNSUPPORTED_ACTION");
  if(items.Count>0)Dispatch(items);
  var after=WaitForChange(exe,id,before);
  return after;
 }
}
