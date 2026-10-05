/** Run with the packaged executable and ELECTRON_RUN_AS_NODE=1.
 * Uses a temporary database and ephemeral ports; never launches a repair. */
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const {randomUUID}=require('node:crypto');
async function main() {
  const output=path.resolve(process.argv[2]);
  const appRoot=path.join(output,'resources','app'),backend=path.join(output,'resources','backend');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'chanakya-release-smoke-'));
  process.env.APP_DATA_PATH=root;
  const load=file=>import(pathToFileURL(file).href);
  const {app}=await load(path.join(backend,'src','app.js'));
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  let bridge;
  try {
    assert.equal((await fetch(base+'/api/auth/me')).status,401);
    const registered=await fetch(base+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'release-fixture',displayName:'Release fixture',password:'Temporary-'+randomUUID()})});
    assert.equal(registered.status,201);
    const {token,user}=await registered.json();
    assert.equal((await fetch(base+'/api/auth/me',{headers:{authorization:`Bearer ${token}`}})).status,200);
    const {ToolEngineRouter}=await load(path.join(appRoot,'tools','ToolEngineRouter.js'));
    const {ExecutionLedger}=await load(path.join(appRoot,'tools','ExecutionLedger.js'));
    const {createToolBridgeServer}=await load(path.join(appRoot,'electron','ipc','toolBridgeServer.js'));
    const router=new ToolEngineRouter({pathOptions:{readRoots:[root],writeRoots:[root]},auditDirectory:path.join(root,'audit')});
    const ledger=new ExecutionLedger({dispatch:r=>router.dispatch(r)});ledger.toolRegistry=router.registry;
    bridge=await createToolBridgeServer(ledger);
    const file=path.join(root,'ordinary.txt');
    const call=(tool,action,params)=>{const id=randomUUID();return ledger.execute(`backend:${user.id}`,{tool,action,params,toolCallId:id,requestId:id,idempotencyKey:id});};
    assert.equal((await call('file','createTextFile',{path:file,content:'packaged fixture'})).success,true);
    assert.equal((await call('file','readFile',{path:file})).data.content,'packaged fixture');
    assert.equal((await call('security','disableDefender',{})).success,false);
    assert.equal((await call('powershell','execute',{command:'Write-Output nope'})).success,false);
    assert.equal((await call('unknown','execute',{})).success,false);
    assert.equal((await fetch(bridge.url+'/mcp',{method:'POST',body:'{}'})).status,401);
    const mcp=await fetch(bridge.url+'/mcp',{method:'POST',headers:{authorization:`Bearer ${bridge.secret}`,'x-execution-owner':user.id},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'file.readFile',arguments:{path:file}}})});
    assert.equal((await mcp.json()).result.isError,false);
    console.log(JSON.stringify({result:'passed',runtime:process.versions.electron,checks:['backend-load-and-migrations','session-authentication','safe-write','read','critical-denial','shell-denial','unknown-denial','MCP-authentication','MCP-read'],userData:'temporary test database only'}));
  } finally {
    bridge?.server.closeAllConnections();bridge?.server.close();
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
}
main().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
