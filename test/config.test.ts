import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  TELEGRAM_BOT_TOKEN: '123456:ABCDEFGHIJKLMNOP',
  ALLOWED_USER_IDS: '111, 222 ,333',
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('parses comma-separated allowed user ids', () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.allowedUserIds).toEqual([111, 222, 333]);
  });

  it('rejects an empty ALLOWED_USER_IDS', () => {
    expect(() => loadConfig({ ...base, ALLOWED_USER_IDS: '' })).toThrow();
  });

  it('rejects ALLOWED_USER_IDS with no numeric ids', () => {
    expect(() => loadConfig({ ...base, ALLOWED_USER_IDS: 'abc, xyz' })).toThrow();
  });

  it('expands ~/ in path settings', () => {
    const cfg = loadConfig({ ...base, WORKSPACES_DIR: '~/ws', LOGS_DIR: '~/logs' });
    expect(cfg.workspacesDir).toBe(path.join(os.homedir(), 'ws'));
    expect(cfg.logsDir).toBe(path.join(os.homedir(), 'logs'));
  });
});
