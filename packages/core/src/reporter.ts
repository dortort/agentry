/**
 * Console reporter (SPEC §14). Pure `formatConsole`/`summarize` (testable) plus
 * a `reportConsole` that prints. Surfaces per-scenario cost, as cost is a
 * first-class concern (SPEC §13).
 */
import type { TestResult } from './runner';

export interface ReportSummary {
  passed: number;
  failed: number;
  skipped: number;
  totalCostUSD: number;
}

export function summarize(results: TestResult[]): ReportSummary {
  const s: ReportSummary = { passed: 0, failed: 0, skipped: 0, totalCostUSD: 0 };
  for (const r of results) {
    if (r.status === 'passed') s.passed++;
    else if (r.status === 'failed') s.failed++;
    else s.skipped++;
    s.totalCostUSD += r.costUSD ?? 0;
  }
  return s;
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}

const ICON: Record<TestResult['status'], string> = { passed: '✓', failed: '✗', skipped: '○' };

export function formatConsole(results: TestResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    const title = [...r.suite, r.name].join(' › ');
    const cost = r.costUSD ? `, $${r.costUSD.toFixed(4)}` : '';
    lines.push(`  ${ICON[r.status]} ${title}  (${r.durationMs}ms${cost}) [${r.mode}]`);
    if (r.error) lines.push(indent(r.error, 6));
  }
  const s = summarize(results);
  lines.push('');
  lines.push(
    `  ${s.passed} passed · ${s.failed} failed · ${s.skipped} skipped · $${s.totalCostUSD.toFixed(4)} total`,
  );
  return lines.join('\n');
}

export function reportConsole(results: TestResult[]): ReportSummary {
  // eslint-disable-next-line no-console
  console.log(formatConsole(results));
  return summarize(results);
}
