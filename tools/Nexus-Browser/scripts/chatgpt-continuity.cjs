'use strict';
// Dependency-free, read-only ZIP gate and receipt context renderer. Node >=18.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const docs = ['STATE','ENGINEERING','VALIDATION','NEXT-STEPS','HISTORY'];
const manifest = 'CONTINUITY-MANIFEST.json';
const required = ['CONTEXT.md', ...docs.map(x=>`context/${x}.md`), manifest];
const sha = b=>crypto.createHash('sha256').update(b).digest('hex');
const check = (x,m)=>{if(!x)throw Error(m);};
const safe = s=>{
  const n=s.replace(/\\/g,'/');
  check(n && !n.startsWith('/') && !/[\x00-\x1f:]/.test(n) && n.split('/').every(x=>x && x!=='.' && x!=='..' && !/[. ]$/.test(x) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(x)),`unsafe path: ${s}`);
  return n;
};
const crcTable=Array.from({length:256},(_,i)=>{for(let j=0;j<8;j++)i=(i>>>1)^((i&1)?0xedb88320:0);return i>>>0;});
function crc(b){let x=0xffffffff;for(const c of b)x=(x>>>8)^crcTable[(x^c)&255];return (x^0xffffffff)>>>0;}
function add(map,n,b){check(![...map.keys()].some(k=>k.toLowerCase()===n.toLowerCase()),`duplicate path: ${n}`);map.set(n,b);}
function readZip(file){
  if(!Buffer.isBuffer(file))check(fs.statSync(file).size<=128*1024*1024,'archive too large');
  const b=Buffer.isBuffer(file)?file:fs.readFileSync(file);
  check(b.length<=128*1024*1024,'archive too large');
  const m=new Map(), names=new Set();let end=-1;
  for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--)if(b.readUInt32LE(i)===0x06054b50 && i+22+b.readUInt16LE(i+20)===b.length){end=i;break;}
  check(end>=0,'missing ZIP end');const count=b.readUInt16LE(end+10), size=b.readUInt32LE(end+12),start=b.readUInt32LE(end+16);
  check(!b.readUInt16LE(end+4)&&!b.readUInt16LE(end+6)&&count===b.readUInt16LE(end+8)&&count<=4096&&start+size===end,'unsupported ZIP layout');
  let p=start,total=0;const ranges=[];
  for(let i=0;i<count;i++){
    check(p+46<=end&&b.readUInt32LE(p)===0x02014b50,'bad central header');
    check(((b.readUInt32LE(p+38)>>>16)&0xf000)!==0xa000,'symlink ZIP entry forbidden');
    const flags=b.readUInt16LE(p+8),method=b.readUInt16LE(p+10),c=b.readUInt32LE(p+16),cs=b.readUInt32LE(p+20),us=b.readUInt32LE(p+24),nl=b.readUInt16LE(p+28),el=b.readUInt16LE(p+30),cl=b.readUInt16LE(p+32),off=b.readUInt32LE(p+42);
    check(!(flags&~0x80e)&&[0,8].includes(method)&&p+46+nl+el+cl<=end&&!b.readUInt16LE(p+34),'unsupported ZIP entry');
    const raw=b.subarray(p+46,p+46+nl),s=raw.toString('utf8'),dir=/[\\/]$/.test(s),n=safe(dir?s.slice(0,-1):s);p+=46+nl+el+cl;
    check(Buffer.from(s).equals(raw)&&!names.has(n.toLowerCase()),`duplicate/invalid name: ${n}`);names.add(n.toLowerCase());
    check(off+30<=start&&b.readUInt32LE(off)===0x04034b50&&b.readUInt16LE(off+6)===flags&&b.readUInt16LE(off+8)===method,'bad local header');
    const ln=b.readUInt16LE(off+26),lx=b.readUInt16LE(off+28),begin=off+30+ln+lx;
    check(raw.equals(b.subarray(off+30,off+30+ln))&&begin+cs<=start,'local name/bounds mismatch');
    check((b.readUInt32LE(off+14)===c&&b.readUInt32LE(off+18)===cs&&b.readUInt32LE(off+22)===us)||Boolean(flags&8),'local sizes mismatch');
    check(us<=64*1024*1024&&(total+=us)<=256*1024*1024,'expanded size limit');
    const data=method===0?b.subarray(begin,begin+cs):zlib.inflateRawSync(b.subarray(begin,begin+cs),{maxOutputLength:Math.max(1,us)});
    check(data.length===us&&crc(data)===c,`CRC/length mismatch: ${n}`);
    let finish=begin+cs;if(flags&8){if(b.readUInt32LE(finish)===0x08074b50)finish+=4;check(finish+12<=start&&b.readUInt32LE(finish)===c&&b.readUInt32LE(finish+4)===cs&&b.readUInt32LE(finish+8)===us,'bad data descriptor');finish+=12;}
    check(!ranges.some(([a,d])=>off<d&&finish>a),'overlapping ZIP entries');ranges.push([off,finish]);
    if(dir)check(us===0,'nonempty directory');else add(m,n,data);
  }
  check(p===end,'central size mismatch');const files=new Set([...m.keys()].map(n=>n.toLowerCase()));for(const n of names){const parts=n.split('/');for(let i=1;i<parts.length;i++)check(!files.has(parts.slice(0,i).join('/')),'file/directory path collision');}return m;
}
function readDir(root){const m=new Map();let total=0;function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name),n=safe(path.relative(root,f));check(!e.isSymbolicLink(),'symlink forbidden');if(e.isDirectory())walk(f);else{check(e.isFile(),'nonregular file');const sz=fs.statSync(f).size;check(sz<=64*1024*1024&&(total+=sz)<=256*1024*1024&&m.size<4096,'size limit');add(m,n,fs.readFileSync(f));}}}walk(root);return m;}
const stages=new Set(['prepared','qualification-failed','qualified-deferred','applied-activation-blocked','activated-physical-pending','accepted','published','rolled-back','unknown']);
const roles=new Set(['candidate','receipt','recovery']);
const axes=['qualification','application','activation','physical','publication'];
function validateEvent(e){
  for(const k of ['project','packageId','eventId','predecessorId','observedAt','recordedAt','base','branch','nextAction','authorization','resultPath','resultMarker'])check(typeof e[k]==='string'&&e[k].trim()&&!/[\r\n]/.test(e[k]),`missing/invalid ${k}`);
  check(e.schema===2&&roles.has(e.role)&&stages.has(e.stage),'bad schema/role/stage');
  check(/^[0-9a-f]{40}$/.test(e.base)&&Number.isFinite(Date.parse(e.observedAt))&&Number.isFinite(Date.parse(e.recordedAt)),'invalid base/time');
  check(e.predecessorId!==e.eventId,'self predecessor');
  if(e.predecessorSha256!==undefined)check(/^[0-9a-f]{64}$/.test(e.predecessorSha256)||e.predecessorSha256==='none','invalid predecessor artifact hash');
  for(const a of axes)check(typeof e.axes?.[a]==='string'&&e.axes[a].trim(),`missing axis ${a}`);
  const allowed={qualification:['pending','passed','failed','unknown'],application:['not-applied','applied','rolled-back','unknown'],activation:['pending','verified','blocked','unknown'],physical:['pending','accepted','rejected','unknown'],publication:['not-published','published','unknown']};
  for(const a of axes)check(allowed[a].includes(e.axes[a]),`invalid axis ${a}`);
  const a=e.axes;
  if(e.role==='candidate')check(e.stage==='prepared'&&a.qualification==='pending'&&a.application==='not-applied'&&a.activation==='pending'&&a.physical==='pending'&&a.publication==='not-published','candidate overclaims state');
  else check(e.stage!=='prepared','receipt/recovery cannot be prepared');
  if(e.stage==='qualified-deferred')check(a.qualification==='passed'&&a.application==='not-applied'&&a.activation==='pending'&&a.physical==='pending'&&a.publication==='not-published','deferred state contradiction');
  if(e.stage==='qualification-failed')check(a.qualification==='failed'&&a.application==='not-applied'&&a.activation!=='verified','failure state contradiction');
  if(e.stage==='applied-activation-blocked')check(a.application==='applied'&&a.activation==='blocked','activation blocker contradiction');
  if(e.stage==='rolled-back')check(a.application==='rolled-back'&&a.activation!=='verified','rollback contradiction');
  if(e.stage==='activated-physical-pending')check(a.qualification==='passed'&&a.application==='applied'&&a.activation==='verified'&&a.physical==='pending','activation state contradiction');
  if(e.stage==='accepted')check(a.qualification==='passed'&&a.application==='applied'&&a.activation==='verified'&&a.physical==='accepted','acceptance contradiction');
  if(e.stage==='published')check(a.qualification==='passed'&&a.application==='applied'&&a.activation==='verified'&&a.physical==='accepted'&&a.publication==='published','publication contradiction');
  if(a.publication==='published')check(e.stage==='published','publication overclaim');
  check(Number.isInteger(e.exitCode)&&e.exitCode>=0,'missing exit code');
  if(e.stage==='qualified-deferred')check(e.exitCode===3,'deferred exit must be 3');
  if(e.stage==='qualification-failed')check(e.exitCode!==0,'failure exit must be nonzero');
  safe(e.resultPath);check(!required.includes(e.resultPath),'result cannot be context/manifest');
}
function decode(b){check(b,'missing text');return (b[0]===255&&b[1]===254?b.subarray(2).toString('utf16le'):b.toString('utf8')).replace(/^\ufeff/,'');}
function evidence(m,e){const lines=decode(m.get(e.resultPath)).split(/\r?\n/);check(lines.includes(e.resultMarker)&&lines.includes(`EXIT_CODE=${e.exitCode}`),'result marker/exit mismatch');}
function verify(m){
  for(const n of required)check(m.has(n),`missing ${n}`);
  const root=decode(m.get('CONTEXT.md')), match=root.match(/```json\r?\n([\s\S]*?)\r?\n```/);check(match,'missing structured root');const e=JSON.parse(match[1]);validateEvent(e);evidence(m,e);
  for(const d of docs){const n=`context/${d}.md`;check(root.includes(`](${n})`)&&decode(m.get(n)).includes(`Event: ${e.eventId}\n`)&&decode(m.get(n)).trim().split(/\r?\n/).length>=4,`missing link/stale or empty ${n}`);}
  const inv=JSON.parse(decode(m.get(manifest)));check(inv.schema===2&&Array.isArray(inv.files)&&inv.files.length===m.size-1,'manifest coverage');const seen=new Set();
  for(const f of inv.files){const n=safe(f.path);check(n===f.path&&n!==manifest&&!seen.has(n)&&m.has(n),'manifest path mismatch');seen.add(n);const b=m.get(n);check(b.length===f.bytes&&sha(b)===f.sha256,`manifest hash/size mismatch: ${n}`);}
  return {status:'PASS',eventId:e.eventId,stage:e.stage,role:e.role,files:inv.files.length,nextAction:e.nextAction};
}
function render(root,e,sections){
  validateEvent(e);const before=readDir(root);evidence(before,e);
  for(const d of docs)check(typeof sections[d]==='string'&&sections[d].trim(),'missing section '+d);
  // Fresh directory only: never mutate an existing sealed receipt/candidate.
  for(const n of required)check(!before.has(n),`refuse to overwrite ${n}`);
  fs.mkdirSync(path.join(root,'context'),{recursive:true});
  for(const d of docs)fs.writeFileSync(path.join(root,'context',d+'.md'),`# ${d}\n\nEvent: ${e.eventId}\n\n${sections[d].trim()}\n`,{flag:'wx'});
  fs.writeFileSync(path.join(root,'CONTEXT.md'),`# Continuity — ${e.project}\n\n\`\`\`json\n${JSON.stringify(e,null,2)}\n\`\`\`\n\n${docs.map(d=>`- [${d}](context/${d}.md)`).join('\n')}\n`,{flag:'wx'});
  const files=[...readDir(root)].sort(([a],[b])=>a.localeCompare(b)).map(([p,b])=>({path:p,bytes:b.length,sha256:sha(b)}));
  fs.writeFileSync(path.join(root,manifest),JSON.stringify({schema:2,files},null,2)+'\n',{flag:'wx'});
  return verify(readDir(root));
}
if(require.main===module){try{const [cmd,target,input]=process.argv.slice(2);let r;if(cmd==='verify-zip'){check(fs.statSync(target).size<=128*1024*1024,'archive too large');const b=fs.readFileSync(target);r={...verify(readZip(b)),sha256:sha(b)};}else if(cmd==='verify-dir')r=verify(readDir(target));else if(cmd==='render'){const {event,sections}=JSON.parse(fs.readFileSync(input,'utf8').replace(/^\ufeff/,''));r=render(target,event,sections);}else throw Error('usage: verify-zip ZIP | verify-dir DIR | render DIR EVENT.json');const {nextAction,eventId,...publicResult}=r;console.log(JSON.stringify(process.argv.includes('--private-details')?r:publicResult));}catch(e){console.error(process.argv.includes('--private-details')?'CONTINUITY_BLOCKED: '+e.message:'CONTINUITY_BLOCKED');process.exitCode=1;}}
module.exports={readZip,readDir,verify,render,crc};
