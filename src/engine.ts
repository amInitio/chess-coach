export type Line = { move: string; cp: number; pv: string[] }; // cp: side-to-move view
type Opts = { depth?: number; movetime?: number; multipv?: number; skill?: number };
export const MATE = 1000;

export class Engine {
  private w!: Worker;
  private ready: Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor() {
    this.ready = fetch('./stockfish/engine.json')
      .then((r) => r.json())
      .then(async ({ js }) => {
        this.w = new Worker('./stockfish/' + js);
        await this.cmd('uci', 'uciok');
        await this.cmd('isready', 'readyok');
      });
  }

  private cmd(c: string, until: string, onLine?: (l: string) => void) {
    return new Promise<void>((res) => {
      const h = (e: MessageEvent) => {
        const l = String(e.data);
        onLine?.(l);
        if (l.startsWith(until)) { this.w.removeEventListener('message', h); res(); }
      };
      this.w.addEventListener('message', h);
      this.w.postMessage(c);
    });
  }

  /** Searches run one at a time per engine instance. */
  search(fen: string, o: Opts = {}): Promise<{ lines: Line[]; best: string }> {
    const p = this.chain.then(() => this.ready).then(async () => {
      const send = (s: string) => this.w.postMessage(s);
      send(`setoption name MultiPV value ${o.multipv ?? 1}`);
      send(`setoption name Skill Level value ${o.skill ?? 20}`);
      send(`position fen ${fen}`);
      const found: Record<number, Line> = {};
      let best = '';
      await this.cmd(
        o.movetime ? `go movetime ${o.movetime}` : `go depth ${o.depth ?? 12}`,
        'bestmove',
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
    });
    this.chain = p.catch(() => {});
    return p;
  }
}

let pair: { opp: Engine; ana: Engine } | undefined;
/** opp = the opponent, ana = the coach's full-strength analyzer */
export const getEngines = () => (pair ??= { opp: new Engine(), ana: new Engine() });
