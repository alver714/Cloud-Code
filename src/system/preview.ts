import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { sanitizedChildEnv } from '../util/childEnv.js';

/**
 * Live preview for a session: a managed dev-server process plus a Cloudflare
 * quick tunnel (`cloudflared tunnel --url ...`) exposing it as a public
 * https://*.trycloudflare.com URL the owner can open on the phone.
 *
 * One preview per session; a TTL auto-stops it to protect the tiny VM's RAM.
 */

export interface PreviewInfo {
  url: string;
  /** Direct http://IP:port — bypasses DNS filters that block trycloudflare. */
  directUrl?: string;
  port: number;
  /** Human description of the server: command or "port was already listening". */
  server: string;
  /** True when the static fallback (`python3 -m http.server`) serves the ENTIRE
   * workdir (including dot-files) — the UI must warn about this. */
  servesWholeDir?: boolean;
  startedAt: number;
  ttlMs: number;
}

export interface PreviewStartRequest {
  key: string;
  workdir: string;
  /** Explicit port; undefined = auto (scan running servers, then default). */
  port?: number;
  /** Explicit shell command; undefined = auto-detect / reuse a listening port. */
  command?: string;
  /**
   * Server command observed from the agent — used when the port is dead
   * (the agent's background processes do not survive its run).
   */
  fallbackCommand?: string;
  /** Page path announced by the agent — appended to the links. */
  pagePath?: string;
  /** Called when the TTL expires and the preview is torn down. */
  onExpire?: (info: PreviewInfo) => void;
}

/** Ports dev-servers usually pick — scanned when /preview is called bare. */
export const COMMON_DEV_PORTS = [3000, 8000, 5173, 8080, 4321, 5000, 4173, 8888];

/** Well-known internal services that must never be tunneled/proxied publicly. */
const PREVIEW_BLOCKED_PORTS = new Set([
  2375, 2376, // docker daemon
  3306, // mysql
  5432, // postgres
  5672, // rabbitmq
  6379, // redis
  9200, 9300, // elasticsearch
  11211, // memcached
  27017, 27018, // mongodb
]);

/**
 * Port allowlist for previews: common dev ports, otherwise only unprivileged
 * ports (≥1024) that are not a well-known internal service. Blocks exposing
 * ssh/22, smtp/25, postgres/5432, redis/6379 etc. through the public tunnel or
 * the direct proxy (the one-tap preview button goes through this too).
 */
export function isAllowedPreviewPort(port: number): boolean {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
  if (COMMON_DEV_PORTS.includes(port)) return true;
  if (port < 1024) return false;
  return !PREVIEW_BLOCKED_PORTS.has(port);
}

const DEFAULT_PORT = 3000;

interface ActivePreview {
  info: PreviewInfo;
  serverProc?: ChildProcess;
  tunnelProc: ChildProcess;
  ttlTimer: NodeJS.Timeout;
  directServer?: net.Server;
  directPort?: number;
}

/** Public VM IP + range of open ports for direct access. */
export interface DirectAccess {
  externalIp: string;
  portBase: number;
  portCount: number;
}

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const PORT_WAIT_MS = 120_000;
const TUNNEL_WAIT_MS = 45_000;
const OUTPUT_TAIL_LIMIT = 3000;

/** Extracts the public tunnel URL from a cloudflared output line. */
export function extractTunnelUrl(line: string): string | undefined {
  return TUNNEL_URL_RE.exec(line)?.[0];
}

export interface AnnouncedServer {
  port: number;
  /** Page path from the announced URL ("/flip-product-cards.html"). */
  path?: string;
}

/**
 * A server the agent announced itself in the text ("started on
 * http://localhost:8000/page.html"). We take the last mention.
 */
