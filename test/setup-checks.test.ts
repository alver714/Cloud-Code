import { describe, expect, it } from 'vitest';
import {
  buildEnv,
  captureSupergroup,
  captureUser,
  captureUserId,
  extractVersion,
  isValidBotTokenShape,
  maskToken,
  nodeMajor,
  parseGetMe,
  parseGhAuthStatus,
  probeTool,
  verifyGroup,
} from '../src/setup/checks.js';

describe('isValidBotTokenShape', () => {
  it('accepts a real-looking @BotFather token', () => {
    expect(isValidBotTokenShape('1234567890:AAFakeExampleTokenForUnitTests000000')).toBe(true);
  });
  it('trims surrounding whitespace', () => {
    expect(isValidBotTokenShape('  123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789  ')).toBe(true);
  });
  it('rejects malformed tokens', () => {
    expect(isValidBotTokenShape('')).toBe(false);
    expect(isValidBotTokenShape('nope')).toBe(false);
    expect(isValidBotTokenShape('123456789')).toBe(false); // no colon
    expect(isValidBotTokenShape('abc:ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')).toBe(false); // non-numeric id
    expect(isValidBotTokenShape('123:short')).toBe(false); // secret too short
  });
});

describe('parseGetMe', () => {
  it('parses a successful response', () => {
    const r = parseGetMe({ ok: true, result: { id: 42, is_bot: true, username: 'my_bot' } });
    expect(r).toEqual({ ok: true, username: 'my_bot', id: 42 });
  });
  it('reports an error description on failure', () => {
    const r = parseGetMe({ ok: false, error_code: 401, description: 'Unauthorized' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Unauthorized');
  });
  it('rejects a user token (is_bot false)', () => {
    const r = parseGetMe({ ok: true, result: { id: 1, is_bot: false } });
    expect(r.ok).toBe(false);
  });
  it('handles empty / non-object input', () => {
    expect(parseGetMe(null).ok).toBe(false);
    expect(parseGetMe('boom').ok).toBe(false);
  });
});

describe('maskToken', () => {
  it('never reveals the middle and ends with the last four', () => {
    const t = 'sk-ant-oat01-FAKEFAKEFAKEFAKEFAKEFAKE0000000000000000TEST';
    const masked = maskToken(t);
    expect(masked).toContain('…');
    expect(masked.endsWith('TEST')).toBe(true);
    expect(masked).not.toContain('FAKEFAKEFAKE');
  });
  it('keeps the numeric id prefix of a bot token', () => {
    const masked = maskToken('1234567890:AAFakeExampleTokenForUnitTests000000');
    expect(masked.startsWith('1234567890:')).toBe(true);
    expect(masked.endsWith('0000')).toBe(true);
  });
  it('handles empty and tiny inputs', () => {
    expect(maskToken('')).toBe('(empty)');
    expect(maskToken('abc')).toBe('****');
  });
});

describe('extractVersion / nodeMajor', () => {
  it('extracts semver from varied CLI output', () => {
    expect(extractVersion('v22.3.0')).toBe('22.3.0');
    expect(extractVersion('git version 2.39.5 (Apple Git-154)')).toBe('2.39.5');
    expect(extractVersion('gh version 2.40.1 (2024-01-08)')).toBe('2.40.1');
    expect(extractVersion('no numbers here')).toBeUndefined();
  });
  it('reads the Node major', () => {
    expect(nodeMajor('v22.3.0')).toBe(22);
    expect(nodeMajor('v18.19.1')).toBe(18);
    expect(nodeMajor('garbage')).toBeUndefined();
  });
});

describe('probeTool', () => {
  it('marks a present tool with its version', () => {
    expect(probeTool({ code: 0, stdout: 'codex-cli 0.5.2', stderr: '' })).toEqual({
      found: true,
      version: '0.5.2',
    });
  });
  it('reads version from stderr when a tool prints there', () => {
    expect(probeTool({ code: 0, stdout: '', stderr: 'claude 1.2.3' }).version).toBe('1.2.3');
  });
  it('marks a missing tool (null) as not found', () => {
    expect(probeTool(null)).toEqual({ found: false });
  });
  it('marks a non-zero exit as not found', () => {
    expect(probeTool({ code: 127, stdout: '', stderr: 'command not found' }).found).toBe(false);
  });
});

describe('parseGhAuthStatus', () => {
  it('detects a logged-in account (new "account" wording)', () => {
    const res = {
      code: 0,
      stdout: '',
      stderr: 'github.com\n  ✓ Logged in to github.com account alver (keyring)\n',
    };
    expect(parseGhAuthStatus(res)).toEqual({ loggedIn: true, account: 'alver' });
  });
  it('detects the old "as" wording', () => {
    const res = { code: 0, stdout: '✓ Logged in to github.com as octocat (oauth_token)', stderr: '' };
    expect(parseGhAuthStatus(res)).toEqual({ loggedIn: true, account: 'octocat' });
  });
  it('detects a logged-out state', () => {
    const res = { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.' };
    expect(parseGhAuthStatus(res)).toEqual({ loggedIn: false, account: undefined });
  });
  it('treats a missing gh binary (null) as logged out', () => {
    expect(parseGhAuthStatus(null)).toEqual({ loggedIn: false });
  });
});

describe('captureUser / captureUserId', () => {
  const messagePayload = {
    ok: true,
    result: [
      { update_id: 1, message: { from: { id: 777, first_name: 'Alver' }, chat: { id: 777 } } },
    ],
  };
  it('captures the sender from a message update', () => {
    expect(captureUser(messagePayload)).toEqual({ id: 777, firstName: 'Alver' });
    expect(captureUserId(messagePayload)).toBe(777);
  });
  it('returns undefined when there are no updates', () => {
    expect(captureUserId({ ok: true, result: [] })).toBeUndefined();
    expect(captureUser({ ok: true, result: [] })).toBeUndefined();
  });
  it('ignores channel posts (no message.from)', () => {
    const channel = {
      ok: true,
      result: [{ update_id: 5, channel_post: { chat: { id: -100, type: 'channel' } } }],
    };
    expect(captureUserId(channel)).toBeUndefined();
  });
});

describe('captureSupergroup', () => {
  it('captures a supergroup chat id and title', () => {
    const payload = {
      ok: true,
      result: [
        { update_id: 1, message: { from: { id: 1 }, chat: { id: 1, type: 'private' } } },
        {
          update_id: 2,
          message: { from: { id: 1 }, chat: { id: -1001234, type: 'supergroup', title: 'Dev' } },
        },
      ],
    };
    expect(captureSupergroup(payload)).toEqual({ id: -1001234, title: 'Dev' });
  });
  it('returns undefined without a supergroup message', () => {
    const payload = {
      ok: true,
      result: [{ update_id: 1, message: { from: { id: 1 }, chat: { id: 1, type: 'private' } } }],
    };
    expect(captureSupergroup(payload)).toBeUndefined();
  });
});

describe('verifyGroup verdict matrix', () => {
  it('passes when forum + admin + manage topics', () => {
    const v = verifyGroup(
      { type: 'supergroup', is_forum: true },
      { status: 'administrator', can_manage_topics: true },
    );
    expect(v.verdict).toBe('pass');
    expect(v.remediation).toEqual([]);
  });

  it('passes for the creator even without explicit can_manage_topics', () => {
    const v = verifyGroup({ is_forum: true }, { status: 'creator' });
    expect(v.verdict).toBe('pass');
    expect(v.canManageTopics).toBe(true);
  });

  it('flags a non-forum group', () => {
    const v = verifyGroup({ is_forum: false }, { status: 'administrator', can_manage_topics: true });
    expect(v.verdict).toBe('fail');
    expect(v.isForum).toBe(false);
    expect(v.remediation.join(' ')).toMatch(/Topics/);
  });

  it('flags a bot that is not an admin', () => {
    const v = verifyGroup({ is_forum: true }, { status: 'member' });
    expect(v.verdict).toBe('fail');
    expect(v.botIsAdmin).toBe(false);
    expect(v.remediation.join(' ')).toMatch(/administrator/);
  });

  it('flags an admin bot lacking Manage Topics', () => {
    const v = verifyGroup(
      { is_forum: true },
      { status: 'administrator', can_manage_topics: false },
    );
    expect(v.verdict).toBe('fail');
    expect(v.canManageTopics).toBe(false);
    expect(v.remediation.join(' ')).toMatch(/Manage Topics/);
  });

  it('lists every missing requirement at once', () => {
    const v = verifyGroup({ is_forum: false }, { status: 'member' });
    expect(v.remediation.length).toBe(2);
  });
});

describe('buildEnv', () => {
  const base = {
    telegramBotToken: '123456:TOKEN_ABCDEFGHIJKLMNOPQRSTUVWXYZ012',
    allowedUserIds: [777],
  };

  it('local + claude: no OAuth token, resource guard off, transport exec', () => {
    const env = buildEnv({ target: 'local', defaultEngine: 'claude', engines: ['claude'], ...base });
    expect(env).toContain('TELEGRAM_BOT_TOKEN=123456:TOKEN_ABCDEFGHIJKLMNOPQRSTUVWXYZ012');
    expect(env).toContain('ALLOWED_USER_IDS=777');
    expect(env).toContain('DEFAULT_ENGINE=claude');
    expect(env).toContain('CLAUDE_CODE_OAUTH_TOKEN=');
    expect(env).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN=sk-ant/);
    expect(env).toContain('CODEX_TRANSPORT=exec');
    expect(env).toContain('RESOURCE_GUARD=off');
  });

  it('cloud + claude: emits the OAuth token and resource guard on', () => {
    const env = buildEnv({
      target: 'cloud',
      defaultEngine: 'claude',
      engines: ['claude'],
      claudeOauthToken: 'sk-ant-oat01-FAKESECRET',
      ...base,
    });
    expect(env).toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-FAKESECRET');
    expect(env).toContain('RESOURCE_GUARD=on');
    expect(env).toContain('EGRESS_FREE_MB=1024');
    expect(env).toContain('CODEX_TRANSPORT=exec');
  });

  it('local + codex: transport app-server, no Claude token line', () => {
    const env = buildEnv({ target: 'local', defaultEngine: 'codex', engines: ['codex'], ...base });
    expect(env).toContain('DEFAULT_ENGINE=codex');
    expect(env).toContain('CODEX_TRANSPORT=app-server');
    expect(env).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('cloud + both: default engine preserved, both auth lines present, app-server', () => {
    const env = buildEnv({
      target: 'cloud',
      defaultEngine: 'codex',
      engines: ['codex', 'claude'],
      claudeOauthToken: 'sk-ant-oat01-FAKESECRET',
      ...base,
    });
    expect(env).toContain('DEFAULT_ENGINE=codex');
    expect(env).toContain('CODEX_TRANSPORT=app-server');
    expect(env).toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-FAKESECRET');
    expect(env).toContain('~/.codex/auth.json');
  });

  it('joins multiple allowed user ids with commas', () => {
    const env = buildEnv({
      target: 'local',
      defaultEngine: 'claude',
      engines: ['claude'],
      telegramBotToken: base.telegramBotToken,
      allowedUserIds: [1, 2, 3],
    });
    expect(env).toContain('ALLOWED_USER_IDS=1,2,3');
  });
});
