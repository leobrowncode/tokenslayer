import fs from 'node:fs';
import { iconPNG } from '../core/icon';

fs.mkdirSync('build', { recursive: true });
fs.writeFileSync('build/icon.png', iconPNG(256, 'ok'));
console.log('wrote build/icon.png');
