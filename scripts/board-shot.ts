#!/usr/bin/env node
/**
 * Fast, low-token CLI for rendering chess position screenshots (PNG or SVG)
 * with arrows, square highlights, badges, eval bar, and legend pills.
 *
 * Run with: `node scripts/board-shot.ts --help` or `npm run shot -- --help`
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  renderBoardHtml,
  renderBoardSvg,
  type BoardSpec,
  type ResolvedBoard,
} from './board-render.ts';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, '.data', 'shots');

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((p): p is string => Boolean(p));

const HELP = `Usage:
  node scripts/board-shot.ts [options]
  npm run shot -- [options]

Position:
  -m, --moves <pgn>        PGN or space-separated SAN/UCI moves from start (or --fen)
  -f, --fen <fen>          Starting FEN (default: standard starting position)
      --flip, --black      Show board from Black's perspective
      --orientation <side> white | black
      --last <sqsq|none>   Override last-move highlight (e.g. "e2e4") or "none"

Annotations (repeatable):
  -a, --arrow <spec>       <san|from-to>[:color[/dashed|dotted][:label]]
                           Examples: "Nc3:red:Remove 7. Nc3"  "d5:green:Replace 7. d5"
                                     "b1c3:blue/dashed:Idea"
  -H, --highlight <spec>   <sq[,sq...]>[:color[:label]]   e.g. "b7:red:Weak b7"
  -b, --badge <spec>       <sq>:<glyph>[:color]           e.g. "e5:?!:yellow"
  -e, --eval <score>       Eval bar score, e.g. "+0.86", "-1.4", "M3"

Card & output:
  -t, --title <text>       Card title
  -s, --subtitle <text>    Subtitle under the title
      --note <text>        Footer caption below the board
      --no-turn            Hide the "White/Black to move" pill in the header
      --width <px>         Board width in CSS px (default: 528)
      --scale <n>          Retina scale factor for PNG (default: 2)
      --format <png|svg>   Output format (default: png)
  -o, --out <path>         Output file path (default: .data/shots/<slug>.png)
      --out-dir <dir>      Output directory for auto-named or batch files
      --markdown           Print Markdown image tags instead of bare paths
      --batch [file]       Read JSON BoardSpec (or array) from file or stdin ("-")
  -h, --help               Show this help

Colors: red, green, blue, orange, purple, yellow, amber, cyan, pink, lime, teal, indigo, ivory, gray, or #hex.
`;

function findChrome(): string {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    'Could not find Chrome/Chromium binary. Install Google Chrome or set CHROME_BIN=/path/to/chrome (or pass --format svg).',
  );
}

type CdpResponse = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message: string };
};

/**
 * Lightweight Chrome DevTools Protocol driver using Node's native WebSocket.
 * Launches Chrome once so single and batch screenshots are both fast and
 * auto-cropped to the exact `#card` bounding box.
 */
export class ChromeRenderer {
  private proc: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private userDataDir: string | null = null;
  private sessionId = '';
  private frameId = '';
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();

