import { spawnSync } from 'node:child_process';
import { ClaudeDriver } from '@agentry/claude';

/** \`agentry doctor\` — probe installed agent CLIs and print driver capabilities. */
export async function cmdDoctor(): Promise<number> {
  console.log('agentry doctor\n');

  const claudeBin = process.env.AGENTRY_CLAUDE_BIN ?? 'claude';
  const v = spawnSync(claudeBin, ['--version'], { encoding: 'utf8' });
  if (v.status === 0) {
    console.log(`  claude   ✓  ${v.stdout.trim()}`);
  } else {
    console.log(`  claude   ✗  not found (looked for '${claudeBin}')`);
  }

  console.log('\n  claude driver capabilities:');
  const caps = new ClaudeDriver().capabilities();
  for (const [k, val] of Object.entries(caps)) {
    console.log(`    ${k}: ${JSON.stringify(val)}`);
  }
  return 0;
}
