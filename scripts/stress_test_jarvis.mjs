/**
 * JARVIS Full System Stress & Autonomous Verification Suite.
 * Tests every endpoint, tool, mode, and multi-turn autonomous loop.
 */

const BASE_URL = 'http://localhost:4173';

const results = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

async function runTest(name, fn) {
  process.stdout.write(`[TEST] ${name} ... `);
  const start = Date.now();
  try {
    await fn();
    const duration = Date.now() - start;
    console.log(`PASSED (${duration}ms)`);
    results.push({ name, status: 'PASS', duration });
  } catch (err) {
    const duration = Date.now() - start;
    console.log(`FAILED (${duration}ms): ${err.message}`);
    results.push({ name, status: 'FAIL', duration, error: err.message });
  }
}

async function main() {
  console.log('═════════════════════════════════════════════════════════');
  console.log('       JARVIS UNIVERSAL ASSISTANT STRESS TEST SUITE       ');
  console.log('═════════════════════════════════════════════════════════\n');

  // 1. Status & Health
  await runTest('NVIDIA Status Endpoint', async () => {
    const res = await fetch(`${BASE_URL}/api/nvidia/status`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const data = await res.json();
    assert(data.configured === true, 'NVIDIA API key should be configured');
    assert(Boolean(data.model), 'Model name should be present');
  });

  // 2. Android & Device Info
  await runTest('Device Info & QR Code Endpoint', async () => {
    const res = await fetch(`${BASE_URL}/api/jarvis/device-info`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const data = await res.json();
    assert(data.ok === true, 'Response ok should be true');
    assert(Boolean(data.lanUrl), 'lanUrl should be present');
    assert(Boolean(data.qrSvg) && data.qrSvg.includes('<svg'), 'QR SVG should be present');
    assert(data.pwa?.installable === true, 'PWA should be installable');
  });

  // 3. Sandboxed Code Execution: JavaScript
  await runTest('Tool: execute_code (JavaScript)', async () => {
    const res = await fetch(`${BASE_URL}/api/jarvis/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'execute_code',
        args: {
          language: 'javascript',
          code: 'const nums = [1, 2, 3, 4, 5]; console.log("SUM:" + nums.reduce((a,b)=>a+b, 0));',
        },
      }),
    });
    const data = await res.json();
    assert(data.ok === true, 'API should return ok: true');
    assert(data.result?.exitCode === 0, `Expected exitCode 0, got ${data.result?.exitCode}`);
    assert(data.result?.stdout.includes('SUM:15'), 'Output should contain SUM:15');
  });

  // 4. Sandboxed Code Execution: Python
  await runTest('Tool: execute_code (Python)', async () => {
    const res = await fetch(`${BASE_URL}/api/jarvis/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'execute_code',
        args: {
          language: 'python',
          code: 'import math\nprint(f"PI_ROUND:{round(math.pi, 4)}")',
        },
      }),
    });
    const data = await res.json();
    assert(data.ok === true, 'API should return ok: true');
    assert(data.result?.exitCode === 0, `Expected exitCode 0, got ${data.result?.exitCode}`);
    assert(data.result?.stdout.includes('PI_ROUND:3.1416'), 'Output should contain PI_ROUND:3.1416');
  });

  // 5. Sandboxed Code Execution: PowerShell
  await runTest('Tool: execute_code (PowerShell)', async () => {
    const res = await fetch(`${BASE_URL}/api/jarvis/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'execute_code',
        args: {
          language: 'powershell',
          code: '$val = 10 * 4; Write-Output "PS_RES:$val"',
        },
      }),
    });
    const data = await res.json();
    assert(data.ok === true, 'API should return ok: true');
    assert(data.result?.exitCode === 0, `Expected exitCode 0, got ${data.result?.exitCode}`);
    assert(data.result?.stdout.includes('PS_RES:40'), 'Output should contain PS_RES:40');
  });

  // 6. Error Diagnostics & Traceback Extraction
  await runTest('Tool: debug_code with Syntax/Runtime Error', async () => {
    const res = await fetch(`${BASE_URL}/api/jarvis/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'debug_code',
        args: {
          language: 'python',
          code: 'def divide(a, b):\n    return a / b\n\nprint(divide(10, 0))',
          expectedBehavior: 'Handle divide by zero safely',
        },
      }),
    });
    const data = await res.json();
    assert(data.ok === true, 'API should return ok');
    assert(data.result?.exitCode !== 0, 'Should fail with non-zero exit code');
    assert(Boolean(data.result?.errorAnalysis), 'Should extract structured errorAnalysis');
    assert(
      data.result.errorAnalysis.primaryError.includes('ZeroDivisionError'),
      `Expected ZeroDivisionError, got: ${data.result?.errorAnalysis?.primaryError}`,
    );
  });

  // 7. Math Calculation Tool
  await runTest('Tool: calculate (Complex Math Expression)', async () => {
    const res = await fetch(`${BASE_URL}/api/jarvis/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'calculate',
        args: { expression: 'Math.sqrt(256) * 2 + Math.pow(2, 5)' },
      }),
    });
    const data = await res.json();
    assert(data.ok === true, 'API should return ok');
    assert(data.result?.result === 64, `Expected 64, got ${data.result?.result}`);
  });

  // 8. Persistent Memory Cycle
  await runTest('Tool: remember, recall, forget (Memory Lifecycle)', async () => {
    const testKey = 'test_device_name';
    const testVal = 'Quantum-Workstation-2026';

    // Set memory
    const setRes = await fetch(`${BASE_URL}/api/jarvis/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set', key: testKey, value: testVal }),
    });
    const setData = await setRes.json();
    assert(setData.ok === true, 'Memory set failed');

    // Recall memory
    const searchRes = await fetch(`${BASE_URL}/api/jarvis/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'search', query: 'Quantum' }),
    });
    const searchData = await searchRes.json();
    assert(Boolean(searchData.result?.[testKey]), 'Recalled memory should find key');
    assert(searchData.result[testKey].value === testVal, 'Recalled memory should match value');

    // Forget memory
    const delRes = await fetch(`${BASE_URL}/api/jarvis/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', key: testKey }),
    });
    const delData = await delRes.json();
    assert(delData.result?.deleted === true, 'Memory delete failed');
  });

  // 9. Sandboxed File Operations
  await runTest('Tool: write_file, read_file, list_files, delete_file', async () => {
    const filename = 'stress_test_artifact.txt';
    const content = 'JARVIS Tactical System Diagnostic File';

    // Write file
    const writeRes = await fetch(`${BASE_URL}/api/jarvis/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'write_file', args: { path: filename, content } }),
    });
    const writeData = await writeRes.json();
    assert(writeData.result?.bytesWritten > 0, 'Write file should write bytes');

    // Read file
    const readRes = await fetch(`${BASE_URL}/api/jarvis/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'read_file', args: { path: filename } }),
    });
    const readData = await readRes.json();
    assert(readData.result?.content === content, 'Read content should match');

    // List files
    const listRes = await fetch(`${BASE_URL}/api/jarvis/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'list_files', args: {} }),
    });
    const listData = await listRes.json();
    assert(listData.result?.files?.some((f) => f.name === filename), 'List should contain created file');

    // Delete file
    const delRes = await fetch(`${BASE_URL}/api/jarvis/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'delete_file', args: { path: filename } }),
    });
    const delData = await delRes.json();
    assert(delData.result?.deleted === true, 'Delete file failed');
  });

  // 10. Multi-Turn Autonomous Tool Loop (Code Mode)
  await runTest('Autonomous Multi-Turn Execution Loop (Code Mode)', async () => {
    const res = await fetch(`${BASE_URL}/api/nvidia/assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: 'Write a Python script that computes the factorial of 6, execute it using execute_code, and report the answer.',
          },
        ],
        mode: 'code',
        stream: false,
      }),
    });
    const data = await res.json();
    assert(data.ok === true, 'Assistant response should be ok');
    assert(data.iterations >= 2, `Expected at least 2 iterations for autonomous execution, got ${data.iterations}`);
    assert(data.toolExecutions?.length > 0, 'Should have executed tools autonomously');
    assert(data.message?.content?.includes('720'), 'Final answer should contain 720');
  });

  // 11. Study Mode Response
  await runTest('Study Mode (Academic Explanation)', async () => {
    const res = await fetch(`${BASE_URL}/api/nvidia/assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Explain Newton third law with one quick example.' }],
        mode: 'study',
        stream: false,
      }),
    });
    const data = await res.json();
    assert(data.ok === true, 'Study mode response should be ok');
    assert(Boolean(data.message?.content), 'Study mode should return content');
  });

  // 12. Research Mode Endpoint
  await runTest('Research Mode & Web Search API', async () => {
    const res = await fetch(`${BASE_URL}/api/nvidia/research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Hubble Space Telescope', type: 'all' }),
    });
    const data = await res.json();
    assert(data.ok === true, 'Research query should succeed');
    assert(Boolean(data.results?.wikipedia?.extract || data.results?.web), 'Should return wiki or web content');
  });

  console.log('\n═════════════════════════════════════════════════════════');
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`TOTAL TESTS: ${results.length} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('═════════════════════════════════════════════════════════\n');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
