'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const p=require('../scripts/publication-preflight.cjs');
const actualHook=path.resolve(__dirname,'../../hooks/pre-push');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'eveos-publication-contract-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const repo=path.join(root,'repo'),remote=path.join(root,'remote.git');fs.mkdirSync(repo);
 const env={...process.env,GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(root,'empty-config')};
 for(const k of Object.keys(env)) if(/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|CONFIG_PARAMETERS)$/.test(k))delete env[k];
 fs.writeFileSync(env.GIT_CONFIG_GLOBAL,'');
 const raw=(args,extra={})=>cp.spawnSync('git',args,{cwd:repo,encoding:'utf8',env:{...env,...extra},windowsHide:true,timeout:30000,maxBuffer:1024*1024});
 const git=(...args)=>{const r=raw(args);assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 git('init','-b',p.BRANCH);git('config','user.name','Synthetic');git('config','user.email','test@example.invalid');git('config','core.autocrlf','false');
 git('init','--bare',remote);git('remote','add','origin',remote);
 fs.mkdirSync(path.join(repo,'tools/hooks'),{recursive:true});fs.mkdirSync(path.join(repo,'tools/qualification'),{recursive:true});
 const hook=Buffer.from(fs.readFileSync(actualHook,'utf8').replace(/\r\n/g,'\n'));fs.writeFileSync(path.join(repo,'tools/hooks/pre-push'),hook,{mode:0o755});
 // Only qualification body is stubbed: exercise the actual repository hook through Git.
 fs.writeFileSync(path.join(repo,'tools/qualification/eveos_publication_scope.py'),"import os, sys\nif os.environ.get('SYNTHETIC_MUTATE') == '1':\n    open('changed.txt', 'w').write('fixture')\nsys.exit(1 if os.environ.get('SYNTHETIC_FAIL') == '1' else 0)\n");
 fs.writeFileSync(path.join(repo,'code.js'),'const a=1;\n');git('add','.');git('update-index','--chmod=+x','tools/hooks/pre-push');git('commit','-m','Synthetic baseline');
 const base=git('rev-parse','HEAD');git('push','-u','origin',p.REF+':'+p.REF);git('config','core.hooksPath','tools/hooks');
 fs.writeFileSync(path.join(repo,'code.js'),'const a=2;\n');git('add','code.js');git('commit','-m','Synthetic candidate');
 const commit=git('rev-parse','HEAD'),tree=git('rev-parse','HEAD^{tree}'),expected={base,commit,tree,observedRemote:base,hookSHA256:crypto.createHash('sha256').update(hook).digest('hex')};
 const dry=(args=p.pushArgs(),extra={})=>raw([...args.slice(0,-2),'--dry-run',...args.slice(-2)],extra);
 return {repo,git,raw,dry,expected,remote};
}
test('actual hook accepts clean named ref; reusable preflight agrees',t=>{const x=fixture(t);assert.equal(p.inspect(x.repo,x.expected).status,'PASS');const r=x.dry();assert.equal(r.status,0,r.stderr);assert.match(r.stdout+r.stderr,/EVEOS_PUBLICATION_GUARD_OK/);assert.equal(x.git('ls-remote','origin',p.REF).split(/\s/)[0],x.expected.base);});
test('actual hook rejects literal SHA refspec; builder always names branch',t=>{const x=fixture(t),args=p.pushArgs();args[args.length-1]=x.expected.commit+':'+p.REF;const r=x.dry(args);assert.notEqual(r.status,0);assert.ok(p.classify(r).categories.includes('HOOK_REF_OR_TRACKING'));assert.equal(p.pushArgs().at(-1),p.REF+':'+p.REF);});
test('actual hook rejects unrelated dirty file and preflight blocks',t=>{const x=fixture(t);fs.writeFileSync(path.join(x.repo,'code.js'),'unrelated');assert.throws(()=>p.inspect(x.repo,x.expected),/PUBLICATION_WORKTREE_DIRTY/);const r=x.dry();assert.notEqual(r.status,0);assert.ok(p.classify(r).categories.includes('HOOK_CLEAN_TREE'));});
test('actual hook rejects stale tracking and preflight blocks',t=>{const x=fixture(t);x.git('update-ref',p.TRACKING,x.expected.commit);assert.throws(()=>p.inspect(x.repo,x.expected),/PUBLICATION_TRACKING_STALE/);assert.ok(p.classify(x.dry()).categories.includes('HOOK_REF_OR_TRACKING'));});
test('qualification refusal and post-check source drift remain fatal',t=>{const x=fixture(t);assert.ok(p.classify(x.dry(p.pushArgs(),{SYNTHETIC_FAIL:'1'})).categories.includes('HOOK_GUARDRAILS'));const r=x.dry(p.pushArgs(),{SYNTHETIC_MUTATE:'1'});assert.notEqual(r.status,0);assert.ok(p.classify(r).categories.includes('HOOK_CHANGED_DURING_QUALIFICATION'));});
test('preflight rejects changed hook, remote baseline and tree',t=>{const x=fixture(t);assert.throws(()=>p.inspect(x.repo,{...x.expected,observedRemote:x.expected.commit}),/PUBLICATION_REMOTE_CHANGED/);assert.throws(()=>p.inspect(x.repo,{...x.expected,tree:'1'.repeat(40)}),/PUBLICATION_COMMIT_TREE_MISMATCH/);fs.appendFileSync(path.join(x.repo,'tools/hooks/pre-push'),'# changed\n');assert.throws(()=>p.inspect(x.repo,x.expected),/PUBLICATION_HOOK_CHANGED/);});
test('classified diagnostics never echo raw private text; unknown requires local review',()=>{const secret='PRIVATE_CANARY_NEVER_RETURN';assert.deepEqual(p.classify({status:1,stderr:secret}),{exit:1,categories:['UNCLASSIFIED_LOCAL_DIAGNOSTIC_REQUIRED']});assert.ok(!JSON.stringify(p.classify({status:1,stderr:'PUSH BLOCKED: wrong branch, candidate SHA or stale origin. '+secret})).includes(secret));assert.ok(!p.pushArgs().some(a=>a==='--force'||a==='--no-verify'||a==='--dry-run'));});
