import { readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const workers = Math.max(1, Math.floor(availableParallelism() / 2));
const tests = readdirSync('tests')
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => join('tests', name));

if (tests.length === 0) throw new Error('no Admin Node tests found');

console.log(`Running ${tests.length} Admin Node test files with ${workers} workers`);
const result = spawnSync(
  process.execPath,
  [
    '--test',
    `--test-concurrency=${workers}`,
    '--experimental-test-coverage',
    '--test-coverage-lines=95',
    '--test-coverage-branches=81',
    '--test-coverage-functions=96',
    ...tests,
  ],
  { stdio: 'inherit' },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
