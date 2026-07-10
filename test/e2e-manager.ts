/**
 * Manual integration check (spends real tokens, not run by vitest):
 *   npx tsx test/e2e-manager.ts <workdir> [claude|codex]
 * Drives SessionManager with a real engine and a console reporter,
 * verifies run + resume against the persistent store.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClaudeEngine } from '../src/engines/claude.js';
import { CodexEngine } from '../src/engines/codex.js';
import type { EngineKind } from '../src/engines/types.js';
import { SessionManager } from '../src/sessions/manager.js';
import { SessionStore } from '../src/sessions/store.js';
import type { Session } from '../src/sessions/types.js';

const workdir = process.argv[2];
const engineKind = (process.argv[3] ?? 'claude') as EngineKind;
if (!workdir) {
  console.error('usage: tsx test/e2e-manager.ts <workdir> [claude|codex]');
  process.exit(1);
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-manager-'));
const store = new SessionStore(path.join(dir, 'sessions.json'));
await store.load();

const session: Session = {
  chatId: -1,
  topicId: 1,
  name: 'e2e',
  engine: engineKind,
  repoUrl: 'local/fixrepo',
  workdir,
  status: 'idle',
  createdAt: new Date().toISOString(),
};
await store.upsert(session);

const manager = new SessionManager(
  store,
  { claude: new ClaudeEngine(), codex: new CodexEngine() },
  (_s, prompt) => ({
    async start() {
      console.log(`[reporter] ▶ ${prompt}`);
    },
    onEvent(ev) {
      console.log(`[reporter] ${JSON.stringify(ev).slice(0, 160)}`);
    },
    async end(summary) {
      console.log(
        `[reporter] ■ ok=${summary.ok} cancelled=${summary.cancelled} cost=${summary.costUsd ?? '-'}`,
      );
    },
  }),
  {
    logsDir: dir,
    maxConcurrentRuns: 2,
    defaultModels: {},
    guard: { softTokens: 100_000, hardTokens: 250_000, maxSteps: 200 },
    preflightPct: 0,
  },
);

async function waitIdle(): Promise<void> {
  while (manager.activeCount() > 0) await new Promise((r) => setTimeout(r, 300));
}

await manager.submitPrompt(session, 'Reply with exactly: E2E-OK');
await waitIdle();
const afterFirst = store.get(-1, 1)!;
console.log(`\n== after run 1: status=${afterFirst.status} engineSessionId=${afterFirst.engineSessionId}\n`);
if (afterFirst.status !== 'idle' || !afterFirst.engineSessionId) {
  console.error('FAIL: first run did not complete cleanly');
  process.exit(1);
}

await manager.submitPrompt(session, 'What did you just reply with? Answer with only that exact text.');
await waitIdle();
const afterSecond = store.get(-1, 1)!;
console.log(`\n== after run 2 (resume): status=${afterSecond.status} engineSessionId=${afterSecond.engineSessionId}`);

await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
console.log(afterSecond.status === 'idle' ? '\nE2E PASS' : '\nE2E FAIL');
process.exit(afterSecond.status === 'idle' ? 0 : 1);