export function extractAnnouncedServer(text: string): AnnouncedServer | undefined {
  const re = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})(\/\S*)?/g;
  let last: AnnouncedServer | undefined;
  for (const m of text.matchAll(re)) {
    const port = Number(m[1]);
    // Allowlist only: never offer the one-tap preview button (or persist the
    // announced port) for privileged/internal-service ports like 22 or 5432.
    if (!isAllowedPreviewPort(port)) continue;
    const rawPath = m[2]?.replace(/[).,;:!?»"']+$/, '');
    last = { port, path: rawPath && rawPath !== '/' ? rawPath : undefined };
  }
  return last;
}

/** @deprecated compatibility — use extractAnnouncedServer */
export function extractAnnouncedPort(text: string): number | undefined {
  return extractAnnouncedServer(text)?.port;
}

/** Which html to serve as the static entry page (when there is no index.html). */
export function pickStaticEntry(htmlFiles: string[]): string | undefined {
  if (htmlFiles.includes('index.html')) return undefined; // the server serves it itself
  return htmlFiles.length === 1 ? `/${htmlFiles[0]}` : undefined;
}

/**
 * Picks a serve command from package.json: dev script first, then start.
 * Returns undefined when there is nothing obvious to run.
 */
export function detectServeCommand(packageJson: string): string | undefined {
  try {
    const pkg = JSON.parse(packageJson) as { scripts?: Record<string, unknown> };
    if (typeof pkg.scripts?.dev === 'string') return 'npm run dev';
    if (typeof pkg.scripts?.start === 'string') return 'npm run start';
  } catch {
    /* not a valid package.json */
  }
  return undefined;
}

export type PreviewArgs =
  | { kind: 'start'; port?: number; command?: string }
  | { kind: 'stop' }
  | { kind: 'status' };

/** Parses "/preview" arguments: [stop|status] | [port] [command...]. */
export function parsePreviewArgs(raw: string): PreviewArgs {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'start' };
  if (trimmed === 'stop') return { kind: 'stop' };
  if (trimmed === 'status') return { kind: 'status' };
  const parts = trimmed.split(/\s+/);
  let port: number | undefined;
  if (/^\d{2,5}$/.test(parts[0]!)) {
    port = Number(parts.shift());
  }
  const command = parts.length > 0 ? parts.join(' ') : undefined;
  return { kind: 'start', port, command };
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port, timeout: 1500 });
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    const fail = () => {
      sock.destroy();
      resolve(false);
    };
    sock.once('error', fail);
    sock.once('timeout', fail);
  });
}

