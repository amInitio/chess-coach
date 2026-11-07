import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Chess, Square } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { Line, MATE, getEngineState, getEngines, retryEngine, subscribeEngine } from './engine';
import { Entry, LABELS, buildFacts, cap, classify, explainMove, pvToSan, summarize } from './coach';
import './styles.css';

const LEVELS = [
  { n: 'مبتدی', skill: 1, t: 80 },
  { n: 'کم‌تجربه', skill: 5, t: 150 },
  { n: 'متوسط', skill: 10, t: 300 },
  { n: 'قوی', skill: 16, t: 600 },
];
const PIECE: Record<string, string> = { p: 'پیاده', n: 'اسب', b: 'فیل', r: 'رخ', q: 'وزیر', k: 'شاه' };
type Side = 'w' | 'b';

export default function App() {
  const game = useRef(new Chess()).current;
  const gameId = useRef(0);
  const entryId = useRef(0);
  const pre = useRef<Promise<Line[]>>(Promise.resolve([]));
  const [fen, setFen] = useState(game.fen());
  const [color, setColor] = useState<Side>('w');
  const [level, setLevel] = useState(1);
  const [key, setKey] = useState(() => localStorage.getItem('groq-key') || '');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [thinking, setThinking] = useState(false);
  const [over, setOver] = useState('');
  const [summary, setSummary] = useState('');
  const [hintLevel, setHintLevel] = useState(0);
  const [hintText, setHintText] = useState('');
  const [arrow, setArrow] = useState<[Square, Square] | null>(null);
  const [err, setErr] = useState('');
  const [booting, setBooting] = useState(true); // engine wasm still downloading/booting
  const [oppFailed, setOppFailed] = useState(false); // opponent search failed → offer retry
  const st = useSyncExternalStore(subscribeEngine, getEngineState); // engine download progress / failure

  const patch = (id: number, p: Partial<Entry>) =>
    setEntries((xs) => xs.map((e) => (e.id === id ? { ...e, ...p } : e)));

  const startPre = () => {
    pre.current = getEngines().ana.search(game.fen(), { depth: 12, multipv: 3 }).then((r) => r.lines);
    pre.current.catch(() => {});
  };

  const checkEnd = (c: Side) => {
    if (!game.isGameOver()) return false;
    setOver(game.isCheckmate() ? (game.turn() === c ? 'مات شدی.' : 'مات کردی! آفرین.') : 'بازی مساوی شد.');
    return true;
  };

  const oppPlay = async (gid: number, c: Side) => {
    setThinking(true); setOppFailed(false);
    try {
      const L = LEVELS[level];
      const { best } = await getEngines().opp.search(game.fen(), { movetime: L.t, skill: L.skill });
      if (gid !== gameId.current) return;
      game.move({ from: best.slice(0, 2), to: best.slice(2, 4), promotion: best[4] });
      setFen(game.fen());
      setHintText(''); setHintLevel(0); setArrow(null);
      if (!checkEnd(c)) startPre();
    } catch (e) {
      setErr((e as Error)?.message ?? String(e));
      if (gid === gameId.current) setOppFailed(true);
    }
    setThinking(false);
  };

  const newGame = (c: Side) => {
    gameId.current++;
    game.reset();
    setColor(c); setFen(game.fen()); setEntries([]); setOver(''); setSummary('');
    setHintText(''); setHintLevel(0); setArrow(null); setErr(''); setThinking(false); setOppFailed(false);
    if (c === 'w') startPre(); else oppPlay(gameId.current, c);
  };
  useEffect(() => {
    // Boot BOTH workers right away, so the wasm downloads while the user thinks
    // (no more delayed first move) and boot failures surface immediately.
    const E = getEngines();
    Promise.allSettled([E.opp.whenReady(), E.ana.whenReady()]).then(() => setBooting(false));
    newGame('w');
  }, []);

  // Retry after a failed engine download or a failed opponent search.
  const retry = async () => {
    setErr(''); setOppFailed(false);
    if (getEngineState().phase === 'failed') {
      setBooting(true);
      await retryEngine();
      setBooting(false);
    }
    if (getEngineState().phase === 'failed' || game.isGameOver()) return;
    if (game.turn() !== color) oppPlay(gameId.current, color); else startPre();
  };

  const explain = async (e: Entry) => {
    if (!key) return patch(e.id, { text: 'برای توضیح مربی، کلید Groq را در تنظیمات وارد کن.' });
    patch(e.id, { busy: true });
    try { patch(e.id, { text: await explainMove(key, e), busy: false }); }
    catch (x) { patch(e.id, { text: (x as Error).message, busy: false }); }
  };

  const analyse = async (fenBefore: string, fenAfter: string, uci: string, san: string, preP: Promise<Line[]>, gid: number) => {
    try {
      const top = await preP;
      if (gid !== gameId.current || !top.length) return;
      const best = top[0];
      const hit = top.find((l) => l.move === uci);
      const end = new Chess(fenAfter);
      let after: number;
      let reply: string[] = []; // engine's continuation after the player's move
      if (hit) { after = hit.cp; reply = hit.pv.slice(1); }
      else if (end.isCheckmate()) after = MATE;
      else if (end.isGameOver()) after = 0;
      else {
        const r = (await getEngines().ana.search(fenAfter, { depth: 12 })).lines[0];
        after = -r.cp; reply = r.pv;
      }
      if (gid !== gameId.current) return;
      const loss = Math.max(0, cap(best.cp) - cap(after));
      const label = classify(loss, uci === best.move);
      const e: Entry = {
        id: ++entryId.current, san, label, loss, fen: fenBefore, before: best.cp, after,
        bestSan: pvToSan(fenBefore, [best.move], 1)[0], line: pvToSan(fenBefore, best.pv, 4),
        facts: buildFacts(fenBefore, uci, best.pv, reply),
      };
      setEntries((x) => [e, ...x]);
      if (label === 'inaccuracy' || label === 'mistake' || label === 'blunder') explain(e);
    } catch (x) { setErr((x as Error)?.message ?? String(x)); }
  };

  const onDrop = (from: Square, to: Square) => {
    if (over || game.turn() !== color) return false;
    const fenBefore = game.fen();
    let mv;
    try { mv = game.move({ from, to, promotion: 'q' }); } catch { return false; }
    const gid = gameId.current;
    const fenAfter = game.fen();
    setFen(fenAfter); setHintText(''); setHintLevel(0); setArrow(null);
    analyse(fenBefore, fenAfter, from + to + (mv.promotion ?? ''), mv.san, pre.current, gid);
    if (!checkEnd(color)) oppPlay(gid, color);
    return true;
  };

  // Takes back the player's last move. If the engine already replied, its reply goes too,
  // so it is the player's turn again. If the engine is still thinking, that search is dropped.
  const undo = () => {
    if (!canUndo) return;
    gameId.current++; // invalidates pending analysis and the engine's pending move
    const engineReplied = game.turn() === color;
    game.undo();
    if (engineReplied) game.undo();
    const restored = game.fen();
    setFen(restored);
    setEntries((xs) => xs.filter((e) => e.fen !== restored)); // entry fen = position before the move
    setOver(''); setSummary(''); setThinking(false); setOppFailed(false);
    setHintText(''); setHintLevel(0); setArrow(null); setErr('');
    startPre();
  };

  const hint = async () => {
    if (over || game.turn() !== color) return;
    let top;
    try { top = await pre.current; } catch { return; }
    if (!top.length) return;
    const b = top[0].move, from = b.slice(0, 2) as Square, to = b.slice(2, 4) as Square;
    const lvl = Math.min(hintLevel + 1, 3);
    setHintLevel(lvl);
    setHintText(
      lvl === 1 ? `دنبال حرکتی با ${PIECE[game.get(from)!.type]} بگرد.`
      : lvl === 2 ? `از خانه‌ی ${from} حرکت کن.`
      : `بهترین حرکت: ${pvToSan(game.fen(), [b], 1)[0]}`);
    if (lvl === 3) setArrow([from, to]);
  };

  const finish = async () => {
    if (!key) return setSummary('برای جمع‌بندی مربی، کلید Groq را وارد کن.');
    setSummary('…');
    try { setSummary(await summarize(key, entries)); } catch (x) { setSummary((x as Error).message); }
  };

  const canUndo = game.history({ verbose: true }).some((m) => m.color === color);

  return (
    <div className="app">
      <main className="boardcol">
        <div className="board">
          <Chessboard
            position={fen}
            onPieceDrop={onDrop}
            boardOrientation={color === 'w' ? 'white' : 'black'}
            customDarkSquareStyle={{ backgroundColor: '#6E8F7B' }}
            customLightSquareStyle={{ backgroundColor: '#DCE5D3' }}
            customArrows={arrow ? [[arrow[0], arrow[1], '#C9962B']] : []}
            animationDuration={150}
          />
        </div>
        <div className="status">
          {over || (thinking
            ? (booting ? 'در حال آماده‌سازی موتور… (بار اول کمی طول می‌کشد)' : 'حریف فکر می‌کند…')
            : game.turn() === color ? 'نوبت توست' : '')}
        </div>
        {st.phase === 'downloading' && (
          <p className="hint" style={{ direction: 'rtl' }}>
            در حال دانلود موتور شطرنج
            {st.total ? ` (${Math.round((st.loaded / st.total) * 100)}٪)` : st.loaded ? ` (${(st.loaded / 1048576).toFixed(1)} مگابایت)` : ''}
            … فقط بار اول لازم است.{st.note && ` ${st.note}`}
          </p>
        )}
        {(oppFailed || st.phase === 'failed') && !over && (
          <button onClick={retry}>
            {st.phase === 'failed' ? 'دانلود موتور ناموفق بود — تلاش دوباره' : 'حریف جواب نداد — تلاش دوباره'}
          </button>
        )}
      </main>

      <aside className="panel">
        <h1>مربی شطرنج</h1>
        <div className="row">
          <button onClick={() => newGame('w')}>بازی جدید (سفید)</button>
          <button onClick={() => newGame('b')}>بازی جدید (سیاه)</button>
        </div>
        <div className="row">
          <select value={level} onChange={(e) => setLevel(+e.target.value)}>
            {LEVELS.map((l, i) => <option key={i} value={i}>حریف: {l.n}</option>)}
          </select>
          <input
            type="password" placeholder="کلید Groq" value={key} dir="ltr"
            onChange={(e) => { setKey(e.target.value); localStorage.setItem('groq-key', e.target.value); }}
          />
        </div>
        <div className="row">
          <button onClick={hint} disabled={!!over}>راهنما</button>
          <button onClick={undo} disabled={!canUndo}>برگرداندن حرکت</button>
          {over && <button onClick={finish}>جمع‌بندی مربی</button>}
        </div>
        {hintText && <p className="hint">{hintText}</p>}
        {err && <p className="err">{err}</p>}
        {summary && <p className="summary">{summary}</p>}

        <div className="feed">
          {entries.length === 0 && <p className="empty">یک حرکت بزن؛ مربی بعدش نظر می‌دهد.</p>}
          {entries.map((e) => (
            <article key={e.id} className="note" style={{ borderInlineStartColor: LABELS[e.label].color }}>
              <header>
                <b dir="ltr">{e.san}</b>
                <span className="badge" style={{ background: LABELS[e.label].color }}>{LABELS[e.label].fa}</span>
                {e.loss > 10 && <small>افت ارزیابی {(e.loss / 100).toFixed(1)}</small>}
              </header>
              {e.busy && <p className="muted">مربی در حال فکر کردن…</p>}
              {e.text && <p>{e.text}</p>}
              {!e.text && !e.busy && (
                <button className="link" onClick={() => explain(e)}>توضیح بده</button>
              )}
            </article>
          ))}
        </div>
      </aside>
    </div>
  );
}
