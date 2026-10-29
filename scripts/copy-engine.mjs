// Copies the single-thread Stockfish WASM build from node_modules into public/
import fs from 'fs';
import path from 'path';
const walk = (d) =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const files = walk('node_modules/stockfish').filter(
  (f) => f.endsWith('.js') && fs.existsSync(f.replace(/\.js$/, '.wasm')));
const pick =
  files.find((f) => /lite/.test(f) && /single/.test(f)) ||
  files.find((f) => /single/.test(f)) || files[0];
if (!pick) { console.error('Stockfish engine files not found in node_modules/stockfish'); process.exit(1); }
const base = path.basename(pick, '.js');
fs.mkdirSync('public/stockfish', { recursive: true });
for (const ext of ['.js', '.wasm'])
  fs.copyFileSync(path.join(path.dirname(pick), base + ext), `public/stockfish/${base}${ext}`);
fs.writeFileSync('public/stockfish/engine.json', JSON.stringify({ js: base + '.js' }));
console.log('Engine ready:', base);
