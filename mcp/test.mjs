#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = 19101;
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0, failed = 0;
let serverProc;

function ok(name) { passed++; console.log(`  ✓ ${name}`); }
function ng(name, msg) { failed++; console.error(`  ✗ ${name}: ${msg}`); }

async function main() {
  serverProc = spawn('node', ['mcp/server.mjs', '--http', String(PORT)], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  serverProc.stderr.on('data', (d) => process.stderr.write(d));

  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  const hr = await fetch(`${BASE}/healthz`);
  if (hr.status === 200) {
    const hj = await hr.json();
    if (hj.ok === true && hj.name === 'motion-engine' && hj.version) ok('healthz 200');
    else ng('healthz', JSON.stringify(hj));
  } else {
    ng('healthz', `status ${hr.status}`);
  }

  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  ok('client initialize');

  const { tools } = await client.listTools();
  const toolNames = tools.map((t) => t.name).sort();
  const expected = ['clear', 'grip_pose', 'list_acts', 'play', 'solve_ik', 'step'];
  if (JSON.stringify(toolNames) === JSON.stringify(expected)) ok(`tools/list: ${toolNames.join(', ')}`);
  else ng('tools/list', `got ${toolNames.join(', ')}, expected ${expected.join(', ')}`);

  const r1 = await client.callTool({ name: 'list_acts', arguments: {} });
  const r1j = JSON.parse(r1.content[0].text);
  if (r1j.gestures.length > 0 && r1j.arm_acts.length > 0 && r1j.root_acts.length > 0 && r1j.place_styles.length > 0) {
    ok(`list_acts: ${r1j.gestures.length} gestures, ${r1j.arm_acts.length} arm_acts, ${r1j.root_acts.length} root_acts, ${r1j.place_styles.length} place_styles`);
  } else ng('list_acts', JSON.stringify(r1j));

  const r2 = await client.callTool({
    name: 'solve_ik',
    arguments: {
      pU: [0, 0.3, 0], pL: [0, 0.15, 0], pH: [0, 0, 0],
      restU: [0, 0.3, 0], restL: [0, 0.15, 0],
      target: [0.1, 0.1, 0],
    },
  });
  const r2j = JSON.parse(r2.content[0].text);
  if (r2j.upperQ && r2j.lowerQ && r2j.upperQ.length === 4 && r2j.lowerQ.length === 4) ok('solve_ik: upperQ/lowerQ [x,y,z,w]');
  else ng('solve_ik', JSON.stringify(r2j));

  const r3 = await client.callTool({
    name: 'grip_pose',
    arguments: { side: 'right', curl: 0.8 },
  });
  const r3j = JSON.parse(r3.content[0].text);
  const boneKeys = Object.keys(r3j.bone);
  if (boneKeys.length === 15 && boneKeys.every((k) => r3j.bone[k].length === 3)) ok('grip_pose: 15 bones');
  else ng('grip_pose', `${boneKeys.length} bones`);

  const r4 = await client.callTool({
    name: 'play',
    arguments: { action: { type: 'gesture', name: 'fistPump' } },
  });
  const r4j = JSON.parse(r4.content[0].text);
  if (r4j.queued === true && r4j.actions_in_queue >= 1) ok('play: queued');
  else ng('play', JSON.stringify(r4j));

  const r5 = await client.callTool({ name: 'step', arguments: { dt: 1 / 60 } });
  const r5j = JSON.parse(r5.content[0].text);
  if (r5j.pose && r5j.pose.root && r5j.pose.head) ok('step: pose with root and bones');
  else ng('step', JSON.stringify(r5j));

  const r6 = await client.callTool({ name: 'clear', arguments: {} });
  const r6j = JSON.parse(r6.content[0].text);
  if (r6j.cleared === true) ok('clear: cleared');
  else ng('clear', JSON.stringify(r6j));

  const r7 = await client.callTool({ name: 'step', arguments: { dt: 1 / 60 } });
  const r7j = JSON.parse(r7.content[0].text);
  if (r7j.pose) ok('step after clear: pose returned');
  else ng('step after clear', JSON.stringify(r7j));

  const rs = await client.readResource({ uri: 'motion://spec' });
  const rsj = JSON.parse(rs.contents[0].text);
  if (rsj.namespace === 'motion' && rsj.capabilities && rsj.capabilities.length > 0 && rsj.compositions && rsj.compositions.length > 0) {
    ok(`resource spec: ${rsj.capabilities.length} capabilities, ${rsj.compositions.length} compositions`);
  } else ng('resource spec', JSON.stringify(rsj).slice(0, 200));

  const rg = await client.readResource({ uri: 'motion://guide' });
  if (rg.contents[0].text.includes('# motion-engine MCP Guide')) ok('resource guide: markdown');
  else ng('resource guide', 'missing header');

  const rp = await client.readResource({ uri: 'motion://pose_schema' });
  const rpj = JSON.parse(rp.contents[0].text);
  if (rpj.managed_bones && rpj.managed_bones.length === 42 && rpj.root) ok(`resource pose_schema: ${rpj.managed_bones.length} bones`);
  else ng('resource pose_schema', JSON.stringify(rpj).slice(0, 200));

  const transport2 = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
  const client2 = new Client({ name: 'test-client-2', version: '1.0.0' });
  await client2.connect(transport2);
  const r8 = await client2.callTool({ name: 'step', arguments: { dt: 1 / 60 } });
  const r8j = JSON.parse(r8.content[0].text);
  if (r8j.pose) ok('session isolation: client2 step without play');
  else ng('session isolation', 'no pose');
  await client2.close();

  await client.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  serverProc.kill();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('test failed:', e);
  if (serverProc) serverProc.kill();
  process.exit(1);
});
