import { Command } from 'commander';
import path from 'node:path';
import { extract } from './extract.js';
import { serve } from './serve.js';

const program = new Command('sf-access-docs').description('Explore who can access what in a Salesforce org.');

program
  .command('extract')
  .description('Read access data from an org (read-only) into a snapshot folder')
  .requiredOption('-o, --target-org <alias>', 'sf CLI alias or username of the org (no default, to avoid hitting prod by accident)')
  .option('-d, --out <dir>', 'snapshot output folder (default: ./snapshots/<alias>)')
  .option('--fields', 'also extract field-level permissions (large, slow)', false)
  .option('--include-portal', 'include portal/community/guest profiles and users', false)
  .option('--detect-tests', 'read Apex class bodies to flag test classes exactly (heavier; default is a name-based guess)', false)
  .option('--concurrency <n>', 'parallel API requests', '6')
  .action(async (o) => {
    await extract({
      org: o.targetOrg,
      out: o.out ?? path.join('snapshots', o.targetOrg),
      fields: o.fields,
      includePortal: o.includePortal,
      detectTests: o.detectTests,
      concurrency: Math.max(1, Math.min(12, Number(o.concurrency) || 6)),
    });
  });

program
  .command('serve')
  .description('Open the explorer UI for a snapshot')
  .option('-s, --snapshot <dir>', 'snapshot folder', 'snapshot')
  .option('-p, --port <n>', 'port', '4780')
  .option('--no-open', 'do not open the browser')
  .action((o) => serve(o.snapshot, Number(o.port), o.open));

program.parseAsync().catch((e) => {
  process.stderr.write(`Error: ${(e as Error).message}\n`);
  process.exit(1);
});
