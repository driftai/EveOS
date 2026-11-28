// A process-local capability for the terminal operator. Never grant browser or LAN authority.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const random = () => crypto.randomBytes(32).toString('hex');
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const sameSecret = (a,b) => hex(a) && hex(b) && crypto.timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
const address = value => String(value || '').toLowerCase().replace(/^::ffff:/,'');
export function credentialPath(root,port,base=process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || path.join(os.homedir(),'.local','share')) {
  if (!path.isAbsolute(base) || !Number.isInteger(port) || port<1 || port>65535) throw Error('PRIVATE_CONTROL_PATH_INVALID');
  const canonical=fs.realpathSync(root), key=sha(process.platform==='win32'?canonical.toLowerCase():canonical).slice(0,32);
  return path.join(base,'EveOS','Private','WatchFusion-Maintenance-v1',key,`${port}.json`);
}
export function directTerminalRequest(req,port) {
  const h=req.headers || {};
  return req.method==='POST' && req.url==='/api/live/maintenance-unlink' && h.host===`127.0.0.1:${port}` &&
    ['127.0.0.1','::1'].includes(address(req.socket?.remoteAddress)) &&
    !Object.keys(h).some(k=>k==='origin'||k==='referer'||k==='forwarded'||k==='via'||k.startsWith('sec-fetch-')||k.startsWith('x-forwarded-')||k.startsWith('cf-'));
}
export function publisherProvenance(req) {
  const h=req?.headers||{}, a=address(req?.socket?.remoteAddress), b=address(req?.socket?.localAddress);
  const match=/^chrome-extension:\/\/([a-p]{32})$/.exec(String(h.origin||''));
  const local=!!a&&!!b&&(a===b||(['127.0.0.1','::1'].includes(a)&&['127.0.0.1','::1'].includes(b))) &&
    !Object.keys(h).some(k=>k==='forwarded'||k==='via'||k.startsWith('x-forwarded-')||k.startsWith('cf-'));
  return match&&local?match[1]:null;
}
// All selection is server-owned; neither a caller-supplied stream ID nor a
// browser's reported media URL can choose a source. No token is ever returned.
export function createUnlinkControl({secret,instance,port,streams,eligible,dispose,clock=Date.now,makeLease=random}) {
  let pending=null;
  const deny=(code,status=409)=>({status,body:{ok:false,code}});
  const matches=id=>[...streams.values()].filter(s=>eligible(s,id));
  function authorized(req){return directTerminalRequest(req,port)&&sameSecret(req.headers['x-wf-maintenance-key'],secret);}
  function execute(req,body){
    if(!authorized(req))return deny('MAINTENANCE_AUTH_REQUIRED',403);
    if(!body||typeof body!=='object'||body.instance!==instance||!/^([a-p]{32})$/.test(body.extensionId||''))return deny('MAINTENANCE_INSTANCE_MISMATCH');
    if(body.action==='prepare'){
      pending=null;const selected=matches(body.extensionId);
      if(selected.length!==1)return deny(selected.length?'SOURCE_AMBIGUOUS':'SOURCE_NOT_FOUND');
      const stream=selected[0],lease=makeLease();pending={lease,stream,publisher:stream.publisher,extensionId:body.extensionId,until:clock()+8000};
      return {status:200,body:{ok:true,lease,instance,pid:process.pid}};
    }
    if(body.action!=='unlink')return deny('MAINTENANCE_ACTION_INVALID',400);
    const p=pending;pending=null; // consume even on a mismatch; never retry a dispatch.
    if(!p||p.until<clock()||!sameSecret(body.lease,p.lease)||p.extensionId!==body.extensionId)return deny('MAINTENANCE_LEASE_INVALID');
    const selected=matches(p.extensionId);
    if(selected.length!==1||selected[0]!==p.stream||p.publisher!==p.stream.publisher)return deny('SOURCE_CHANGED');
    dispose(p.stream);
    return {status:200,body:{ok:true,dispatched:true,instance,pid:process.pid}};
  }
  return {authorized,execute};
}
function verifyPrivateDirectory(dir){
  for(let p=dir;;p=path.dirname(p)){if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw Error('PRIVATE_CONTROL_LINK_FORBIDDEN');if(p===path.dirname(p))break;}
}
export function attachMaintenanceUnlink(server,{root,streams,eligible,dispose}) {
  let control=null,file=null,record=null;
  server.once('listening',()=>{
    try {
      const port=server.address().port;file=credentialPath(root,port);verifyPrivateDirectory(path.dirname(file));
      fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});verifyPrivateDirectory(path.dirname(file));
      if(fs.existsSync(file)&&(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink()))throw Error('PRIVATE_CONTROL_FILE_INVALID');
      record={schema:1,pid:process.pid,port,instance:random(),secret:random()};
      const tmp=file+'.'+random()+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify(record),{flag:'wx',mode:0o600});fs.renameSync(tmp,file);}finally{try{fs.rmSync(tmp,{force:true});}catch{}}
      control=createUnlinkControl({...record,streams,eligible,dispose});
    }catch{control=null;console.warn('WatchFusion local maintenance capability unavailable');}
  });
  server.once('close',()=>{control=null;try{if(record&&JSON.parse(fs.readFileSync(file,'utf8')).instance===record.instance)fs.unlinkSync(file);}catch{}});
  return ()=>control;
}
