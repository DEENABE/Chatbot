import fs from 'node:fs';
import {AppDiscoveryService} from '../tools/apps/AppDiscoveryService.js';
import {AppResolverService,normalizeAppName} from '../tools/apps/AppResolverService.js';
const output=process.argv[2]||'outputs/resolver-benchmark.json';
const discovered=process.argv[3]?JSON.parse(fs.readFileSync(process.argv[3])):await new AppDiscoveryService().discover();
fs.writeFileSync(output.replace(/\.json$/,'.registry.json'),JSON.stringify(discovered,null,2));
const apps=discovered.apps.filter(a=>a.available),resolver=new AppResolverService(),selected=apps.filter(a=>normalizeAppName(a.name).length>=4).sort((a,b)=>a.name.localeCompare(b.name)).slice(0,40);
const variants=name=>{const q=normalizeAppName(name),indices=[...q].map((c,i)=>/[a-z]/i.test(c)?i:-1).filter(i=>i>=0),i=indices[Math.floor(indices.length/2)]??0,j=indices[Math.max(0,Math.floor(indices.length/3))]??0;
 let swap=i;if(swap>=q.length-1||q[swap]===' '||q[swap+1]===' ')swap=Math.max(0,indices.find(k=>k<q.length-1&&q[k+1]!==' '&&q[k]!==q[k+1])??0);
 const sub=c=>c==='x'?'z':'x';
 return {exact:name,deletion:q.slice(0,i)+q.slice(i+1),insertion:q.slice(0,i)+'x'+q.slice(i),substitution:q.slice(0,i)+sub(q[i])+q.slice(i+1),transposition:q.slice(0,swap)+q[swap+1]+q[swap]+q.slice(swap+2),spacing:q.replaceAll(' ','').split('').join(' '),case:name.toUpperCase(),twoEdit:q.slice(0,j)+sub(q[j])+q.slice(j+1,i)+sub(q[i])+q.slice(i+1)};};
const rows=[];
for(const app of selected)for(const [variant,query] of Object.entries(variants(app.name))){const r=resolver.resolve(query,apps);rows.push({name:app.name,id:app.id,variant,query,selected:r.app?.name,selectedId:r.app?.id,correct:r.app?.id===app.id,wrong:r.success&&r.app?.id!==app.id,code:r.code,score:r.score,margin:r.margin});}
const metric=variants=>{const part=rows.filter(r=>variants.includes(r.variant));return {correct:part.filter(r=>r.correct).length,total:part.length,accuracy:part.filter(r=>r.correct).length/Math.max(1,part.length)};};
let seed=87123;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};const unknown=[];
for(let i=0;i<200;i++){const q=Array.from({length:8+random()%8},()=>String.fromCharCode(97+random()%26)).join('');const r=resolver.resolve(q,apps);unknown.push({query:q,code:r.code,selected:r.app?.name});}
const ambiguous=[{query:'team',names:['Microsoft Teams','Teams Classic','TeamViewer']},{query:'studio',names:['Visual Studio','Visual Studio Code','Android Studio']},{query:'Zorvex',names:['Zorvex Editor','Zorvex Viewer']},{query:'Duplicate',names:['Duplicate','Duplicate']}].map(({query,names})=>{const r=resolver.resolve(query,names.map((name,i)=>({id:String(i),name,available:true})));return {query,code:r.code,correct:r.code==='APP_AMBIGUOUS'};});
const uniqueRows=rows.filter(r=>apps.filter(a=>normalizeAppName(a.name)===normalizeAppName(r.name)).length===1);const uniqueMetric=types=>{const part=uniqueRows.filter(r=>types.includes(r.variant));return {correct:part.filter(r=>r.correct).length,total:part.length,accuracy:part.filter(r=>r.correct).length/Math.max(1,part.length)};};
const metrics={uniqueNameExact:uniqueMetric(['exact']),uniqueNameOneEdit:uniqueMetric(['deletion','insertion','substitution','transposition']),uniqueNameTwoEdit:uniqueMetric(['twoEdit']),applications:selected.length,exact:metric(['exact']),oneEdit:metric(['deletion','insertion','substitution','transposition']),twoEdit:metric(['twoEdit']),spacing:metric(['spacing']),case:metric(['case']),ambiguity:{correct:ambiguous.filter(r=>r.correct).length,total:ambiguous.length},unknown:{rejected:unknown.filter(r=>r.code==='APP_NOT_FOUND').length,total:unknown.length},wrongSelections:rows.filter(r=>r.wrong).length,unknownSelections:unknown.filter(r=>r.selected).length};
fs.writeFileSync(output,JSON.stringify({metrics,sourceErrors:discovered.errors,rows,unknown,ambiguous},null,2));console.log(JSON.stringify(metrics,null,2));
