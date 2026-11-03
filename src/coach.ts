import { Chess, Move } from 'chess.js';
import { MATE } from './engine';

export type Label = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';
export type Entry = {
  id: number; san: string; label: Label; loss: number; fen: string;
  bestSan: string; line: string[]; facts: string; before: number; after: number;
  text?: string; busy?: boolean;
};

export const LABELS: Record<Label, { fa: string; color: string }> = {
  best: { fa: 'عالی', color: '#2F7D5B' },
  good: { fa: 'خوب', color: '#6B8F3A' },
  inaccuracy: { fa: 'نادقیق', color: '#C9962B' },
  mistake: { fa: 'اشتباه', color: '#D2691E' },
  blunder: { fa: 'بلاندر', color: '#B3322E' },
};

export const cap = (cp: number) => Math.max(-800, Math.min(800, cp));

export function classify(loss: number, isBest: boolean): Label {
  if (isBest || loss <= 10) return 'best';
  if (loss <= 50) return 'good';
  if (loss <= 100) return 'inaccuracy';
  if (loss <= 300) return 'mistake';
  return 'blunder';
}

export function pvToSan(fen: string, pv: string[], n = 4): string[] {
  const c = new Chess(fen);
  const out: string[] = [];
  for (const u of pv.slice(0, n)) {
    try { out.push(c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san); }
    catch { break; }
  }
  return out;
}

// Change here if Groq retires the model again
const MODEL = 'openai/gpt-oss-120b';

const SYSTEM =
  'تو یک مربی شطرنج صبور، دقیق و تشویق‌کننده‌ای. فقط از داده‌ی داده‌شده استفاده کن و هرگز حرکت، تهدید یا تاکتیکی از خودت نساز. ' +
  'به فارسی ساده و در حداکثر ۳ جمله جواب بده. نمادهای حرکت (مثل Nf3) را انگلیسی بنویس. اگر مطمئن نیستی، ایده‌ی کلی بگو نه جزئیات.';

async function ask(key: string, user: string): Promise<string> {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL, temperature: 0.4, max_tokens: 600,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw new Error(r.status === 401 ? 'کلید Groq نامعتبر است.' : `خطای Groq (${r.status})`);
  return (await r.json()).choices[0].message.content.trim();
}

const pw = (cp: number) => (cp / 100).toFixed(1);

const VAL: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const NAME: Record<string, string> = { p: 'پیاده', n: 'اسب', b: 'فیل', r: 'رخ', q: 'وزیر', k: 'شاه' };

function play(fen: string, uci: string[]): Move[] {
  const c = new Chess(fen);
  const out: Move[] = [];
  for (const u of uci) {
    try { out.push(c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] })); }
    catch { break; }
  }
  return out;
}

/** Net material change (in pawns) for `side` over the given moves. */
function swing(moves: Move[], side: string) {
  let s = 0;
  for (const m of moves) {
    const sign = m.color === side ? 1 : -1;
    if (m.captured) s += sign * VAL[m.captured];
    if (m.promotion) s += sign * (VAL[m.promotion] - 1);
  }
  return s;
}

function showLine(moves: Move[], side: string) {
  const s = swing(moves, side);
  const text = moves.map((m) => m.san + (m.captured ? `(${NAME[m.captured]})` : '')).join(' ');
  return `${text} ← ماده برای تو: ${s > 0 ? '+' : ''}${s}`;
}

export function fmtEval(cp: number) {
  if (Math.abs(cp) < MATE - 1000) return (cp / 100).toFixed(1);
  const n = MATE - Math.abs(cp);
  if (n <= 0) return 'مات';
  return cp > 0 ? `مات برای تو در ${n} حرکت` : `مات برای حریف در ${n} حرکت`;
}

/** Concrete facts computed by code, so the LLM explains instead of guessing. */
export function buildFacts(fen: string, uci: string, bestPv: string[], replyPv: string[]): string {
  const c = new Chess(fen);
  const side = c.turn();
  const all = c.board().flat().filter((x) => x !== null) as { square: string; type: string; color: string }[];
  const group = (col: string) => {
    const mine = all.filter((x) => x.color === col);
    const order = 'kqrbn';
    const pieces = mine
      .filter((x) => x.type !== 'p')
      .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))
      .map((x) => x.type.toUpperCase() + x.square);
    const pawns = mine.filter((x) => x.type === 'p').map((x) => x.square);
    return `${pieces.join(' ')} | پیاده‌ها: ${pawns.join(' ')}`;
  };
  const yours = play(fen, [uci, ...replyPv.slice(0, 5)]);
  const better = play(fen, bestPv.slice(0, 6));
  return [
    `تو با ${side === 'w' ? 'سفید' : 'سیاه'} بازی می‌کنی.`,
    `مهره‌های سفید: ${group('w')}`,
    `مهره‌های سیاه: ${group('b')}`,
    `با حرکت تو، ادامه‌ی محتمل (طبق موتور): ${showLine(yours, side)}`,
    `با حرکت پیشنهادی موتور: ${showLine(better, side)}`,
  ].join('\n');
}

export const explainMove = (key: string, e: Entry) =>
  ask(key,
`${e.facts}
حرکت تو: ${e.san} | حرکت بهتر: ${e.bestSan}
ارزیابی موتور (به نفع تو، واحد پیاده): قبل از حرکت ${fmtEval(e.before)} ← بعد از حرکت ${fmtEval(e.after)}
دسته‌ی حرکت تو: ${LABELS[e.label].fa}
فقط با تکیه بر داده‌ی بالا توضیح بده چرا حرکت تو ضعیف‌تر بود و حرکت بهتر چه می‌کرد. اگر در داده دلیل مشخصی (گرفتن یا از دست دادن مهره، چک، مات) دیده نمی‌شود، دلیل تاکتیکی نساز؛ فقط بگو موتور کدام حرکت را ترجیح می‌دهد و یک اصل کلی بگو. اگر مناسب بود با یک سؤال کوتاه تمام کن.`);

export function summarize(key: string, entries: Entry[]) {
  const counts: Record<string, number> = {};
  entries.forEach((e) => (counts[LABELS[e.label].fa] = (counts[LABELS[e.label].fa] || 0) + 1));
  const worst = [...entries].sort((a, b) => b.loss - a.loss).slice(0, 3);
  return ask(key,
`آمار حرکت‌های بازیکن: ${JSON.stringify(counts)}
بدترین حرکت‌ها:
${worst.map((e) => `- ${e.san} (بهتر: ${e.bestSan}، افت ${pw(e.loss)})`).join('\n')}
بازی تمام شد. در ۳ جمله جمع‌بندی کن و یک موضوع مشخص برای تمرین پیشنهاد بده.`);
}
