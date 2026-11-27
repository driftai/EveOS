'use strict';
// Reusable read-only producer gate. The actual Git hook remains authoritative.
// No credential output, fetch, staging, stash, hook override or push is performed here.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const BRANCH = 'eve/nexus-machine-spaces';
const REF = 'refs/heads/' + BRANCH;
const TRACKING = 'refs/remotes/origin/' + BRANCH;
const OID = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const requireThat = (value, code) => { if (!value) throw Error(code); };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function git(repo, args) {
  const env = {...process.env, GIT_OPTIONAL_LOCKS:'0', GIT_TERMINAL_PROMPT:'0'};
  for (const k of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG(?:_.*)?)$/.test(k)) delete env[k];
  const r = cp.spawnSync('git', ['-C',repo,'-c','core.fsmonitor=false','-c','core.untrackedCache=false',...args], {env,encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:1024*1024});
  requireThat(!r.error && r.status === 0, 'PUBLICATION_GIT_READ_FAILED');
  return r.stdout.trim();
}
function pushArgs() {
  return ['-c','push.followTags=false','-c','remote.origin.mirror=false','push','--porcelain','--recurse-submodules=no','origin',REF+':'+REF];
}
function inspect(repo, expected) {
  requireThat(expected && [expected.base,expected.commit,expected.tree,expected.observedRemote].every(x=>typeof x==='string'&&OID.test(x)) && HASH.test(expected.hookSHA256||''), 'PUBLICATION_TRUSTED_INPUT_REQUIRED');
  requireThat(expected.base!==expected.commit && expected.observedRemote===expected.base,'PUBLICATION_REMOTE_CHANGED');
  const root=fs.realpathSync(repo), g=args=>git(root,args);
  requireThat(fs.realpathSync(g(['rev-parse','--show-toplevel']))===root,'PUBLICATION_REPO_ROOT_REQUIRED');
  requireThat(g(['symbolic-ref','HEAD'])===REF,'PUBLICATION_BRANCH_MISMATCH');
  requireThat(g(['rev-parse','HEAD'])===expected.commit && g(['rev-parse','HEAD^{tree}'])===expected.tree,'PUBLICATION_COMMIT_TREE_MISMATCH');
  requireThat(g(['rev-parse',TRACKING])===expected.base,'PUBLICATION_TRACKING_STALE');
  requireThat(g(['merge-base',expected.base,expected.commit])===expected.base,'PUBLICATION_NON_FAST_FORWARD');
  requireThat(g(['config','--get','core.hooksPath'])==='tools/hooks','PUBLICATION_HOOK_PATH_MISMATCH');
  const hook=path.join(root,'tools/hooks/pre-push');
  for(const p of [path.join(root,'tools'),path.join(root,'tools/hooks'),hook]) requireThat(!fs.lstatSync(p).isSymbolicLink(),'PUBLICATION_HOOK_LINK');
  const st=fs.statSync(hook); requireThat(st.isFile()&&st.size<=65536,'PUBLICATION_HOOK_INVALID');
  requireThat(/^100755 [a-f0-9]{40} 0\ttools\/hooks\/pre-push$/.test(g(['ls-files','--stage','--','tools/hooks/pre-push'])),'PUBLICATION_HOOK_MODE_MISMATCH');
  if(process.platform!=='win32')fs.accessSync(hook,fs.constants.X_OK);
  const bytes=Buffer.from(fs.readFileSync(hook,'utf8').replace(/\r\n/g,'\n'));
  requireThat(sha(bytes)===expected.hookSHA256,'PUBLICATION_HOOK_CHANGED');
  for(const marker of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer']) requireThat(!fs.existsSync(path.resolve(root,g(['rev-parse','--git-path',marker]))),'PUBLICATION_GIT_OPERATION_ACTIVE');
  requireThat(g(['status','--porcelain=v1','--untracked-files=normal'])==='','PUBLICATION_WORKTREE_DIRTY');
  // Read-only proof, not authorization: producer must recheck actual remote immediately
  // before the single dispatch, audit exact staged tree and preserve excluded WIP.
  return {status:'PASS',branch:BRANCH,base:expected.base,commit:expected.commit,tree:expected.tree,hookSHA256:expected.hookSHA256,refspec:REF+':'+REF,pushArguments:pushArgs()};
}
const patterns = [
 ['HOOK_REF_OR_TRACKING',/wrong branch, candidate SHA or stale origin/i],
 ['HOOK_CLEAN_TREE',/expected one clean, authorized active-lane update/i],
 ['HOOK_GUARDRAILS',/mandatory EveOS repository guardrails are RED/i],
 ['HOOK_CHANGED_DURING_QUALIFICATION',/source changed during qualification/i],
 ['HOOK_REMOTE',/only the inspected origin remote is permitted/i],
 ['HOOK_NON_FAST_FORWARD',/new branch or non-fast-forward update/i],
 ['AUTHENTICATION',/authentication failed|could not read username|terminal prompts disabled|permission denied \(publickey\)|invalid credentials/i],
 ['REMOTE_RULES',/GH013|GH006|protected branch|repository rule violations|push protection/i],
 ['NON_FAST_FORWARD',/non-fast-forward|fetch first|stale info/i],
 ['NETWORK',/could not resolve host|failed to connect|connection.*(?:reset|timed out)|RPC failed|unexpected disconnect/i],
 ['HOOK_OTHER',/PUSH BLOCKED:|pre-push|hook declined/i]
];
function classify(result) {
  const output=(String(result?.stdout||'')+'\n'+String(result?.stderr||'')).slice(0,2*1024*1024);
  const categories=patterns.filter(([,re])=>re.test(output)).map(([code])=>code);
  if(result?.error?.code==='ETIMEDOUT')categories.push('TIMEOUT');
  if(result?.status!==0&&!categories.length)categories.push('UNCLASSIFIED_LOCAL_DIAGNOSTIC_REQUIRED');
  return {exit:Number.isInteger(result?.status)?result.status:null,categories};
}
if(require.main===module){try{const [repo,base,commit,tree,observedRemote,hookSHA256]=process.argv.slice(2);console.log(JSON.stringify(inspect(repo,{base,commit,tree,observedRemote,hookSHA256})));}catch(e){console.error(/^PUBLICATION_[A-Z_]+$/.test(e.message)?e.message:'PUBLICATION_PREFLIGHT_BLOCKED');process.exitCode=2;}}
module.exports={BRANCH,REF,TRACKING,inspect,pushArgs,classify};
