// Generates PawPals app icon: orange rounded square + white paw print
// Uses only built-in Node.js + canvas (via @napi-rs/canvas which is already in node_modules)
import { createCanvas } from '@napi-rs/canvas';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function drawIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const r = size * 0.22; // corner radius

  // Orange rounded background
  ctx.fillStyle = '#F5A93C';
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(size - r, 0);
  ctx.quadraticCurveTo(size, 0, size, r);
  ctx.lineTo(size, size - r);
  ctx.quadraticCurveTo(size, size, size - r, size);
  ctx.lineTo(r, size);
  ctx.quadraticCurveTo(0, size, 0, size - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.fill();

  // White paw print centered
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  const cx = size / 2;
  const cy = size / 2 + size * 0.04;
  const s = size * 0.28; // scale

  // Main pad (large rounded shape)
  ctx.beginPath();
  ctx.ellipse(cx, cy + s * 0.18, s * 0.52, s * 0.48, 0, 0, Math.PI * 2);
  ctx.fill();

  // Top toes
  const toes = [
    { x: cx - s * 0.44, y: cy - s * 0.38, rx: s * 0.18, ry: s * 0.22 },
    { x: cx - s * 0.15, y: cy - s * 0.60, rx: s * 0.16, ry: s * 0.20 },
    { x: cx + s * 0.15, y: cy - s * 0.60, rx: s * 0.16, ry: s * 0.20 },
    { x: cx + s * 0.44, y: cy - s * 0.38, rx: s * 0.18, ry: s * 0.22 },
  ];
  for (const toe of toes) {
    ctx.beginPath();
    ctx.ellipse(toe.x, toe.y, toe.rx, toe.ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  return canvas.toBuffer('image/png');
}

const iconsetDir = path.join(repoRoot, 'resources', 'PawPals.iconset');
fs.mkdirSync(iconsetDir, { recursive: true });

const sizes = [16, 32, 64, 128, 256, 512, 1024];
for (const sz of sizes) {
  const buf = drawIcon(sz);
  if (sz <= 512) {
    fs.writeFileSync(path.join(iconsetDir, `icon_${sz}x${sz}.png`), buf);
  }
  if (sz >= 32) {
    fs.writeFileSync(path.join(iconsetDir, `icon_${sz/2}x${sz/2}@2x.png`), buf);
  }
}
// iconutil needs specific filenames
fs.writeFileSync(path.join(iconsetDir, 'icon_512x512@2x.png'), drawIcon(1024));

console.log('PNG files generated, running iconutil...');
const icnsPath = path.join(repoRoot, 'resources', 'icon.icns');
execSync(`iconutil -c icns "${iconsetDir}" -o "${icnsPath}"`);
console.log('✅ icon.icns created at', icnsPath);
