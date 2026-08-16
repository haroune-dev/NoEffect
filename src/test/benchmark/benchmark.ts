/**
 * Performance-PR benchmark: cold vs warm analysis timing + lifecycle/cache
 * counters. Runs against real Chromium via the production pipeline.
 *
 *   node out/test/benchmark/benchmark.js
 */
import * as path from 'path';
import { CdpAnalyzer, DEFAULT_FIXTURES_ROOT } from '../../services/cdpAnalyzer';
import { defaultLifecycle } from '../../browser/lifecycleManager';
import { astCache } from '../../cache/astCache';
import { mappingCache } from '../../cache/mappingCache';

const FIXTURE = path.join(DEFAULT_FIXTURES_ROOT, 'inactive');

function fmt(ms: number): string {
  return `${ms.toFixed(0)}ms`;
}

async function run(name: string, analyzer: CdpAnalyzer): Promise<number> {
  const start = Date.now();
  const issues = await analyzer.analyzeFixture(FIXTURE, '.non-flex', start);
  const elapsed = Date.now() - start;
  console.log(`  ${name.padEnd(22)} ${fmt(elapsed).padStart(8)}  (issues: ${issues.length})`);
  return elapsed;
}

async function main(): Promise<void> {
  await defaultLifecycle.dispose();
  astCache.reset();
  mappingCache.reset();

  const analyzer = new CdpAnalyzer();

  console.log('─ Performance benchmark (real Chromium) ─');
  console.log('  run 1 (COLD: browser + CDP + DevServer + page + caches)');
  const cold = await run('cold', analyzer);

  console.log('  run 2 (WARM: everything reused, caches hit)');
  const warm = await run('warm #1', analyzer);

  console.log('  run 3 (WARM again)');
  const warm2 = await run('warm #2', analyzer);

  const stats = defaultLifecycle.getStats();
  const ast = astCache.stats();
  const map = mappingCache.stats();

  console.log('');
  console.log('─ Counters ─');
  console.log(`  Chromium launches:     ${stats.chromiumLaunches}`);
  console.log(`  DevServer starts:      ${stats.devServerStarts}`);
  console.log(`  CDP connects:          ${stats.cdpConnects}`);
  console.log(`  CDP reconnects:        ${stats.cdpReconnects}`);
  console.log(`  Page navigations:      ${stats.pageNavigations}`);
  console.log(`  Page reloads:          ${stats.pageReloads}`);
  console.log(`  Page reuses:           ${stats.pageReuses}`);
  console.log(`  AST cache:             ${ast.hits} hit(s) / ${ast.misses} miss(es)`);
  console.log(`  Mapping cache:         ${map.hits} hit(s) / ${map.misses} miss(es)`);
  console.log('');
  console.log(`  Cold: ${fmt(cold)}  |  Warm: ${fmt(warm)} / ${fmt(warm2)}  (speedup ~${(cold / warm).toFixed(1)}x)`);

  await defaultLifecycle.dispose();
  console.log('Benchmark done — session disposed.');
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exitCode = 1;
});
