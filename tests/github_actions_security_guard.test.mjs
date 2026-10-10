import assert from 'node:assert/strict';
import { analyzeWorkflowSource } from '../tools/audit/github_actions_security_guard.mjs';

const safeQuoted = `name: safe\n'on': [push, pull_request]\n'permissions': { 'contents': 'read' }\njobs:\n  test:\n    runs-on: ubuntu-latest\n`;
assert.deepEqual(analyzeWorkflowSource(safeQuoted, 'safe.yml'), [],
    'quoted read-only workflow syntax must remain accepted');

const cases = [
    ['inline pull_request_target', `on: [push, "pull_request_target"]\npermissions: { contents: read }`, 'pull_request_target'],
    ['quoted pull_request_target key', `"on":\n  'pull_request_target':\npermissions:\n  contents: read`, 'pull_request_target'],
    ['quoted write-all', `on: push\n"permissions": "write-all"`, 'write-all'],
    ['flow-map write permission', `on: push\npermissions: { "contents": "write" }`, 'write permission'],
    ['quoted block write permission', `on: push\npermissions:\n  'contents': 'write'`, 'write permission']
];

for (const [name, source, expected] of cases) {
    const failures = analyzeWorkflowSource(source, `${name}.yml`);
    assert.ok(failures.some((failure) => failure.includes(expected)),
        `${name} must be rejected; got ${JSON.stringify(failures)}`);
}

console.log('GITHUB_ACTIONS_SECURITY_GUARD_CONTRACT_OK equivalentYamlSpellings=true');
