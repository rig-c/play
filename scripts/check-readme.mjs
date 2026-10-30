import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// #228: post-cut count + 10%, rounded up to 50; #182's 3,000 wins if lower.
// Frozen post-cut baseline: 1444 words; ceil(1444 * 1.1 / 50) * 50 = 1600.
export const WORD_CAP = 1600;
export const HEADINGS = new Set([
  'Why', 'Install', 'Where to read next', 'Demo (this repository)',
  'How it works', 'License',
]);

export function wordCount(markdown) {
  return (markdown.match(/\S+/gu) ?? []).length;
}

export function checkReadme(markdown) {
  const errors = [];
  const words = wordCount(markdown);
  if (words > WORD_CAP) errors.push(`words: ${words} exceeds cap ${WORD_CAP}`);
  // Examples are literal code, not document headings or measurement prose.
  let fence;
  const prose = [];
  for (const [index, line] of markdown.split(/\r?\n/u).entries()) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    prose.push(line);
    const heading = /^ {0,3}##(?:[\t ]+(.*)|$)/u.exec(line);
    if (heading) {
      const title = (heading[1] ?? '').replace(/\s+#+\s*$/u, '').trim();
      if (!HEADINGS.has(title)) errors.push(`heading: "${title}" at line ${index + 1}`);
    }
    if (line.includes('|') && /\b\d{4}-\d{2}-\d{2}\b/u.test(line)) {
      errors.push(`dated table cell: line ${index + 1}`);
    }
  }
  for (const match of prose.join('\n').matchAll(/\b(?:measured|read)\s+on\s+20/giu)) {
    errors.push(`dated measurement: "${match[0].replace(/\s+/gu, ' ')}"`);
  }
  return { words, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] ?? fileURLToPath(new URL('../README.md', import.meta.url));
  const { words, errors } = checkReadme(readFileSync(file, 'utf8'));
  for (const error of errors) console.error(`README ${error}`);
  console.log(`README: ${words}/${WORD_CAP} words; ${errors.length ? 'FAIL' : 'PASS'}`);
  process.exitCode = errors.length ? 1 : 0;
}