async function waitForPort(port: number, timeoutMs: number, aborted: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (aborted()) return false;
    if (await isPortOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

function killTree(proc: ChildProcess | undefined): void {
  const pid = proc?.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      proc?.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  const timer = setTimeout(() => {
    // If the original process is already gone, skip the SIGKILL — the pgid may
    // have been recycled by an unrelated process by now.
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }, 5000);
  timer.unref();
}

/** Bot secrets and provider credentials must not leak into preview servers. */
function previewEnv(port: number): NodeJS.ProcessEnv {
  return sanitizedChildEnv({ extra: { PORT: String(port), BROWSER: 'none' } });
}

export class PreviewManager {
  private readonly active = new Map<string, ActivePreview>();
  private readonly usedDirectPorts = new Set<number>();

  constructor(
    private readonly ttlMs: number,
    private readonly direct?: DirectAccess,
  ) {}

  /**
   * TCP proxy 0.0.0.0:<external port> → 127.0.0.1:<server port> — direct
   * access bypassing the tunnel (phone DNS filters block trycloudflare).
   */
  private async startDirectProxy(
    targetPort: number,
  ): Promise<{ server: net.Server; port: number } | undefined> {
    if (!this.direct) return undefined;
    for (let i = 0; i < this.direct.portCount; i++) {
      const candidate = this.direct.portBase + i;
      if (this.usedDirectPorts.has(candidate)) continue;
      const server = net.createServer((sock) => {
        const upstream = net.connect({ host: '127.0.0.1', port: targetPort });
        sock.pipe(upstream);
        upstream.pipe(sock);
        const teardown = () => {
          sock.destroy();
          upstream.destroy();
        };
        sock.on('error', teardown);
        upstream.on('error', teardown);
        // 'error' alone leaks the peer socket on a clean half-close.
        sock.on('close', teardown);
        upstream.on('close', teardown);
      });
      const listening = await new Promise<boolean>((resolve) => {
        server.once('error', () => resolve(false));
        server.listen(candidate, '0.0.0.0', () => resolve(true));
      });
      if (listening) {
        this.usedDirectPorts.add(candidate);
        return { server, port: candidate };
      }
    }
    return undefined;
  }

  status(key: string): PreviewInfo | undefined {
    return this.active.get(key)?.info;
  }

  stop(key: string): PreviewInfo | undefined {
    const p = this.active.get(key);
    if (!p) return undefined;
    this.active.delete(key);
    clearTimeout(p.ttlTimer);
    killTree(p.tunnelProc);
    killTree(p.serverProc);
    if (p.directServer) {
      p.directServer.close();
      if (p.directPort !== undefined) this.usedDirectPorts.delete(p.directPort);
    }
    return p.info;
  }

  stopAll(): void {
    for (const key of [...this.active.keys()]) this.stop(key);
  }

  /**
   * Starts (or restarts) the preview for a session:
   * 1) resolve the serve command (explicit → package.json dev/start → reuse an
   *    already-listening port), 2) wait until the port answers, 3) start the
   *    cloudflared quick tunnel and grab its public URL.
   */
  async start(req: PreviewStartRequest): Promise<PreviewInfo> {
    if (req.port !== undefined && !isAllowedPreviewPort(req.port)) {
      throw new Error(
        `Port ${req.port} cannot be exposed publicly (privileged or internal service).`,
      );
    }
    this.stop(req.key); // a fresh /preview replaces the old one

    let port = req.port;
    let command = req.command;
    let pagePath = req.pagePath;
    let serverLabel: string | undefined;
    let serverProc: ChildProcess | undefined;
    let serverExited = false;
    let outputTail = '';
    let servesWholeDir = false;

    if (!command) {
      // 1) An explicitly named port that already answers → just tunnel it.
      if (port !== undefined && (await isPortOpen(port))) {
        serverLabel = `port ${port} was already listening`;
      }
      // 2) Bare /preview → find a server the agent already started.
      if (serverLabel === undefined && port === undefined) {
        const listening: number[] = [];
        for (const p of COMMON_DEV_PORTS) {
          if (await isPortOpen(p)) listening.push(p);
        }
        if (listening.length > 0) {
          port = listening[0]!;
          serverLabel =
            `port ${port} was already listening` +
            (listening.length > 1
              ? ` (also listening: ${listening.slice(1).join(', ')} — /preview <port> for another)`
              : '');
        }
      }
      // 3) Nothing running → figure out how to serve this workdir.
      if (serverLabel === undefined) {
        port ??= DEFAULT_PORT;
        // 3a) The command the agent used to start the server itself: its
        // background processes die with its run — restart the same one from the bot.
        if (req.fallbackCommand) {
          command = req.fallbackCommand;
        }
        // 3b) package.json dev/start.
        if (!command) {
          const pkgRaw = await fs
            .readFile(path.join(req.workdir, 'package.json'), 'utf8')
            .catch(() => undefined);
          command = pkgRaw ? detectServeCommand(pkgRaw) : undefined;
        }
        // 3c) Any static content (not only index.html).
        if (!command) {
          const htmlFiles = await fs
            .readdir(req.workdir)
            .then((names) => names.filter((n) => n.endsWith('.html')).sort())
            .catch(() => [] as string[]);
          if (htmlFiles.length > 0) {
            // NB: http.server serves the ENTIRE workdir with a directory listing
            // (including dot-files) — the UI warns via servesWholeDir;
            // the main guards are the port allowlist and the TTL.
            command = `python3 -m http.server ${port} --bind 127.0.0.1`;
            pagePath ??= pickStaticEntry(htmlFiles);
            servesWholeDir = true;
            console.warn(
              `[preview] static fallback serves the whole workdir with directory listing: ${req.workdir}`,
            );
          } else {
            throw new Error(
              (req.port !== undefined
                ? `Port ${req.port} is not responding, and the server start command is unknown. `
                : `No running server found (checked ports ${COMMON_DEV_PORTS.join(', ')}). `) +
                'The workspace has neither a package.json with dev/start scripts nor any .html files. ' +
                'Ask the agent to start a server and retry, or specify a command: /preview 3000 <command>',
            );
          }
        }
      }
    }
    port ??= DEFAULT_PORT;
    if (!isAllowedPreviewPort(port)) {
      throw new Error(
        `Port ${port} cannot be exposed publicly (privileged or internal service).`,
      );
    }

    if (serverLabel === undefined) {
      serverLabel = command!;
      serverProc = spawn('bash', ['-lc', command!], {
        cwd: req.workdir,
        env: previewEnv(port),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const collect = (chunk: Buffer | string) => {
        outputTail = (outputTail + String(chunk)).slice(-OUTPUT_TAIL_LIMIT);
      };
      serverProc.stdout?.on('data', collect);
      serverProc.stderr?.on('data', collect);
      serverProc.once('close', () => {
        serverExited = true;
      });

      const up = await waitForPort(port, PORT_WAIT_MS, () => serverExited);
      if (!up) {
        killTree(serverProc);
        const reason = serverExited ? 'the server exited without starting to listen on the port' : 'the port never opened';
        throw new Error(`${reason} (${port}).\nOutput tail:\n${outputTail.trim() || '(empty)'}`);
      }
    }

    // Quick tunnel: no account, ephemeral public URL.
    const tunnelProc = spawn(
      'cloudflared',
      ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
      { env: previewEnv(port), detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let url: string;
    try {
      url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('cloudflared did not emit a URL within 45s')),
          TUNNEL_WAIT_MS,
        );
        const scan = (stream: NodeJS.ReadableStream | null) => {
          if (!stream) return;
          const rl = readline.createInterface({ input: stream });
          rl.on('line', (line) => {
            const found = extractTunnelUrl(line);
            if (found) {
              clearTimeout(timer);
              resolve(found);
            }
          });
        };
        scan(tunnelProc.stdout);
        scan(tunnelProc.stderr);
        tunnelProc.once('error', (err) => {
          clearTimeout(timer);
          reject(
            err && String(err).includes('ENOENT')
              ? new Error('cloudflared is not installed on the server')
              : (err as Error),
          );
        });
        tunnelProc.once('close', () => {
          clearTimeout(timer);
          reject(new Error('cloudflared exited without emitting a URL'));
        });
      });
    } catch (err) {
      killTree(tunnelProc);
      killTree(serverProc);
      throw err;
    }

    const direct = await this.startDirectProxy(port).catch(() => undefined);
    const suffix = pagePath ?? '';
    const info: PreviewInfo = {
      url: url + suffix,
      directUrl:
        direct && this.direct
          ? `http://${this.direct.externalIp}:${direct.port}${suffix}`
          : undefined,
      port,
      server: serverLabel,
      ...(servesWholeDir && { servesWholeDir: true }),
      startedAt: Date.now(),
      ttlMs: this.ttlMs,
    };
    const ttlTimer = setTimeout(() => {
      const stopped = this.stop(req.key);
      if (stopped) req.onExpire?.(stopped);
    }, this.ttlMs);
    ttlTimer.unref();

    this.active.set(req.key, {
      info,
      serverProc,
      tunnelProc,
      ttlTimer,
      directServer: direct?.server,
      directPort: direct?.port,
    });
    return info;
  }
}
