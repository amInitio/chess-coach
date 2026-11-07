import { createRoot } from 'react-dom/client';
import App from './App';

// public/sw.js keeps the Stockfish engine files in Cache Storage; ask the browser not to evict them.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
void navigator.storage?.persist?.()?.catch(() => {});

createRoot(document.getElementById('root')!).render(<App />);
