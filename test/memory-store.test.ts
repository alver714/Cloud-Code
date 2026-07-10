import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MEMORY_MAX_CHARS,
  MEMORY_MAX_FACTS,
  MemoryStore,
  type MemoryFact,
} from '../src/memory/store.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-store-'));
  file = path.join(dir, 'memory.json');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

/** ISO string `sec` seconds after a fixed epoch (deterministic ordering). */
function at(sec: number): Date {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, sec));
}

describe('MemoryStore', () => {
  it('adds a fact with defaults and reports size/charCount', async () => {
    const store = new MemoryStore(file);
    await store.load();
    const f = await store.add({ text: '  uses   TypeScript  ', category: 'stack' }, at(1));
    expect(f).not.toBeNull();
    expect(f!.text).toBe('uses TypeScript'); // whitespace collapsed
    expect(f!.category).toBe('stack');
    expect(f!.usageCount).toBe(0);
    expect(f!.id).toBeTruthy();
    expect(store.size()).toBe(1);
    expect(store.charCount()).toBe('uses TypeScript'.length);
  });

  it('defaults an omitted category to other and drops empty text', async () => {
    const store = new MemoryStore(file);
    await store.load();
    const f = await store.add({ text: 'plain fact' });
    expect(f!.category).toBe('other');
    expect(await store.add({ text: '   ' })).toBeNull();
    expect(store.size()).toBe(1);
  });

  it('dedupes case-insensitively on add', async () => {
    const store = new MemoryStore(file);
    await store.load();
    await store.add({ text: 'Uses Vite for bundling', category: 'stack' });
    const dup = await store.add({ text: 'uses vite for  BUNDLING', category: 'preference' });
    expect(dup).toBeNull();
    expect(store.size()).toBe(1);
  });

  it('bumpUsage increments count and recency only for named ids', async () => {
    const store = new MemoryStore(file);
    await store.load();
    const a = (await store.add({ text: 'fact a' }, at(1)))!;
    const b = (await store.add({ text: 'fact b' }, at(2)))!;
    await store.bumpUsage([a.id], at(10));
    const all = store.all();
    expect(all.find((f) => f.id === a.id)!.usageCount).toBe(1);
    expect(all.find((f) => f.id === a.id)!.lastUsedAt).toBe(at(10).toISOString());
    expect(all.find((f) => f.id === b.id)!.usageCount).toBe(0);
  });

  it('removes by id and clears all', async () => {
    const store = new MemoryStore(file);
    await store.load();
    const a = (await store.add({ text: 'fact a' }))!;
    await store.add({ text: 'fact b' });
    expect(await store.remove(a.id)).toBe(true);
    expect(await store.remove('nope')).toBe(false);
    expect(store.size()).toBe(1);
    expect(await store.clear()).toBe(1);
    expect(store.size()).toBe(0);
    expect(await store.clear()).toBe(0);
  });

  it('evicts the lowest-ranked fact past the count cap (usage, then oldest)', async () => {
    const store = new MemoryStore(file);
    await store.load();
    // Fill to the cap; all usageCount 0, increasing lastUsedAt.
    for (let i = 0; i < MEMORY_MAX_FACTS; i++) {
      await store.add({ text: `fact number ${i}` }, at(i));
    }
    // Protect the oldest by giving it usage — it must survive the next eviction.
    const oldest = store.all().find((f) => f.text === 'fact number 0')!;
    await store.bumpUsage([oldest.id], at(500));
    // One more over the cap → evicts the lowest usage, i.e. oldest *unbumped*.
    await store.add({ text: 'the newest fact' }, at(1000));
    expect(store.size()).toBe(MEMORY_MAX_FACTS);
    const texts = store.all().map((f) => f.text);
    expect(texts).toContain('fact number 0'); // bumped → protected
    expect(texts).toContain('the newest fact');
    expect(texts).not.toContain('fact number 1'); // oldest unbumped → evicted
  });

  it('evicts past the char cap', async () => {
    const store = new MemoryStore(file);
    await store.load();
    const big = 'x'.repeat(2_000);
    for (let i = 0; i < 8; i++) await store.add({ text: `${big} ${i}` }, at(i));
    expect(store.charCount()).toBeLessThanOrEqual(MEMORY_MAX_CHARS);
    expect(store.size()).toBeLessThan(8);
  });

  it('round-trips atomically across a reload', async () => {
    const s1 = new MemoryStore(file);
    await s1.load();
    await s1.add({ text: 'persist me', category: 'context' }, at(1));
    await s1.add({ text: 'and me too', category: 'preference' }, at(2));
    const s2 = new MemoryStore(file);
    await s2.load();
    expect(s2.size()).toBe(2);
    expect(s2.all().map((f) => f.text).sort()).toEqual(['and me too', 'persist me']);
  });

  it('tolerates a corrupt file by starting empty', async () => {
    await fs.writeFile(file, '{ this is not valid json', 'utf8');
    const store = new MemoryStore(file);
    await store.load();
    expect(store.size()).toBe(0);
    // still usable
    expect(await store.add({ text: 'fresh start' })).not.toBeNull();
  });

  it('falls back to the .bak when the main file is corrupt', async () => {
    const good: MemoryFact = {
      id: 'abc',
      text: 'backed up fact',
      category: 'other',
      usageCount: 0,
      createdAt: at(1).toISOString(),
      lastUsedAt: at(1).toISOString(),
    };
    await fs.writeFile(file + '.bak', JSON.stringify({ version: 1, facts: [good] }), 'utf8');
    await fs.writeFile(file, 'garbage', 'utf8');
    const store = new MemoryStore(file);
    await store.load();
    expect(store.size()).toBe(1);
    expect(store.all()[0]!.text).toBe('backed up fact');
  });

  it('replaceAll swaps the set and re-enforces caps', async () => {
    const store = new MemoryStore(file);
    await store.load();
    await store.add({ text: 'old one' });
    const many: MemoryFact[] = [];
    for (let i = 0; i < MEMORY_MAX_FACTS + 5; i++) {
      many.push({
        id: `id-${i}`,
        text: `replaced ${i}`,
        category: 'other',
        usageCount: 0,
        createdAt: at(i).toISOString(),
        lastUsedAt: at(i).toISOString(),
      });
    }
    await store.replaceAll(many);
    expect(store.size()).toBe(MEMORY_MAX_FACTS);
    expect(store.all().some((f) => f.text === 'old one')).toBe(false);
  });
});
