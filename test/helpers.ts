import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonlLine, JsonlSource } from '../src/engines/spawn.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Builds a JsonlSource from a recorded raw-log fixture. */
export function fixtureSource(name: string): JsonlSource {
  const file = fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');
  const lines = file.split('\n').filter((l) => l.trim().length > 0);

  async function* gen(): AsyncGenerator<JsonlLine, void, void> {
    for (const raw of lines) {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        json = undefined; // "[run ...]" / "[stderr] ..." marker lines
      }
      yield { raw, json };
    }
  }

  return {
    lines: gen(),
    exited: Promise.resolve({ code: 0, signal: null, stderrTail: '' }),
  };
}

export async function collect<T>(gen: AsyncGenerator<T, void, void>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}
