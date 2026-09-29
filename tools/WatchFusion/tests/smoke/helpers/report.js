// Shared standalone smoke reporting; profile diagnostics remain owned by run.js.
export function reportSmokeResults(results, label) {
  const failures = results.filter(result => result.status === 'FAIL');
  const passed = results.filter(result => result.status === 'PASS').length;
  if (failures.length) {
    console.error(`${label} SMOKE FAILED: ${passed} passed, ${failures.length} failed.`);
    for (const result of failures) console.error(`  - ${result.id}: ${result.error}`);
    process.exitCode = 1;
  } else console.log(`${label} SMOKE PASSED: ${passed}/${results.length} tests passed.`);
}
