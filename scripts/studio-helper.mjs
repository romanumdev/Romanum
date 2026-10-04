import path from 'node:path';
import { TextDecoder } from 'node:util';
import { StudioReadHelper } from '../packages/studio-bridge/src/index.ts';
import { createFixtureStdioTransport, createOwnerStdioTransport, loadInstalledMcpSdk, StdioTransportError } from '../packages/studio-bridge/src/transport/index.ts';

// Local JSON-lines controller, not an MCP server or a hosted web endpoint.
// All launch options are trusted operator arguments; stdin cannot enable a peer.
const usage = `Romanum Studio read helper (Node 22.18+)
  node scripts/studio-helper.mjs --fixture
  node scripts/studio-helper.mjs --enable-owner --owner-executable <absolute StudioMCP path>
Send one JSON request per line: connect, status, discover, select, inspect, cancel, close.
No arguments leaves the transport disabled. No game edits or network listener.
`;
const args = process.argv.slice(2);
let helper;
let buffer = Buffer.alloc(0);
let stopped = false;
let idleTimer;
const pending = new Set();
const decoder = new TextDecoder('utf-8', { fatal: true });
const write = value => new Promise((resolve, reject) => {
  const text = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(text) > 128 * 1024) { reject(new Error('output_limit')); return; }
  process.stdout.write(text, error => error ? reject(error) : resolve());
});
const stop = () => {
  stopped = true;
  clearTimeout(idleTimer);
  process.stdin.destroy();
  void helper?.close().catch(() => { process.exitCode = 1; });
};
const resetIdle = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(stop, 30_000);
};
const problem = code => ({ id: null, ok: false, ...(helper ? { status: helper.status() } : {}), error: { code, outcome: 'not_dispatched' } });

async function submit(frame) {
  let request;
  try { request = JSON.parse(decoder.decode(frame)); }
  catch { await write(problem('invalid_input')); return; }
  const response = await helper.handle(request);
  await write(response);
  if (request?.operation === 'close' && response.ok) stop();
}

try {
  if (args.length === 1 && args[0] === '--help') {
    process.stderr.write(usage);
  } else if (args.length === 0) {
    await write(problem('transport_disabled'));
    process.exitCode = 1;
  } else {
    const fixture = args.length === 1 && args[0] === '--fixture';
    const owner = args.length === 3 && args[0] === '--enable-owner' && args[1] === '--owner-executable';
    if (!fixture && !owner) {
      await write(problem('invalid_config'));
      process.exitCode = 1;
    } else {
      const sdk = loadInstalledMcpSdk(process.env.ROMANUM_BRIDGE_SDK_ROOT ? path.join(process.env.ROMANUM_BRIDGE_SDK_ROOT, 'package.json') : new URL('../package.json', import.meta.url));
      const transport = fixture ? createFixtureStdioTransport(sdk) : createOwnerStdioTransport({ enabled: true, executable: args[2] }, sdk);
      helper = new StudioReadHelper(transport, { mode: fixture ? 'fixture' : 'owner' });
      await write({ id: null, ok: true, status: helper.status() });
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      process.stdout.on('error', stop);
      resetIdle();
      for await (const chunk of process.stdin) {
        if (stopped) break;
        resetIdle();
        let offset = 0;
        while (offset < chunk.length && !stopped) {
          const newline = chunk.indexOf(10, offset);
          const end = newline === -1 ? chunk.length : newline;
          if (buffer.length + end - offset > 64 * 1024) {
            await write(problem('limit_exceeded'));
            process.exitCode = 1;
            stop();
            break;
          }
          buffer = Buffer.concat([buffer, chunk.subarray(offset, end)]);
          offset = end + (newline === -1 ? 0 : 1);
          if (newline === -1) break;
          const frame = buffer;
          buffer = Buffer.alloc(0);
          const task = submit(frame).catch(() => { process.exitCode = 1; stop(); });
          pending.add(task);
          void task.finally(() => pending.delete(task));
          // Keep output backpressure bounded while allowing status/cancel during a read.
          if (pending.size >= 16) await Promise.race(pending);
        }
      }
      // EOF is a stop signal: never leave a read or child running after its owner leaves.
      if (buffer.length && !stopped) { await write(problem('invalid_input')); process.exitCode = 1; }
      stop();
      await Promise.all(pending);
    }
  }
} catch (error) {
  if (!stopped) {
    process.exitCode = 1;
    await write(problem(error instanceof StdioTransportError ? error.code : 'helper_failed')).catch(() => undefined);
  }
} finally {
  clearTimeout(idleTimer);
  try { await helper?.close(); } catch { process.exitCode = 1; }
}
