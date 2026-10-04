import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { StudioReadHelper } from '../src/index.ts';
import { createFixtureStdioTransport, loadInstalledMcpSdk } from '../src/transport/index.ts';
import { MockStudioTransport, validateFixtureInput } from '../fixtures/mock-studio.ts';

const sdk = loadInstalledMcpSdk(process.env.ROMANUM_BRIDGE_SDK_ROOT ? path.join(process.env.ROMANUM_BRIDGE_SDK_ROOT, 'package.json') : new URL('../package.json', import.meta.url));
async function fixture(t, mode = 'normal') {
  const transport = createFixtureStdioTransport(sdk, mode);
  const helper = new StudioReadHelper(transport, { mode: 'fixture' });
  t.after(() => helper.close());
  const connected = await helper.handle({ id: 'connect', operation: 'connect', timeoutMs: 10_000 });
  assert.equal(connected.ok, true, JSON.stringify(connected));
  const selected = await helper.handle({ id: 'select', operation: 'select', studioId: 'studio-b' });
  assert.equal(selected.ok, true);
  return { helper, transport, selectionId: selected.result.selectionId };
}
async function dispatched(transport) {
  const deadline = Date.now() + 3_000;
  while (!transport.readsSent && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(transport.readsSent, 1);
}

test('helper reads an explicit stdio target, exposes actual schema/status and rejects replay/writes', async t => {
  const { helper, transport, selectionId } = await fixture(t);
  const status = helper.status();
  assert.equal(status.connected, true);
  assert.equal(status.realStudioConnected, false);
  assert.equal(status.mode, 'fixture');
  assert.equal(status.canInspect, true);
  assert.equal(status.readCapability.inputSchema.properties.studio_id.type, 'string');
  const request = { id: 'read', operation: 'inspect', selectionId };
  const response = await helper.handle(request);
  assert.equal(response.id, 'read');
  assert.equal(response.ok, true);
  assert.equal(response.result.target.studioId, 'studio-b');
  assert.equal(response.result.result.structuredContent.studio_id, 'studio-b');
  assert.equal(response.result.result.structuredContent.mock, true);
  assert.equal((await helper.handle(request)).error.code, 'duplicate_request');
  assert.equal((await helper.handle({ id: 'edit', operation: 'multi_edit', input: {} })).error.code, 'invalid_input');
  assert.equal((await helper.handle({ id: 'hidden-target', operation: 'inspect', selectionId, input: { studio_id: 'studio-a' } })).error.code, 'invalid_input');
  const changed = await helper.handle({ id: 'reselect', operation: 'select', studioId: 'studio-a' });
  assert.notEqual(changed.result.selectionId, selectionId);
  assert.equal((await helper.handle({ id: 'stale', operation: 'inspect', selectionId })).error.code, 'selection_required');
  status.selected.studioId = 'caller-mutation';
  assert.equal(helper.status().selected.studioId, 'studio-a');
  assert.equal(transport.readsSent, 1);
  assert.equal(transport.writesSent, 0);
  assert.equal((await helper.handle({ id: 'close', operation: 'close' })).status.state, 'closed');
  await transport.waitForClose();
});

test('status and correlated cancel remain available during an inspection', async t => {
  const { helper, transport, selectionId } = await fixture(t, 'timeout-read');
  const read = helper.handle({ id: 'pending-read', operation: 'inspect', selectionId });
  await dispatched(transport);
  const status = await helper.handle({ id: 'poll', operation: 'status' });
  assert.equal(status.status.activeRequestId, 'pending-read');
  assert.equal(status.status.canInspect, false);
  assert.equal((await helper.handle({ id: 'busy', operation: 'discover' })).error.code, 'busy');
  assert.equal((await helper.handle({ id: 'wrong-cancel', operation: 'cancel', requestId: 'other' })).result.cancelled, false);
  assert.equal((await helper.handle({ id: 'cancel', operation: 'cancel', requestId: 'pending-read' })).result.cancelled, true);
  const response = await read;
  assert.equal(response.id, 'pending-read');
  assert.equal(response.error.code, 'cancelled');
  assert.equal(response.error.outcome, 'failed');
  assert.equal(response.status.activeRequestId, null);
  assert.equal(response.status.connected, true);
  const next = await helper.handle({ id: 'next-read', operation: 'inspect', selectionId });
  assert.equal(next.ok, true);
  assert.equal(transport.writesSent, 0);
});

test('timeout and child exit return bounded failure with accurate connection status', async t => {
  for (const mode of ['timeout-read', 'crash-read']) {
    const { helper, transport, selectionId } = await fixture(t, mode);
    const response = await helper.handle({ id: mode, operation: 'inspect', selectionId, timeoutMs: 500 });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, mode === 'timeout-read' ? 'timeout' : 'disconnected');
    assert.equal(response.error.outcome, 'failed');
    assert.equal(response.status.connected, mode === 'timeout-read');
    assert.equal(response.status.realStudioConnected, false);
    if (mode === 'crash-read') {
      assert.equal(response.status.state, 'disconnected');
      assert.equal(response.status.selected, null);
      assert.deepEqual(response.status.sessions, []);
      await transport.waitForClose();
    }
  }
});

