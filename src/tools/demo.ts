import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, saveConfig } from '../core/config';
import { writeDemoHome } from './demoHome';

/** Launches the overlay against generated sample data so the UI can be previewed without any IDE. */
const root = path.resolve('.tmp', 'demo-home');
fs.rmSync(root, { recursive: true, force: true });
const cursorDb = path.join(root, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
writeDemoHome(root, Date.now(), cursorDb);

const configFile = path.resolve('.tmp', 'demo-config.json');
const cfg = structuredClone(DEFAULT_CONFIG);
cfg.dailyTokenBudget = 500_000;
cfg.network.cursorApi = false;
cfg.network.claudeUsageApi = false;
cfg.paths = { claudeDirs: [path.join(root, '.claude')], codexHome: path.join(root, '.codex'), cursorStateDb: cursorDb };
cfg.overlay.x = null;
cfg.overlay.y = null;
saveConfig(configFile, cfg);

const electronBin = require('electron') as unknown as string;
const child = spawn(electronBin, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, TOKENSLAYER_CONFIG: configFile, TOKENSLAYER_HOME: root },
});
child.on('exit', (code) => process.exit(code ?? 0));
