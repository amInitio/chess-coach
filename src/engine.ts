export type Line = { move: string; cp: number; pv: string[] }; // cp: side-to-move view
type Opts = { depth?: number; movetime?: number; multipv?: number; skill?: number };
export const MATE = 100000; // mate scores = MATE - n, far above any real eval

const BOOT_ATTEMPTS = 2; // worker start tries (files are already local by then)
const HANDSHAKE_MS = 20_000; // uci/isready must answer quickly once the worker is alive
const SEARCH_MS = 120_000; // hard cap for any single search (movetime here is <= 600ms)
const STOP_GRACE_MS = 5_000; // after "stop", grace period for the final bestmove
const CACHE = 'stockfish-v1'; // must match public/sw.js
const STALL_MS = 15_000; // no bytes for this long = stalled connection
const DL_TRIES = 5; // download attempts per file (each one resumes where the last stopped)
const FAIL_MSG = 'دانلود موتور شطرنج ناتمام ماند. اینترنت را بررسی کن و «تلاش دوباره» را بزن.';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------- observable status, so the UI can show progress / failure ---------- */
export type EngineState = {
  phase: 'downloading' | 'ready' | 'failed'; // 'ready' = engine files are available locally
  loaded: number; total: number; note: string;
};
let state: EngineState = { phase: 'downloading', loaded: 0, total: 0, note: '' };
const subs = new Set<() => void>();
const setState = (p: Partial<EngineState>) => { state = { ...state, ...p }; subs.forEach((f) => f()); };
export const getEngineState = () => state;
export const subscribeEngine = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

