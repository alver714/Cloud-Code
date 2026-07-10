/**
 * Manual smoke test for the codex app-server transport. Runs ONE trivial real
 * turn against the live `codex app-server`, printing every raw notification and
 * the mapped AgentEvents — so token-usage events can be verified on the VM.
 *
 *   npm run codex-appserver-probe -- [workdir] ["prompt"]
 *
 * Guarded so `npm test` (vitest) never triggers a real spawn: it only runs when
 * executed directly as the entry module.
 */
import { pathToFileURL } from 'node:url';
import { AppServerClient } from './appserver.js';
import { mapAppServerEvents } from './codex-appserver.js';
import type { AppServerNotification } from './appserver.js';

async function main(): Promise<void> {
  const workdir = process.argv[2] ?? process.cwd();
  const prompt = process.argv[3] ?? 'reply with exactly: OK';

  const client = new AppServerClient();
  const queue: AppServerNotification[] = [];
  let wake: (() => void) | undefined;
  const push = (n: AppServerNotification) => {
    console.log('RAW  ', JSON.stringify(n));
    queue.push(n);
    const w = wake;
    wake = undefined;
    w?.();
  };
  async function* stream(): AsyncGenerator<AppServerNotification, void, void> {
    for (;;) {
      while (queue.length > 0) yield queue.shift()!;
      await new Promise<void>((r) => {
        wake = r;
      });
    }
  }

  console.log('[probe] ensureReady…');
  await client.ensureReady();
  console.log(`[probe] app-server pid=${String(client.pid)}`);

  const started = await client.startThread({ cwd: workdir });
  console.log(`[probe] thread=${started.threadId} model=${String(started.model)}`);

  const unsub = client.onNotification(started.threadId, push);
  const turnId = await client.sendTurn(started.threadId, prompt);
  console.log(`[probe] turn=${turnId}`);

  for await (const ev of mapAppServerEvents(stream(), { threadId: started.threadId, workdir })) {
    console.log('EVENT', JSON.stringify(ev));
    if (ev.kind === 'result') break;
  }

  unsub();
  await client.shutdown();
  console.log('[probe] done');
  process.exit(0);
}

// Only run when invoked directly, never on import (keeps vitest from spawning).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error('[probe] failed:', err);
    process.exit(1);
  });
}
