// Dev helper: screenshots of the built site for visual review.
// Run: npm run build && npx astro preview & ; NODE_PATH=$(npm root -g) node scripts/shots.cjs <outdir>
const { chromium } = require('playwright');
const out = process.argv[2] || 'shots';
const base = process.env.BASE || 'http://localhost:4321';
const pages = ['/', '/life-sciences', '/data-centers', '/news', '/news/cq-where-schedules-are-won', '/how-we-engage', '/careers'];
(async () => {
  const b = await chromium.launch();
  for (const [name, vp] of [['desk', { width: 1366, height: 900 }], ['mob', { width: 390, height: 844 }]]) {
    const ctx = await b.newContext({ viewport: vp });
    const p = await ctx.newPage();
    for (const u of pages) {
      await p.goto(base + u, { waitUntil: 'networkidle' });
      const f = `${out}/${name}${u.replace(/\//g, '_') || '_home'}.png`;
      await p.screenshot({ path: f, fullPage: true });
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      console.log(f, overflow ? 'HORIZONTAL OVERFLOW' : '');
    }
    await ctx.close();
  }
  await b.close();
})();
