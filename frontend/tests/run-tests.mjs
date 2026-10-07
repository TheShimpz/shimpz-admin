import { readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const processors = availableParallelism();
// A caller that shares one test budget across concurrent work names this run's share; otherwise half of the
// processors locally and all of them under GitHub Actions.
const configured = process.env.SHIMPZ_TEST_WORKERS;
if (configured !== undefined && !/^[1-9][0-9]*$/.test(configured)) {
  throw new Error('SHIMPZ_TEST_WORKERS must be a positive integer');
}
const workers = configured !== undefined
  ? Number(configured)
  : process.env.GITHUB_ACTIONS === 'true'
    ? processors
    : Math.max(1, Math.floor(processors / 2));
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
