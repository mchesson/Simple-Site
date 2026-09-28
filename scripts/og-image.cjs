// Regenerates public/og-default.png, the default LinkedIn/social preview.
// Run: NODE_PATH=$(npm root -g) node scripts/og-image.cjs  (needs Playwright + Chromium)
const { chromium } = require('playwright');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.goto('file://' + path.join(__dirname, 'og-image.html'), { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(__dirname, '..', 'public', 'og-default.png') });
  await browser.close();
})();
