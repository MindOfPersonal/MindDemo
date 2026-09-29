const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const roots = ['src', 'database', 'scripts'];
const files = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full);
    } else if (entry.isFile() && full.endsWith('.js')) {
      files.push(full);
    }
  }
}

roots.forEach(walk);

let failed = false;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed = true;
    console.error(`Syntax error in ${file}:\n${err.stderr ? err.stderr.toString() : err.message}`);
  }
}

if (failed) {
  process.exit(1);
}

console.log(`Checked ${files.length} files: OK`);
