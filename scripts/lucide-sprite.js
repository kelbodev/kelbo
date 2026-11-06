#!/usr/bin/env node
// Sprite delle icone Lucide (https://lucide.dev, licenza ISC) per public/core/vendor/lucide:
// un <symbol> per ogni file di icons/ di lucide-static, nomi alias compresi (trash-2, triangle-alert…).
//   npm pack lucide-static && tar -xzf lucide-static-*.tgz
//   node scripts/lucide-sprite.js package
const fs = require('fs');
const path = require('path');

const src = process.argv[2];
if (!src || !fs.existsSync(path.join(src, 'icons'))) { console.error('Uso: node scripts/lucide-sprite.js <cartella di lucide-static>'); process.exit(1); }
const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
const out = path.join(__dirname, '..', 'public', 'core', 'vendor', 'lucide');
const symbols = fs.readdirSync(path.join(src, 'icons')).filter(f => f.endsWith('.svg')).sort().map(f => {
  const svg = fs.readFileSync(path.join(src, 'icons', f), 'utf8');
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/\s*\n\s*/g, '');
  return `<symbol id="${f.slice(0, -4)}" viewBox="0 0 24 24">${inner}</symbol>`;
});
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'sprite.svg'), `<?xml version="1.0" encoding="utf-8"?>\n<!-- @license lucide-static v${pkg.version} - ISC -->\n<svg xmlns="http://www.w3.org/2000/svg"><defs>\n${symbols.join('\n')}\n</defs></svg>\n`);
fs.copyFileSync(path.join(src, 'LICENSE'), path.join(out, 'LICENSE'));
fs.writeFileSync(path.join(out, 'VERSION'), `${pkg.version}\n`);
console.log(`${symbols.length} icone, lucide-static ${pkg.version}`);
