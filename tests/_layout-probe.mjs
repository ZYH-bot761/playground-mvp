import { chromium } from 'playwright';
import fs from 'node:fs';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await chromium.launch({ executablePath: fs.existsSync(EDGE) ? EDGE : undefined, headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:5173/?t=' + Date.now(), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__playground?.bootReady === true, null, { timeout: 120000 });
await page.locator('[data-action="start"]').click();
await page.waitForFunction(() => window.__playground?.loopStarted === true, null, { timeout: 30000 });
await page.waitForTimeout(400);
const data = await page.evaluate(() => {
  const l = window.__playground.attractionManager.active;
  return {
    boxes: l._buildingBoxes,
    facilities: l.root.userData.facilities,
  };
});
// Search dance-hall center: AABB ±6.5 x, z -7.5..1.5 relative; trigger at z+8.
const others = data.boxes.filter((b) => b.key !== 'dance-hall' && b.key !== 'fireworks-deck');
const inRoad = (x, z) => (x > 16 && x < 32) || (z > 19 && z < 35);
const circles = [{ x: 0, z: 15, r: 10 }, { x: 0, z: 6, r: 5 }, { x: 26, z: -2, r: 8 }];
const hits = (b, x, z) => b.minX < x + 6.5 && b.maxX > x - 6.5 && b.minZ < z + 4.5 && b.maxZ > z - 4.5;
const cands = [];
for (let x = -27; x <= 14; x += 0.5) {
  for (let z = -27; z <= 14; z += 0.5) {
    if (inRoad(x, z) || inRoad(x, z + 8)) continue;
    if (others.some((b) => hits(b, x, z))) continue;
    if (circles.some((c) => Math.hypot(x - c.x, z - c.z) < c.r + 6)) continue;
    cands.push([x, z]);
  }
}
console.log(JSON.stringify({ boxes: data.boxes, facilities: data.facilities, candidates: cands.slice(0, 30) }, null, 1));
await browser.close();
