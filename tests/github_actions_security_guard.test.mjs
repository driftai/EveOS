import assert from 'node:assert/strict';
import { analyzeWorkflowSource } from '../tools/audit/github_actions_security_guard.mjs';

const safeQuoted = `name: safe\n'on': [push, pull_request]\n'permissions': { 'contents': 'read' }\njobs:\n  test:\n    runs-on: ubuntu-latest\n`;
assert.deepEqual(analyzeWorkflowSource(safeQuoted, 'safe.yml'), [],
    'quoted read-only workflow syntax must remain accepted');

const safePerJob = `name: safe-per-job\non: push\njobs:\n  first:\n    permissions: { contents: read }\n    runs-on: ubuntu-latest\n  second:\n    permissions:\n      contents: read\n    runs-on: ubuntu-latest\n`;
assert.deepEqual(analyzeWorkflowSource(safePerJob, 'safe-per-job.yml'), [],
    'each job may establish its own contents: read baseline when root permissions are absent');

const safeInherited = `name: safe-inherited\non: push\npermissions:\n  contents: read\njobs:\n  first:\n    runs-on: ubuntu-latest\n  second:\n    runs-on: ubuntu-latest\n`;
assert.deepEqual(analyzeWorkflowSource(safeInherited, 'safe-inherited.yml'), [],
    'jobs without overrides must inherit the workflow-level contents: read baseline');

const cases = [
    ['inline pull_request_target', `on: [push, "pull_request_target"]\npermissions: { contents: read }`, 'pull_request_target'],
    ['flow-map pull_request_target', `on: {pull_request_target: {}}\npermissions: { contents: read }`, 'pull_request_target'],
    ['quoted pull_request_target key', `"on":\n  'pull_request_target':\npermissions:\n  contents: read`, 'pull_request_target'],
    ['quoted write-all', `on: push\n"permissions": "write-all"`, 'write-all'],
    ['flow-map write permission', `on: push\npermissions: { "contents": "write" }`, 'write permission'],
    ['quoted block write permission', `on: push\npermissions:\n  'contents': 'write'`, 'write permission'],
    ['mixed job permission coverage', `on: push\njobs:\n  covered:\n    permissions:\n      contents: read\n    runs-on: ubuntu-latest\n  uncovered:\n    runs-on: ubuntu-latest`, 'job uncovered requires effective contents: read'],
    ['job override drops inherited contents', `on: push\npermissions:\n  contents: read\njobs:\n  inherited:\n    runs-on: ubuntu-latest\n  override:\n    permissions:\n      actions: read\n    runs-on: ubuntu-latest`, 'job override requires effective contents: read']
];

for (const [name, source, expected] of cases) {
    const failures = analyzeWorkflowSource(source, `${name}.yml`);
    assert.ok(failures.some((failure) => failure.includes(expected)),
        `${name} must be rejected; got ${JSON.stringify(failures)}`);
}

console.log('GITHUB_ACTIONS_SECURITY_GUARD_CONTRACT_OK equivalentYamlSpellings=true flowMapEvents=true permissionInheritance=true');
