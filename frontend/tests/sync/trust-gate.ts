import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '.results');

/**
 * The trust gate.
 *
 * A green run only means something if the same run proved the oracle can go
 * red. This reporter therefore fails the whole run when the sabotage suite did
 * not execute, even if every test that DID run passed — a filtered or
 * accidentally-empty run is reported as UNVERIFIED, never as a pass.
 */
export default class TrustGate implements Reporter {
  private results: { title: string; status: string; ms: number }[] = [];
  private sabotage = { ran: 0, detected: 0 };

  onTestEnd(test: TestCase, result: TestResult): void {
    const title = test.titlePath().filter(Boolean).join(' > ');
    this.results.push({ title, status: result.status, ms: result.duration });
    // A sabotage case the schema cannot host (e.g. the singleton one, with no
    // singleton table) is skipped, not undetected — counting it would mark
    // every such run untrustworthy.
    if (title.includes('sabotage:') && result.status !== 'skipped') {
      this.sabotage.ran++;
      if (result.status === 'passed') this.sabotage.detected++;
    }
  }

  onEnd(result: FullResult): Promise<{ status: FullResult['status'] }> | void {
    const failed = this.results.filter((r) => r.status !== 'passed' && r.status !== 'skipped');
    const trustworthy = this.sabotage.ran > 0 && this.sabotage.detected === this.sabotage.ran;

    mkdirSync(OUT, { recursive: true });
    writeFileSync(
      join(OUT, 'results.json'),
      JSON.stringify(
        { generatedAt: new Date().toISOString(), sabotage: this.sabotage, trustworthy, results: this.results },
        null,
        2
      )
    );

    const banner = trustworthy
      ? 'self-verification ' + this.sabotage.detected + '/' + this.sabotage.ran + ' injected faults detected'
      : 'NOT TRUSTWORTHY — the sabotage suite did not run (' +
        this.sabotage.detected + '/' + this.sabotage.ran + '). A run that never proved it can fail is unverified, not green.';
    console.log('\n' + banner);
    console.log(failed.length + ' failed, ' + this.results.length + ' total');

    if (!trustworthy && result.status === 'passed') {
      return Promise.resolve({ status: 'failed' as const });
    }
  }
}
