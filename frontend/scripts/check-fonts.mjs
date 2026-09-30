// Polish Batch 6 guard: fails if a raw font size sneaks back into frontend/src.
// Use the --fs-* tokens instead (see styles.css and the type-scale decision file).
// Print-window templates are excluded: the tokens don't exist in those windows.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../src', import.meta.url));
const EXCLUDE = new Set([
  'pages/PayrollPage.tsx',
  'pages/ReportsPage.tsx',
  'pages/OfficialDocumentsPage.tsx',
  'utils/printDocument.ts',
]);
const RULES = [
  { re: /fontSize\s*[:=]\s*\{?\s*-?\d/, why: 'numeric fontSize' },
  { re: /fontSize\s*[:=]\s*\{?\s*['"`]\s*\d[\d.]*\s*px/, why: 'px fontSize string' },
  { re: /font-size\s*:\s*\d[\d.]*px/, why: 'px font-size' },
];

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|css)$/.test(name)) files.push(p);
  }
})(ROOT);

const hits = [];
for (const f of files) {
  const rel = relative(ROOT, f).split(sep).join('/');
  if (EXCLUDE.has(rel)) continue;
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    for (const { re, why } of RULES) if (re.test(line)) hits.push(`src/${rel}:${i + 1}  ${why}: ${line.trim()}`);
  });
}

if (hits.length) {
  console.error(`check:fonts failed, ${hits.length} raw font size(s). Use var(--fs-*):\n` + hits.join('\n'));
  process.exit(1);
}
console.log(`check:fonts OK (${files.length} files scanned).`);
