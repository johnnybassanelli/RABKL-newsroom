
import { cpSync, existsSync, mkdirSync } from 'node:fs';

const mappings = [
  { from: './content', to: './src/pages/posts' },
  { from: './content/power-index', to: './src/pages/power-index' },
  { from: './content/recap', to: './src/pages/recap' },
];

for (const {from,to} of mappings) {
  try {
    if (existsSync(from)) {
      mkdirSync(to, { recursive: true });
      cpSync(from, to, { recursive: true });
      console.log('[sync-content] Copied', from, '→', to);
    }
  } catch (e) {
    console.error('[sync-content] Error copying', from, '→', to, e);
  }
}
