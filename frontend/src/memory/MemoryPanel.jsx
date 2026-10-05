import React, {useEffect,useState} from 'react';
import {memories as api} from '../services/api.js';

export default function MemoryPanel() {
 const [tab,setTab]=useState('long'),[rows,setRows]=useState([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [editing,setEditing]=useState(null),[key,setKey]=useState(''),[value,setValue]=useState(''),[category,setCategory]=useState('preference');
 const [query,setQuery]=useState('');
 const load=async()=>{const {data}=await (tab==='long'?api.longTerm():api.get());setRows(data.memories||[]);};
 useEffect(()=>{let active=true;setRows([]);setEditing(null);setError('');setBusy(true);(tab==='long'?api.longTerm():api.get()).then(r=>{if(active)setRows(r.data.memories||[]);}).catch(()=>{if(active)setError('Unable to load memory.');}).finally(()=>{if(active)setBusy(false);});return ()=>{active=false;};},[tab]);
 const act=async operation=>{setBusy(true);setError('');try{await operation();await load();}catch(e){setError(e.response?.data?.error||'Memory was not saved. Credentials, unsafe instructions and execution permissions are not accepted.');}finally{setBusy(false);}};
 const save=event=>{event.preventDefault();act(async()=>{const response=editing?await api.updateLongTerm(editing,{value,category}):await api.saveLongTerm({key,value,category});if(!response.data.memory)throw new Error('Not saved');setEditing(null);setKey('');setValue('');});};
 const input='w-full rounded-lg bg-zinc-900 border border-white/10 p-2 text-sm';
 return <section className="h-full overflow-y-auto p-5 bg-[#0c0c0e] text-stone-200 space-y-4">
  <h2 className="text-lg font-semibold">Memory</h2>
  <p className="text-sm text-stone-400">Saved facts stay on this computer. Relevant context can help future conversations, but never grants permission to run tools or repairs.</p>
  <div className="flex gap-3" role="tablist"><button role="tab" aria-selected={tab==='long'} onClick={()=>setTab('long')}>Long-term memory</button><button role="tab" aria-selected={tab==='legacy'} onClick={()=>setTab('legacy')}>Previous saved entries</button></div>
  {error&&<p role="alert" className="text-red-400">{error}</p>}
  {tab==='long'?<form onSubmit={save} className="space-y-2">
   <label className="block">Fact name<input className={input} value={key} disabled={!!editing||busy} onChange={e=>setKey(e.target.value)} placeholder="preferred_language" maxLength={100} required pattern="[a-z][a-z0-9_.-]*" /></label>
   <label className="block">Value<textarea className={input} value={value} onChange={e=>setValue(e.target.value)} placeholder="Tamil" maxLength={2000} required disabled={busy}/></label>
   <label className="block">Category<select className={input} value={category} onChange={e=>setCategory(e.target.value)} disabled={busy}>{['preference','fact','project','workflow'].map(c=><option key={c}>{c}</option>)}</select></label>
   <button className="rounded bg-blue-600 px-3 py-2" disabled={busy} type="submit">{editing?'Save changes':'Save memory'}</button>
   {editing&&<button type="button" onClick={()=>{setEditing(null);setKey('');setValue('');}}>Cancel edit</button>}
  </form>:<p className="text-sm text-stone-400">These older entries remain available for review. They are not automatically used as long-term memory. Save a fact explicitly in the Long-term memory tab to use it.</p>}
  <label className="block">Search<input className={input} value={query} onChange={e=>setQuery(e.target.value)}/></label>
  {busy&&<p role="status">Loading...</p>}
  <ul className="space-y-3">{rows.filter(r=>`${r.key||''} ${r.value||r.content}`.toLowerCase().includes(query.toLowerCase())).map(r=><li key={r.id} className="rounded border border-white/10 p-3">
   <strong>{r.key||r.type}</strong><p className="whitespace-pre-wrap break-words">{r.value||r.content}</p>
   {tab==='long'&&<button disabled={busy} className="mr-4" onClick={()=>{setEditing(r.id);setKey(r.key);setValue(r.value);setCategory(r.category);}}>Edit</button>}
   <button disabled={busy} className="text-red-400" onClick={()=>act(()=>tab==='long'?api.deleteLongTerm(r.id):api.delete(r.id))}>Delete</button>
  </li>)}</ul>
  {!busy&&!rows.length&&<p>No saved memories.</p>}
 </section>;
}