/* ---------- downloading: stall detection + resume with Range + progress ---------- */
async function download(
  url: string,
  onProgress: (loaded: number, total: number) => void,
  onNote: (s: string) => void,
): Promise<Response> {
  const chunks: Uint8Array[] = [];
  let loaded = 0, total = 0, type = 'application/octet-stream', encoded = false;
  for (let attempt = 0; attempt < DL_TRIES; attempt++) {
    const ctl = new AbortController();
    let timer = setTimeout(() => ctl.abort(), STALL_MS);
    try {
      const res = await fetch(url, { signal: ctl.signal, cache: 'no-store', headers: loaded ? { Range: `bytes=${loaded}-` } : {} });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (loaded && res.status !== 206) { chunks.length = 0; loaded = 0; } // server ignored Range: start over
      type = res.headers.get('content-type') || type;
      encoded = !!res.headers.get('content-encoding'); // sizes are unreliable when compressed
      const len = encoded ? 0 : +(res.headers.get('content-length') || 0);
      total = len ? loaded + len : 0;
      const reader = res.body!.getReader();
      for (;;) {
        clearTimeout(timer);
        timer = setTimeout(() => ctl.abort(), STALL_MS);
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value!);
        loaded += value!.length;
        onProgress(loaded, total);
      }
      clearTimeout(timer);
      if (!total || loaded >= total) return new Response(new Blob(chunks as BlobPart[]), { headers: { 'Content-Type': type } });
    } catch {
      clearTimeout(timer);
      if (encoded) { chunks.length = 0; loaded = 0; } // can't resume a compressed stream
    }
    if (attempt + 1 < DL_TRIES) {
      onNote(`اتصال ضعیف است؛ تلاش دوباره (${attempt + 2}/${DL_TRIES})`);
      await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error('download failed');
}

const abs = (name: string) => new URL('./stockfish/' + name, location.href).href;

/** engine.json is tiny: network first (so engine updates are noticed), cached copy as fallback. */
async function engineName(cache: Cache | null): Promise<string> {
  const url = abs('engine.json');
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(url, { cache: 'no-store', signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    cache?.put(url, r.clone()).catch(() => {});
    return (await r.json()).js;
  } catch (e) {
    const hit = await cache?.match(url);
    if (hit) return (await hit.json()).js;
    throw e;
  }
}

async function swControlled() {
  // The service worker must control the page, or the engine worker would fetch from the network again.
  if (!('serviceWorker' in navigator) || navigator.serviceWorker.controller) return;
  await Promise.race([
    new Promise<void>((r) => navigator.serviceWorker.addEventListener('controllerchange', () => r(), { once: true })),
    sleep(5000),
  ]);
}

async function loadFiles(): Promise<string> {
  const cache = await caches.open(CACHE).catch(() => null);
  const js = await engineName(cache);
  const wasm = js.replace(/\.js$/, '.wasm');
  for (const name of [js, wasm]) {
    if (cache && (await cache.match(abs(name)))) continue; // already stored: no network needed
    setState({ phase: 'downloading', loaded: 0, total: 0, note: '' });
    const res = await download(abs(name), (loaded, total) => setState({ loaded, total }), (note) => setState({ note }));
    await cache?.put(abs(name), res).catch(() => {});
  }
  if (cache) { // drop engine files left over from older versions
    const keep = [abs(js), abs(wasm), abs('engine.json')];
    for (const k of await cache.keys()) if (!keep.includes(k.url)) await cache.delete(k);
  }
  await swControlled();
  setState({ phase: 'ready', note: '' });
  return js;
}

let filesP: Promise<string> | null = null;
const ensureFiles = () => (filesP ??= loadFiles().catch((e) => { filesP = null; throw e; }));

export class Engine {
  private w?: Worker;
  private ready: Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor() {
    this.ready = this.boot();
    this.ready.catch(() => {});
  }

  /** Resolves after the uci/isready handshake; rejects (in Persian) if the engine can't start. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  private async boot(): Promise<void> {
    try {
      const js = await ensureFiles(); // download (with retries) or take from cache
      for (let attempt = 0; ; attempt++) {
        try {
          this.w?.terminate();
          this.w = new Worker('./stockfish/' + js);
          await this.cmd('uci', 'uciok', HANDSHAKE_MS);
          await this.cmd('isready', 'readyok', HANDSHAKE_MS);
          return;
        } catch (e) {
          if (attempt + 1 >= BOOT_ATTEMPTS) throw e;
          await sleep(1500 * (attempt + 1));
        }
      }
    } catch {
      setState({ phase: 'failed', note: '' });
      throw new Error(FAIL_MSG);
    }
  }

  /** Kill and re-boot the worker (after a failed search, or when the user presses retry). */
  revive(): Promise<void> {
    try { this.w?.terminate(); } catch { /* already dead */ }
    this.ready = this.boot();
    this.ready.catch(() => {});
    return this.ready;
  }

  private cmd(c: string, until: string, timeout: number, onLine?: (l: string) => void) {
    return new Promise<void>((res, rej) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (ok: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.w!.removeEventListener('message', onMsg);
        this.w!.removeEventListener('error', onErr);
        ok();
      };
      const onMsg = (e: MessageEvent) => {
        const l = String(e.data);
        onLine?.(l);
        if (l.startsWith(until)) finish(res);
      };
      // A crashed worker (wasm OOM, compile failure…) fires "error", not "message".
      const onErr = () => finish(() => rej(new Error('worker crashed')));
      this.w!.addEventListener('message', onMsg);
      this.w!.addEventListener('error', onErr);
      timer = setTimeout(() => {
        // Ask the engine to wrap up, then allow a short grace period for the final line.
        try { this.w!.postMessage('stop'); } catch { /* worker gone */ }
        timer = setTimeout(() => finish(() => rej(new Error('engine timeout'))), STOP_GRACE_MS);
      }, timeout);
      this.w!.postMessage(c);
    });
  }

  /** Searches run one at a time per engine instance. */
  search(fen: string, o: Opts = {}): Promise<{ lines: Line[]; best: string }> {
    const p = this.chain
      .then(() => this.ready)
      .then(async () => {
        try {
          return await this.runSearch(fen, o);
        } catch {
          this.revive(); // next queued search gets a fresh worker
          throw new Error('موتور پاسخ نداد؛ دوباره تلاش کن.');
        }
      });
    this.chain = p.catch(() => {});
    return p;
  }

  private async runSearch(fen: string, o: Opts): Promise<{ lines: Line[]; best: string }> {
    const send = (s: string) => this.w!.postMessage(s);
    send(`setoption name MultiPV value ${o.multipv ?? 1}`);
    send(`setoption name Skill Level value ${o.skill ?? 20}`);
    send(`position fen ${fen}`);
    const found: Record<number, Line> = {};
    let best = '';
    await this.cmd(
      o.movetime ? `go movetime ${o.movetime}` : `go depth ${o.depth ?? 12}`,
      'bestmove',
      SEARCH_MS,
      (l) => {
        if (l.startsWith('bestmove')) best = l.split(' ')[1];
        if (!l.startsWith('info') || !l.includes(' pv ')) return;
        const m = /score (cp|mate) (-?\d+)/.exec(l);
        if (!m) return;
        const v = +m[2];
        const cp = m[1] === 'cp' ? v : v > 0 ? MATE - v : -MATE - v;
        const k = +(/multipv (\d+)/.exec(l)?.[1] ?? 1);
        const pv = l.split(' pv ')[1].trim().split(' ');
        found[k] = { move: pv[0], cp, pv };
      });
    const lines = Object.keys(found).map(Number).sort((a, b) => a - b).map((k) => found[k]);
    return { lines, best };
  }
}

let pair: { opp: Engine; ana: Engine } | undefined;
/** opp = the opponent, ana = the coach's full-strength analyzer */
export const getEngines = () => (pair ??= { opp: new Engine(), ana: new Engine() });

/** Retry button: re-download if needed and restart both workers. */
export function retryEngine() {
  setState({ phase: 'downloading', loaded: 0, total: 0, note: '' });
  const { opp, ana } = getEngines();
  return Promise.allSettled([opp.revive(), ana.revive()]);
}