test('refresh invalidates a changed target and failed startup closes its peer', async t => {
  const peer = new MockStudioTransport();
  const helper = new StudioReadHelper({
    send: message => peer.send(message), onMessage: listener => peer.onMessage(listener),
    onClose: listener => peer.onClose(listener), close: () => peer.close(),
    start: async () => {}, waitForClose: async () => {}, validateInput: validateFixtureInput,
  }, { mode: 'fixture' });
  t.after(() => helper.close());
  assert.equal((await helper.handle({ id: 'connect', operation: 'connect' })).ok, true);
  await helper.handle({ id: 'select', operation: 'select', studioId: 'studio-b' });
  peer.sessions[1].place_id = '999';
  assert.equal((await helper.handle({ id: 'refresh', operation: 'discover' })).status.selected, null);
  const transport = createFixtureStdioTransport(sdk, 'init-timeout');
  const startup = new StudioReadHelper(transport, { mode: 'fixture' });
  t.after(() => startup.close());
  const failed = await startup.handle({ id: 'start', operation: 'connect', timeoutMs: 500 });
  assert.equal(failed.error.code, 'timeout');
  assert.equal(failed.status.connected, false);
  await transport.waitForClose();
});

const script = fileURLToPath(new URL('../../../scripts/studio-helper.mjs', import.meta.url));
function command(t, args) {
  const child = spawn(process.execPath, [script, ...args], { windowsHide: true, stdio: 'pipe' });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const messages = [], waiters = [];
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (waiters.length) waiters.shift()(message); else messages.push(message);
  });
  const exit = new Promise(resolve => child.on('exit', code => resolve(code)));
  return {
    child, exit, stderr: () => stderr,
    next: () => messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => waiters.push(resolve)),
    send: value => child.stdin.write(JSON.stringify(value) + '\n'),
  };
}

test('local command completes the structured fixture round trip and exits on close', { timeout: 15_000 }, async t => {
  const cli = command(t, ['--fixture']);
  const initial = await cli.next();
  assert.equal(initial.status.state, 'idle');
  assert.equal(initial.status.connected, false);
  cli.send({ id: 'connect', operation: 'connect' });
  assert.equal((await cli.next()).status.sessions.length, 2);
  cli.send({ id: 'select', operation: 'select', studioId: 'studio-b' });
  const selectionId = (await cli.next()).result.selectionId;
  cli.send({ id: 'inspect', operation: 'inspect', selectionId });
  const read = await cli.next();
  assert.equal(read.id, 'inspect');
  assert.equal(read.result.result.structuredContent.studio_id, 'studio-b');
  cli.send({ id: 'close', operation: 'close' });
  assert.equal((await cli.next()).status.state, 'closed');
  assert.equal(await cli.exit, 0, cli.stderr());
});

test('command defaults disabled and rejects owner launch without explicit enable', { timeout: 5_000 }, async t => {
  for (const args of [[], ['--owner-executable', process.execPath]]) {
    const cli = command(t, args);
    const response = await cli.next();
    assert.equal(response.ok, false);
    assert.equal(response.error.code, args.length ? 'invalid_config' : 'transport_disabled');
    assert.equal(await cli.exit, 1);
  }
});
