import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Coarse bucket a durable fact falls into (mirrors codex's memory taxonomy). */
export type MemoryCategory = 'stack' | 'convention' | 'preference' | 'context' | 'other';

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  'stack',
  'convention',
  'preference',
  'context',
  'other',
];

/** One durable, cross-session fact about the owner or their projects. */
export interface MemoryFact {
  id: string;
  text: string;
  category: MemoryCategory;
  /** How many runs this fact has been injected into (ranking signal). */
  usageCount: number;
  createdAt: string;
  lastUsedAt: string;
  /**
   * owner/repo the fact was extracted in (session.repoUrl at extraction time).
   * Missing on old/manual facts — treated as global-but-sanitized at injection
   * time (see selectMemoryForInjection): cross-repo facts are injected only if
   * they are declarative (stack/convention/preference) AND pass sanitizeFact.
   */
  repo?: string;
}

/** A fact as extracted / manually added, before it gets an id + counters. */
export interface NewFact {
  text: string;
  category?: MemoryCategory;
  /** Repo scope (session.repoUrl) — see MemoryFact.repo. */
  repo?: string;
}

interface MemoryFile {
  version: 1;
  facts: MemoryFact[];
}

/** Hard caps — over either, the lowest-ranked facts are evicted (codex pattern). */
export const MEMORY_MAX_FACTS = 60;
export const MEMORY_MAX_CHARS = 12_000;

function isCategory(v: unknown): v is MemoryCategory {
  return typeof v === 'string' && (MEMORY_CATEGORIES as readonly string[]).includes(v);
}

/** Normalize a fact's text for case-insensitive dedupe. */
export function normalizeFactText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Per-owner durable memory persisted to a tiny JSON file next to sessions.json
 * (atomic tmp+rename, .bak fallback — mirrors SessionStore/UsageAccounting).
 * Every read tolerates a missing or corrupt file by starting empty: memory is a
 * best-effort convenience and must never break a run or a command.
 */
export class MemoryStore {
  private data: MemoryFile = { version: 1, facts: [] };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    const tryRead = async (p: string): Promise<MemoryFact[] | undefined> => {
      try {
        const raw = await fs.readFile(p, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        const facts = (parsed as MemoryFile | undefined)?.facts;
        if (!Array.isArray(facts)) return undefined;
        return facts.filter(
          (f): f is MemoryFact =>
            !!f &&
            typeof f === 'object' &&
            typeof (f as MemoryFact).id === 'string' &&
            typeof (f as MemoryFact).text === 'string' &&
            isCategory((f as MemoryFact).category),
        );
      } catch {
        return undefined;
      }
    };
    const facts = (await tryRead(this.filePath)) ?? (await tryRead(this.filePath + '.bak'));
    this.data = { version: 1, facts: (facts ?? []).map(normalizeStored) };
  }

  /** All stored facts (a copy — callers must not mutate the internal array). */
  all(): MemoryFact[] {
    return this.data.facts.map((f) => ({ ...f }));
  }

  size(): number {
    return this.data.facts.length;
  }

  /** Total characters across all fact texts (the char-budget signal). */
  charCount(): number {
    return this.data.facts.reduce((n, f) => n + f.text.length, 0);
  }

  /**
   * Add a fact unless a case-insensitive text match already exists. Returns the
   * created fact, or null when it was a duplicate (or empty). Caps are enforced
   * after insertion. Persists best-effort.
   */
  async add(fact: NewFact, now: Date = new Date()): Promise<MemoryFact | null> {
    const text = fact.text.replace(/\s+/g, ' ').trim();
    if (!text) return null;
    const norm = normalizeFactText(text);
    if (this.data.facts.some((f) => normalizeFactText(f.text) === norm)) return null;
    const iso = now.toISOString();
    const created: MemoryFact = {
      id: randomUUID(),
      text,
      category: fact.category ?? 'other',
      usageCount: 0,
      createdAt: iso,
      lastUsedAt: iso,
      ...(fact.repo ? { repo: fact.repo } : {}),
    };
    this.data.facts.push(created);
    this.enforceCaps();
    await this.persist();
    return created;
  }

  /** Bump usageCount + lastUsedAt for the given ids (facts actually injected). */
  async bumpUsage(ids: string[], now: Date = new Date()): Promise<void> {
    if (ids.length === 0) return;
    const set = new Set(ids);
    const iso = now.toISOString();
    let changed = false;
    for (const f of this.data.facts) {
      if (set.has(f.id)) {
        f.usageCount += 1;
        f.lastUsedAt = iso;
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  /** Remove a fact by exact id. Returns true if one was removed. */
  async remove(id: string): Promise<boolean> {
    const before = this.data.facts.length;
    this.data.facts = this.data.facts.filter((f) => f.id !== id);
    if (this.data.facts.length === before) return false;
    await this.persist();
    return true;
  }

  /** Drop every fact (for `/memories forget all`). */
  async clear(): Promise<number> {
    const n = this.data.facts.length;
    if (n === 0) return 0;
    this.data.facts = [];
    await this.persist();
    return n;
  }

  /** Replace the whole set (consolidation path). Caps re-enforced. */
  async replaceAll(facts: MemoryFact[]): Promise<void> {
    this.data.facts = facts.map(normalizeStored);
    this.enforceCaps();
    await this.persist();
  }

  /**
   * Enforce the count + char caps by evicting the lowest-ranked facts first:
   * lowest usageCount, then oldest lastUsedAt (the codex ranking). In place.
   */
  private enforceCaps(): void {
    const overCount = () => this.data.facts.length > MEMORY_MAX_FACTS;
    const overChars = () =>
      this.data.facts.reduce((n, f) => n + f.text.length, 0) > MEMORY_MAX_CHARS;
    while (this.data.facts.length > 1 && (overCount() || overChars())) {
      let worst = 0;
      for (let i = 1; i < this.data.facts.length; i++) {
        if (rankWorse(this.data.facts[i]!, this.data.facts[worst]!)) worst = i;
      }
      this.data.facts.splice(worst, 1);
    }
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2);
    // .catch isolates each write: one failed write must not poison the chain
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = this.filePath + '.tmp';
      await fs.writeFile(tmp, snapshot, 'utf8');
      try {
        await fs.copyFile(this.filePath, this.filePath + '.bak');
      } catch {
        /* first write — no previous state */
      }
      await fs.rename(tmp, this.filePath);
    });
    return this.writeChain;
  }
}

/** True when `a` ranks lower (more evictable) than `b`. */
function rankWorse(a: MemoryFact, b: MemoryFact): boolean {
  if (a.usageCount !== b.usageCount) return a.usageCount < b.usageCount;
  return a.lastUsedAt < b.lastUsedAt; // older loses the tie
}

/** Coerce a loaded/replaced fact into a clean shape with sane defaults. */
function normalizeStored(f: MemoryFact): MemoryFact {
  const now = new Date().toISOString();
  return {
    id: typeof f.id === 'string' && f.id ? f.id : randomUUID(),
    text: String(f.text ?? '').replace(/\s+/g, ' ').trim(),
    category: isCategory(f.category) ? f.category : 'other',
    usageCount: Number.isFinite(f.usageCount) ? Math.max(0, Math.floor(f.usageCount)) : 0,
    createdAt: typeof f.createdAt === 'string' ? f.createdAt : now,
    lastUsedAt: typeof f.lastUsedAt === 'string' ? f.lastUsedAt : now,
    ...(typeof f.repo === 'string' && f.repo ? { repo: f.repo } : {}),
  };
}
