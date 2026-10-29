import { Chess } from 'chess.js';

export type Label = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';
export type Entry = {
  id: number; san: string; label: Label; loss: number; fen: string;
  bestSan: string; line: string[]; before: number; after: number;
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

export const explainMove = (key: string, e: Entry) =>
  ask(key,
`FEN قبل از حرکت: ${e.fen}
حرکت بازیکن: ${e.san}
بهترین حرکت موتور: ${e.bestSan}
ادامه‌ی پیشنهادی موتور: ${e.line.join(' ')}
ارزیابی به نفع بازیکن (واحد پیاده): قبل ${pw(e.before)} ← بعد ${pw(e.after)}
دسته: ${LABELS[e.label].fa}
توضیح بده چرا حرکت بازیکن ضعیف‌تر بود و ایده‌ی پشت حرکت بهتر چیست. اگر مناسب بود با یک سؤال کوتاه تمام کن.`);

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
