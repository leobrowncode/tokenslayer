import fs from 'node:fs';
import { DEFAULT_CONFIG, mergeConfig } from '../core/config';
import { collectSnapshot, createProviders } from '../core/snapshot';

/** Prints one snapshot as JSON: a quick way to check what the overlay can see on this machine. */
async function main(): Promise<void> {
  const file = process.env.TOKENSLAYER_CONFIG;
  const config = file && fs.existsSync(file) ? mergeConfig(DEFAULT_CONFIG, JSON.parse(fs.readFileSync(file, 'utf8'))) : structuredClone(DEFAULT_CONFIG);
  if (process.argv.includes('--offline')) {
    config.network.cursorApi = false;
    config.network.claudeUsageApi = false;
  }
  const snap = await collectSnapshot(createProviders(), config, { forceNetwork: true });
  console.log(JSON.stringify(snap, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