  async start(): Promise<void> {
    const chromeBin = findChrome();
    this.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-shot-'));
    const proc = spawn(
      chromeBin,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--remote-debugging-port=0',
        `--user-data-dir=${this.userDataDir}`,
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    this.proc = proc;

    const wsUrl = await new Promise<string>((resolve, reject) => {
      let stderrBuf = '';
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for Chrome DevTools.\n${stderrBuf}`));
      }, 10_000);

      proc.once('error', err => {
        clearTimeout(timer);
        reject(err);
      });
      proc.once('exit', code => {
        clearTimeout(timer);
        reject(new Error(`Chrome exited early with code ${code}.\n${stderrBuf}`));
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf8');
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderrBuf);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
    });

    await this.connect(wsUrl);
    const { targetId } = (await this.send('Target.createTarget', { url: 'about:blank' })) as {
      targetId: string;
    };
    const { sessionId } = (await this.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    })) as { sessionId: string };
    this.sessionId = sessionId;

    const tree = (await this.send('Page.getFrameTree', {}, sessionId)) as {
      frameTree: { frame: { id: string } };
    };
    this.frameId = tree.frameTree.frame.id;
  }

  private connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket connection failed')), {
        once: true,
      });
      ws.addEventListener('message', ev => {
        const msg = JSON.parse(String(ev.data)) as CdpResponse;
        if (msg.id === undefined) return;
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(`CDP error: ${msg.error.message}`));
        else entry.resolve(msg.result ?? {});
      });
    });
  }

  private send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    const ws = this.ws;
    if (!ws) return Promise.reject(new Error('ChromeRenderer not started'));
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      ws.send(JSON.stringify(payload));
    });
  }

  async renderPng(html: string, viewportWidth: number, scale: number): Promise<Buffer> {
    await this.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width: viewportWidth,
        height: 2000,
        deviceScaleFactor: scale,
        mobile: false,
      },
      this.sessionId,
    );

    await this.send('Page.setDocumentContent', { frameId: this.frameId, html }, this.sessionId);

    const evalRes = (await this.send(
      'Runtime.evaluate',
      {
        expression: `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
          const r = document.getElementById('card').getBoundingClientRect();
          resolve(JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height }));
        })))`,
        awaitPromise: true,
        returnByValue: true,
      },
      this.sessionId,
    )) as { result?: { value?: string } };

    const rect = JSON.parse(evalRes.result?.value ?? '{}') as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    if (!rect.width || !rect.height) {
      throw new Error('Failed to measure #card element dimensions');
    }

    const shot = (await this.send(
      'Page.captureScreenshot',
      {
        format: 'png',
        clip: {
          x: rect.x,
          y: rect.y,
          width: Math.ceil(rect.width),
          height: Math.ceil(rect.height),
          scale: 1,
        },
      },
      this.sessionId,
    )) as { data: string };

    return Buffer.from(shot.data, 'base64');
  }

  async close(): Promise<void> {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM');
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          try {
            this.proc?.kill('SIGKILL');
          } catch {
            // ignore
          }
          resolve();
        }, 1500);
        this.proc?.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.proc = null;
    if (this.userDataDir) {
      fs.rmSync(this.userDataDir, { recursive: true, force: true });
      this.userDataDir = null;
    }
  }
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return slug || 'board';
}

function resolveOutPath(
  spec: BoardSpec,
  explicitOut: string | undefined,
  outDir: string,
  ext: 'png' | 'svg',
): string {
  const raw = spec.out ?? explicitOut;
  if (raw) {
    const withExt = raw.endsWith(`.${ext}`) || path.extname(raw) ? raw : `${raw}.${ext}`;
    return path.isAbsolute(withExt) ? withExt : path.resolve(outDir, withExt);
  }
  const base = slugify(spec.title ?? 'board');
  const hash = createHash('sha1').update(JSON.stringify(spec)).digest('hex').slice(0, 8);
  return path.resolve(outDir, `${base}_${hash}.${ext}`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function formatLine(outPath: string, resolved: ResolvedBoard, markdown: boolean): string {
  if (!markdown) return outPath;
  const alt = resolved.title ?? 'Chess position';
  return `![${alt}](${outPath})`;
}

async function main(): Promise<void> {
  // Support `--batch` with an optional file path by normalizing bare `--batch` before parseArgs.
  const rawArgs = process.argv.slice(2);
  const normalizedArgs: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--batch') {
      const next = rawArgs[i + 1];
      if (!next || next.startsWith('-')) {
        normalizedArgs.push('--batch=-');
        continue;
      }
    }
    normalizedArgs.push(arg);
  }

  const { values } = parseArgs({
    args: normalizedArgs,
    options: {
      moves: { type: 'string', short: 'm' },
      fen: { type: 'string', short: 'f' },
      flip: { type: 'boolean', default: false },
      black: { type: 'boolean', default: false },
      orientation: { type: 'string' },
      last: { type: 'string' },
      arrow: { type: 'string', short: 'a', multiple: true },
      highlight: { type: 'string', short: 'H', multiple: true },
      badge: { type: 'string', short: 'b', multiple: true },
      eval: { type: 'string', short: 'e' },
      title: { type: 'string', short: 't' },
      subtitle: { type: 'string', short: 's' },
      note: { type: 'string' },
      'no-turn': { type: 'boolean', default: false },
      width: { type: 'string' },
      scale: { type: 'string' },
      format: { type: 'string', default: 'png' },
      out: { type: 'string', short: 'o' },
      'out-dir': { type: 'string' },
      markdown: { type: 'boolean', default: false },
      batch: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const format = (values.format ?? 'png').toLowerCase();
  if (format !== 'png' && format !== 'svg') {
    throw new Error(`Unsupported --format "${values.format}". Use "png" or "svg".`);
  }
  const scale = values.scale ? Number(values.scale) : 2;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 4) {
    throw new Error(`Invalid --scale "${values.scale}". Use a number between 0.5 and 4.`);
  }
  const width = values.width ? Number(values.width) : undefined;
  if (width !== undefined && (!Number.isFinite(width) || width < 240)) {
    throw new Error(`Invalid --width "${values.width}". Use a number >= 240.`);
  }

  const outDir = values['out-dir']
    ? path.resolve(values['out-dir'])
    : values.out && !values.batch
      ? path.dirname(path.resolve(values.out))
      : DEFAULT_OUT_DIR;

  let specs: BoardSpec[];
  if (values.batch !== undefined) {
    const rawJson =
      values.batch === '-' ? await readStdin() : fs.readFileSync(values.batch, 'utf8');
    const parsed = JSON.parse(rawJson) as BoardSpec | BoardSpec[];
    specs = Array.isArray(parsed) ? parsed : [parsed];
    if (!specs.length) throw new Error('Batch JSON array is empty.');
    for (const s of specs) {
      if (width !== undefined && s.width === undefined) s.width = width;
    }
  } else {
    const orientation =
      values.orientation === 'white' || values.orientation === 'black'
        ? values.orientation
        : values.flip || values.black
          ? 'black'
          : undefined;
    if (values.orientation && !orientation) {
      throw new Error(`Invalid --orientation "${values.orientation}". Use "white" or "black".`);
    }
    specs = [
      {
        fen: values.fen,
        moves: values.moves,
        orientation,
        lastMove: values.last === 'none' ? false : values.last,
        arrows: values.arrow,
        highlights: values.highlight,
        badges: values.badge,
        eval: values.eval,
        title: values.title,
        subtitle: values.subtitle,
        note: values.note,
        hideTurn: values['no-turn'],
        width,
      },
    ];
  }

  const explicitSingleOut = !values.batch && values.out ? path.resolve(values.out) : undefined;

  if (format === 'svg') {
    for (const spec of specs) {
      const { svg, resolved } = renderBoardSvg(spec);
      const outPath = resolveOutPath(spec, explicitSingleOut, outDir, 'svg');
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, svg, 'utf8');
      process.stdout.write(`${formatLine(outPath, resolved, Boolean(values.markdown))}\n`);
    }
    return;
  }

  const prepared = specs.map(spec => ({
    spec,
    ...renderBoardHtml(spec),
    outPath: resolveOutPath(spec, explicitSingleOut, outDir, 'png'),
  }));

  const renderer = new ChromeRenderer();
  try {
    await renderer.start();
    for (const item of prepared) {
      const png = await renderer.renderPng(item.html, item.viewportWidth, scale);
      fs.mkdirSync(path.dirname(item.outPath), { recursive: true });
      fs.writeFileSync(item.outPath, png);
      process.stdout.write(
        `${formatLine(item.outPath, item.resolved, Boolean(values.markdown))}\n`,
      );
    }
  } finally {
    await renderer.close();
  }
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`board-shot error: ${message}\n`);
    process.exitCode = 1;
  });
}
