import { describe, expect, it } from 'vitest';
import {
  detectServeCommand,
  extractAnnouncedPort,
  extractAnnouncedServer,
  extractTunnelUrl,
  isAllowedPreviewPort,
  parsePreviewArgs,
  pickStaticEntry,
} from '../src/system/preview.js';

describe('isAllowedPreviewPort', () => {
  it('allows common dev ports and unprivileged ports', () => {
    for (const p of [3000, 8000, 5173, 8080, 4321, 5000, 4173, 8888]) {
      expect(isAllowedPreviewPort(p)).toBe(true);
    }
    expect(isAllowedPreviewPort(1024)).toBe(true);
    expect(isAllowedPreviewPort(4200)).toBe(true);
    expect(isAllowedPreviewPort(65535)).toBe(true);
  });

  it('rejects privileged ports (ssh, smtp, http, https, dns…)', () => {
    for (const p of [22, 25, 53, 80, 443, 1023]) {
      expect(isAllowedPreviewPort(p)).toBe(false);
    }
  });

  it('rejects well-known internal service ports', () => {
    for (const p of [3306, 5432, 6379, 9200, 11211, 27017, 5672, 2375]) {
      expect(isAllowedPreviewPort(p)).toBe(false);
    }
  });

  it('rejects nonsense', () => {
    expect(isAllowedPreviewPort(0)).toBe(false);
    expect(isAllowedPreviewPort(-1)).toBe(false);
    expect(isAllowedPreviewPort(65536)).toBe(false);
    expect(isAllowedPreviewPort(3000.5)).toBe(false);
  });
});

describe('extractAnnouncedServer', () => {
  it('captures port and page path, trimming trailing punctuation', () => {
    expect(extractAnnouncedServer('open http://localhost:8080/flip-product-cards.html')).toEqual({
      port: 8080,
      path: '/flip-product-cards.html',
    });
    expect(extractAnnouncedServer('lives at localhost:3000.')).toEqual({
      port: 3000,
      path: undefined,
    });
  });

  it('never announces privileged or internal-service ports (no one-tap button)', () => {
    expect(extractAnnouncedServer('ssh available at localhost:22')).toBeUndefined();
    expect(extractAnnouncedServer('postgres running at 127.0.0.1:5432')).toBeUndefined();
    expect(extractAnnouncedServer('redis at localhost:6379')).toBeUndefined();
    // …but a later legit dev port still wins
    expect(extractAnnouncedServer('db at localhost:5432, app at localhost:3000')).toEqual({
      port: 3000,
      path: undefined,
    });
  });
});

describe('pickStaticEntry', () => {
  it('suggests the single html when there is no index.html', () => {
    expect(pickStaticEntry(['flip-product-cards.html'])).toBe('/flip-product-cards.html');
    expect(pickStaticEntry(['index.html', 'about.html'])).toBeUndefined();
    expect(pickStaticEntry(['a.html', 'b.html'])).toBeUndefined();
  });
});

describe('extractAnnouncedPort', () => {
  it('finds the LAST announced local port in agent text', () => {
    expect(extractAnnouncedPort('started at http://localhost:8000')).toBe(8000);
    expect(
      extractAnnouncedPort('brought up at 127.0.0.1:3000, then restarted at localhost:5173'),
    ).toBe(5173);
    expect(extractAnnouncedPort('listening on 0.0.0.0:8080')).toBe(8080);
  });

  it('ignores text without local hosts and absurd ports', () => {
    expect(extractAnnouncedPort('see https://example.com:8443/docs')).toBeUndefined();
    expect(extractAnnouncedPort('plain text without ports')).toBeUndefined();
    expect(extractAnnouncedPort('localhost:99999')).toBeUndefined();
  });
});

describe('parsePreviewArgs', () => {
  it('parses plain, stop and status forms', () => {
    expect(parsePreviewArgs('')).toEqual({ kind: 'start' });
    expect(parsePreviewArgs('stop')).toEqual({ kind: 'stop' });
    expect(parsePreviewArgs('status')).toEqual({ kind: 'status' });
  });

  it('parses port and command combinations', () => {
    expect(parsePreviewArgs('5173')).toEqual({ kind: 'start', port: 5173, command: undefined });
    expect(parsePreviewArgs('3000 npm run dev')).toEqual({
      kind: 'start',
      port: 3000,
      command: 'npm run dev',
    });
    // no leading port → everything is the command
    expect(parsePreviewArgs('npx serve -l 8080')).toEqual({
      kind: 'start',
      port: undefined,
      command: 'npx serve -l 8080',
    });
  });
});

describe('extractTunnelUrl', () => {
  it('finds the trycloudflare URL inside cloudflared banner lines', () => {
    expect(
      extractTunnelUrl('|  https://random-words-here-1234.trycloudflare.com  |'),
    ).toBe('https://random-words-here-1234.trycloudflare.com');
    expect(extractTunnelUrl('INF Starting tunnel')).toBeUndefined();
  });
});

describe('detectServeCommand', () => {
  it('prefers dev over start, tolerates junk', () => {
    expect(detectServeCommand(JSON.stringify({ scripts: { dev: 'vite', start: 'node s' } }))).toBe(
      'npm run dev',
    );
    expect(detectServeCommand(JSON.stringify({ scripts: { start: 'node s' } }))).toBe(
      'npm run start',
    );
    expect(detectServeCommand(JSON.stringify({ scripts: {} }))).toBeUndefined();
    expect(detectServeCommand('not json')).toBeUndefined();
  });
});
