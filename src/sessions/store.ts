import fs from 'node:fs/promises';
import path from 'node:path';
import { sessionKey, type Session } from './types.js';

interface StoreFile {
  version: 1;
  sessions: Session[];
}

/**
 * In-memory registry persisted to a single JSON file.
 * Writes are atomic (tmp + rename) and serialized; the previous good
 * state is kept as <file>.bak and used as fallback on corruption.
 */
export class SessionStore {
  private sessions = new Map<string, Session>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    const tryRead = async (p: string): Promise<StoreFile | undefined> => {
      try {
        const data = await fs.readFile(p, 'utf8');
        const parsed = JSON.parse(data) as StoreFile;
        if (!Array.isArray(parsed.sessions)) return undefined;
        return parsed;
      } catch {
        return undefined;
      }
    };

    const file = (await tryRead(this.filePath)) ?? (await tryRead(this.filePath + '.bak'));
    this.sessions.clear();
    for (const s of file?.sessions ?? []) {
      if (typeof s?.chatId === 'number' && typeof s?.topicId === 'number') {
        this.sessions.set(sessionKey(s.chatId, s.topicId), s);
      }
    }
  }

  get(chatId: number, topicId: number): Session | undefined {
    return this.sessions.get(sessionKey(chatId, topicId));
  }

  getByKey(key: string): Session | undefined {
    return this.sessions.get(key);
  }

  all(): Session[] {
    return [...this.sessions.values()];
  }

  async upsert(session: Session): Promise<void> {
    this.sessions.set(sessionKey(session.chatId, session.topicId), session);
    await this.persist();
  }

  async delete(chatId: number, topicId: number): Promise<void> {
    if (this.sessions.delete(sessionKey(chatId, topicId))) {
      await this.persist();
    }
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(
      { version: 1, sessions: [...this.sessions.values()] } satisfies StoreFile,
      null,
      2,
    );
    // .catch isolates each write: one failed write must not poison the chain
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      const dir = path.dirname(this.filePath);
      await fs.mkdir(dir, { recursive: true });
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
