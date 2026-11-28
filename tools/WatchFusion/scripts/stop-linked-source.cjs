'use strict';
// Terminal only. No browser automation, secret printing, retries, or reloads.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{pathToFileURL}=require('node:url');
const need=(v,code)=>{if(!v)throw Error(code);};
const same=(a,b)=>a?.extensionId===b?.extensionId&&a?.instance===b?.instance&&a?.build===b?.build&&a?.version===b?.version&&JSON.stringify(a?.hashes)===JSON.stringify(b?.hashes)&&a?.nonce!==b?.nonce;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function unlink({repo,confirm,attest,request,controller,credential,delay=wait}){
  need(confirm==='CONFIRMED_WATCHFUSION_AUTO_UNLINK','UNLINK_CONSENT_REQUIRED');
  const before=await attest();need(before?.schema===1&&typeof before.linked==='boolean','BRIDGE_UNVERIFIED');
  if(!before.linked)return {status:'already-unlinked'};
  const c=await controller(),key=await credential();
  need(c?.ok===true&&c?.controllerAvailable===true&&c.service==='watchfusion-control'&&c.state==='running'&&c.running===true&&Array.isArray(c.pids)&&c.pids.includes(key.pid)&&c.port===key.port,'SERVICE_IDENTITY_UNVERIFIED');
  need(key.schema===1&&/^[a-f0-9]{64}$/.test(key.secret||'')&&/^[a-f0-9]{64}$/.test(key.instance||''),'LOCAL_CAPABILITY_INVALID');
  const prepare=await request(key,{action:'prepare',instance:key.instance,extensionId:before.extensionId});
  need(prepare?.ok===true&&prepare.pid===key.pid&&prepare.instance===key.instance&&/^[a-f0-9]{64}$/.test(prepare.lease||''),'UNLINK_PREPARE_REFUSED');
  const fresh=await attest();need(same(before,fresh)&&fresh.linked===true,'BRIDGE_CHANGED_BEFORE_UNLINK');
  const current=await controller();need(current?.ok===true&&current?.running===true&&current?.port===key.port&&current?.pids?.includes(key.pid),'SERVICE_CHANGED_BEFORE_UNLINK');
  let dispatched=false;
  try{const result=await request(key,{action:'unlink',instance:key.instance,extensionId:before.extensionId,lease:prepare.lease});need(result?.ok===true&&result.dispatched===true&&result.pid===key.pid&&result.instance===key.instance,'UNLINK_ACK_UNVERIFIED');dispatched=true;}
  catch{throw Error('UNLINK_DISPATCH_UNCERTAIN_NO_REPLAY');}
  let last=fresh;
  for(let i=0;i<16;i++){
    await delay(500);const after=await attest();need(same(last,after)&&same(before,after),'BRIDGE_CHANGED_AFTER_UNLINK');
    if(!after.linked){await delay(350);const proof=await attest();need(same(after,proof)&&same(before,proof)&&proof.linked===false,'SOURCE_RELINKED_OR_WITNESS_CHANGED');return {status:'unlinked',dispatched,verified:true};}last=after;
  }
  throw Error('SOURCE_CLEANUP_UNVERIFIED_NO_REPLAY');
}
// Node fetch supplies browser-like Sec-Fetch headers; use raw loopback HTTP for this terminal-only capability.
function terminalRequest(port,secret,body){return new Promise((resolve,reject)=>{const data=JSON.stringify(body),r=http.request({hostname:'127.0.0.1',port,path:'/api/live/maintenance-unlink',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),'x-wf-maintenance-key':secret,Connection:'close'},timeout:5000},res=>{let b='';res.setEncoding('utf8');res.on('data',x=>{b+=x;if(b.length>4096)r.destroy(Error('LOCAL_RESPONSE_LIMIT'));});res.on('end',()=>{try{need(res.statusCode===200,'LOCAL_CONTROL_REFUSED');resolve(JSON.parse(b));}catch(e){reject(e);}});res.on('error',reject);});r.on('timeout',()=>r.destroy(Error('LOCAL_CONTROL_TIMEOUT')));r.on('error',reject);r.end(data);});}
async function main(){
  const repo=fs.realpathSync(path.resolve(__dirname,'../../..')),wf=path.join(repo,'tools/WatchFusion');
  const ports=JSON.parse(fs.readFileSync(path.join(repo,'config/eveos-ports.json'),'utf8')).ports,port=ports.WATCHFUSION_PORT.port,ctl=ports.GEMINI_CONTROL_PORT.port;
  need([port,ctl].every(x=>Number.isInteger(x)&&x>0&&x<=65535)&&port!==ctl,'PORT_REGISTRY_INVALID');
  const {credentialPath}=await import(pathToFileURL(path.join(wf,'src/server/maintenance-unlink.js')).href);
  const A=require(path.join(repo,'tools/extensions/bridge-activation.cjs'));
  const get=async(url,opts={})=>{const r=await fetch(url,{...opts,redirect:'error',signal:AbortSignal.timeout(5000)});need(r.ok,'LOCAL_CONTROL_REFUSED');return r.json();};
  const result=await unlink({repo,confirm:process.argv[2],attest:()=>A.verifyInstalled(repo),controller:()=>get(`http://127.0.0.1:${ctl}/api/watchfusion/status`),
    credential:()=>{const f=credentialPath(wf,port);need(fs.lstatSync(f).isFile()&&!fs.lstatSync(f).isSymbolicLink(),'LOCAL_CAPABILITY_INVALID');return JSON.parse(fs.readFileSync(f,'utf8'));},
    request:(key,body)=>terminalRequest(port,key.secret,body)});
  console.log(JSON.stringify(result));
}
module.exports={unlink,terminalRequest};
if(require.main===module)main().catch(e=>{console.error(/^[A-Z0-9_]+$/.test(e.message)?e.message:'AUTO_UNLINK_BLOCKED_NO_REPLAY');process.exitCode=2;});
