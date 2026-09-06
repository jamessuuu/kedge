#!/usr/bin/env node
// A small project-specific gate, not a style opinion engine.
//
// Every rule here is one that would actually cost something if broken: a stray
// console.log in a library, a TODO shipped as documentation, a source file with
// no explanation at the top, a generated bundle that no longer matches its
// sources. Formatting arguments are deliberately absent.
//
//   node tools/lint.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MAX_LINE = 120;

/** @param {string} dir @param {string[]} [acc] @returns {string[]} */
function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'vendor', '.playwright-mcp'].includes(entry.name)) continue;
      walk(full, acc);
    } else if (/\.(js|mjs)$/.test(entry.name)) {
      if (entry.name === 'kedge.bundle.js') continue; // generated
      acc.push(full);
    }
  }
  return acc;
}

function main() {
  /** @type {string[]} */
  const problems = [];
  const files = walk(ROOT);

  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    const isLibrary = rel.startsWith('src/') && rel !== 'src/cli.js';
    // This file necessarily contains the strings it forbids. A linter that
    // cannot describe its own rules is not a useful linter.
    const isSelf = rel === 'tools/lint.mjs';

    if (!/^(\/\/|\/\*|#!)/.test(text)) {
      problems.push(rel + ':1 — file does not start with a comment explaining what it is');
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const at = rel + ':' + (i + 1);
      if (line.includes('\t')) problems.push(at + ' — literal tab');
      if (/\s+$/.test(line)) problems.push(at + ' — trailing whitespace');
      if (line.length > MAX_LINE) problems.push(at + ' — line is ' + line.length + ' chars (max ' + MAX_LINE + ')');
      if (!isSelf && /\bTODO\b|\bFIXME\b|\bXXX\b/.test(line)) {
        problems.push(at + ' — unresolved marker; either do it or write down why it is not done');
      }
      if (isLibrary && /\bconsole\s*\.\s*(log|debug|info)\s*\(/.test(line)) {
        problems.push(at + ' — console output from a library module; return the value instead');
      }
      if (!isSelf && /\bdebugger\b/.test(line)) problems.push(at + ' — debugger statement');
      if (line.indexOf(String.fromCharCode(0)) !== -1) problems.push(at + ' — NUL byte in source');
    }
    if (text.length > 0 && !text.endsWith('\n')) problems.push(rel + ' — no trailing newline');
  }

  // Every planted bug must be findable from src/bugs.js, and every build flag
  // must actually be read somewhere. A flag nobody checks is a fixture that
  // cannot fire.
  const bugsSrc = fs.readFileSync(path.join(ROOT, 'src', 'bugs.js'), 'utf8');
  const ids = Array.from(bugsSrc.matchAll(/^\s*id: '([a-z-]+)',$/gm)).map((m) => m[1]);
  const flagNames = ids.map((id) => id.replace(/-([a-z])/g, (_m, c) => c.toUpperCase()));
  const allSrc = files
    .filter((f) => !f.includes('bugs.js'))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
  for (let i = 0; i < ids.length; i++) {
    const flag = flagNames[i];
    const readAsFlag = new RegExp('flags\\.' + flag + '\\b').test(allSrc);
    const readAsSabotage = flag === 'checkerAcceptOnBlock' && /acceptOnBlock/.test(allSrc);
    if (!readAsFlag && !readAsSabotage) {
      problems.push('src/bugs.js — build flag "' + ids[i] + '" is declared but never read; it cannot fire');
    }
  }

  if (problems.length > 0) {
    for (const p of problems) process.stderr.write('lint: ' + p + '\n');
    process.stderr.write('lint: ' + problems.length + ' problem(s)\n');
    return 1;
  }
  process.stdout.write('lint: ' + files.length + ' files, no problems\n');
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main();
}
