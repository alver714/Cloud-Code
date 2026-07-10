/**
 * Manual engine harness:
 *   npm run engine-cli -- <claude|codex> <workdir> "<prompt>" [--resume <id>] [--model <m>] [--raw-log <path>]
 * Prints normalized AgentEvents as JSON lines.
 */
import { ClaudeEngine } from './claude.js';
import { CodexEngine } from './codex.js';
import type { Engine } from './types.js';

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const argv = process.argv.slice(2);
const positional: string[] = [];
const flags = new Map<string, string>();
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith('--')) {
    const value = argv[i + 1];
    if (value === undefined) fail(`Missing value for ${a}`);
    flags.set(a.slice(2), value);
    i++;
  } else {
    positional.push(a);
  }
}

const [engineName, workdir, prompt] = positional;
if (!engineName || !workdir || !prompt) {
  fail('Usage: harness <claude|codex> <workdir> "<prompt>" [--resume id] [--model m] [--raw-log path]');
}

let engine: Engine;
if (engineName === 'claude') engine = new ClaudeEngine();
else if (engineName === 'codex') engine = new CodexEngine();
else fail(`Unknown engine: ${engineName}`);

const run = engine.run({
  prompt,
  workdir,
  resumeSessionId: flags.get('resume'),
  model: flags.get('model'),
  rawLogPath: flags.get('raw-log'),
});

process.on('SIGINT', () => run.cancel());

for await (const ev of run.events) {
  console.log(JSON.stringify(ev));
}
