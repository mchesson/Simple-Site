/* Run the page the way a published artifact runs it, and click the things.
 *
 *     node app/test/sandbox-check.mjs
 *
 * This file exists because of a specific bug. Every check I had run loaded the
 * page from a file:// URL, where window.prompt, window.confirm, window.alert and
 * <form> submission all work. A published artifact runs inside a sandboxed
 * frame, and a sandbox without allow-modals and allow-forms does not refuse
 * those - it IGNORES them. prompt returns null, confirm returns false, alert
 * does nothing, a form submit event never fires. Every button built on one of
 * them silently did nothing, and every error message was invisible, so the whole
 * app looked broken while every test passed.
 *
 * So the harness below builds the same sandbox and asserts on outcomes - the
 * note landed on the record, the refusal is on the screen - rather than on a
 * dialog merely having opened.
 */
import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, "..", "ts-workspace.html");

// Chromium ships with Playwright; a pinned build may not match what is on disk.
const EXPLICIT = process.env.CHROMIUM_PATH;
function findChromium() {
  if (EXPLICIT) return EXPLICIT;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  if (!fs.existsSync(root)) return undefined;
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith("chromium-"))) {
    const p = path.join(root, d, "chrome-linux", "chrome");
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "ts-sandbox-"));
fs.copyFileSync(PAGE, path.join(work, "inner.html"));
// allow-scripts only: no allow-modals, no allow-forms. This is the constraint.
fs.writeFileSync(path.join(work, "outer.html"),
  `<!doctype html><html><body style="margin:0"><iframe id="f" src="inner.html"
   sandbox="allow-scripts" style="width:100vw;height:100vh;border:0"></iframe>
   </body></html>`);

const browser = await chromium.launch({ executablePath: findChromium() });
const results = [];
let failed = 0;

async function check(name, fn) {
  try { await fn(); results.push(["ok", name]); }
  catch (e) { failed++; results.push(["FAIL", `${name} - ${e.message.split("\n")[0]}`]); }
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  const wide = viewport.width > 860;
  const label = wide ? "desktop" : "phone";
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // The first check below calls confirm and prompt on purpose to prove the
    // sandbox is really blocking them, and the browser logs that. Anything else
    // is a genuine error.
    if (/allow-modals/.test(m.text())) return;
    errs.push("console: " + m.text());
  });
  await page.goto("file://" + path.join(work, "outer.html"));
  await page.waitForSelector("#f");
  const f = page.frameLocator("#f");
  const fr = () => page.frames()[1];
  await f.locator(".shell").waitFor({ timeout: 15000 });

  const nav = async (t) => {
    if (!wide) {
      const m = f.locator(".menubtn");
      if (await m.count()) { await m.click(); await page.waitForTimeout(180); }
    }
    await f.locator("aside.nav button.item", { hasText: t }).first().click();
    await page.waitForTimeout(280);
  };
  const toast = () => fr().evaluate(() => {
    const n = document.querySelector(".saving");
    return n ? { text: n.innerText, dismissable: !!n.querySelector(".notex") } : null;
  });

  await check(`${label}: the browser really does block modals here`, async () => {
    const out = await fr().evaluate(() => ({
      confirm: window.confirm("x"), prompt: window.prompt("x", "y"),
    }));
    assert.equal(out.confirm, false, "confirm should be ignored - if not, this " +
      "harness is not reproducing the artifact sandbox and proves nothing");
    assert.equal(out.prompt, null, "prompt should be ignored");
  });

  await check(`${label}: every screen opens`, async () => {
    for (const item of ["Accounts", "Projects", "Paperwork", "Submissions",
                        "Interviews", "Pipelines", "Contacts", "Documents",
                        "My week", "Approvals", "Unlock requests",
                        "Purchase orders", "Invoices", "Audit trail", "My desk"]) {
      await nav(item);
      const shown = await f.locator(".topbar h2").innerText();
      assert.ok(shown.length, `${item} rendered nothing`);
      const oops = await f.locator(".pane h3.err").count();
      assert.equal(oops, 0, `${item} hit a problem`);
    }
  });

  await check(`${label}: logging an interaction writes it to the record`, async () => {
    const users = await f.locator("aside.nav select").locator("option").allInnerTexts();
    await f.locator("aside.nav select")
      .selectOption({ index: users.findIndex((o) => /recruiter/.test(o)) });
    await page.waitForTimeout(300);
    await nav("My desk");
    const log = f.locator("button.linkbtn", { hasText: "Log a" }).first();
    assert.ok(await log.count(), "the desk should offer somewhere to log a call");
    await log.click();
    await page.waitForTimeout(300);
    assert.equal(await f.locator("dialog.ask").count(), 1,
      "a blocked window.prompt would have opened nothing");
    const marker = "harness note " + Date.now();
    await f.locator("dialog.ask textarea").fill(marker);
    await f.locator("dialog.ask button.send").click();
    await page.waitForTimeout(500);
    assert.equal(await f.locator("dialog.ask").count(), 0,
      "the dialog did not close - a blocked form submit does this");
    await nav("Contacts");
    const rows = f.locator("table.grid tbody tr");
    let found = false;
    for (let i = 0; i < await rows.count() && !found; i++) {
      await rows.nth(i).click();
      await page.waitForTimeout(220);
      found = (await fr().evaluate(() => document.body.innerText)).includes(marker);
      if (!found) await nav("Contacts");
    }
    assert.ok(found, "the note was never written to anybody's record");
  });

  await check(`${label}: a refusal is visible and stays until dismissed`, async () => {
    await nav("Submissions");
    const everyone = f.locator(".segs .deskswitch button", { hasText: "Everyone" }).first();
    if (await everyone.count()) { await everyone.click(); await page.waitForTimeout(250); }
    await f.locator(".subcard").first().click();
    await page.waitForTimeout(300);
    await f.locator(".rowbtns button", { hasText: "Rejected" }).first().click();
    await page.waitForTimeout(300);
    // Submit with no reason. The rule refuses it; the person must be told why.
    await f.locator("dialog.ask button.send").click();
    await page.waitForTimeout(500);
    const t = await toast();
    assert.ok(t, "the refusal was invisible - this is what a blocked alert does");
    assert.match(t.text, /needs a reason/);
    assert.ok(t.dismissable, "a refusal should not vanish on a timer");
  });

  await check(`${label}: a confirmation can be cancelled and carried out`, async () => {
    await nav("Pipelines");
    const drop = f.locator("button.linkbtn", { hasText: "Drop" }).first();
    assert.ok(await drop.count(), "expected somebody droppable from a category");
    await drop.click();
    await page.waitForTimeout(300);
    assert.equal(await f.locator("dialog.ask").count(), 1,
      "a blocked window.confirm would have aborted silently");
    const before = await f.locator("table.grid tbody tr").count();
    await f.locator("dialog.ask button.ghost").click();
    await page.waitForTimeout(300);
    assert.equal(await f.locator("table.grid tbody tr").count(), before,
      "cancelling should change nothing");
    await f.locator("button.linkbtn", { hasText: "Drop" }).first().click();
    await page.waitForTimeout(300);
    await f.locator("dialog.ask button.send").click();
    await page.waitForTimeout(500);
    assert.equal(await f.locator("table.grid tbody tr").count(), before - 1,
      "confirming should have dropped one");
  });

  await check(`${label}: submitting a resource works end to end`, async () => {
    await nav("Submissions");
    await f.locator(".segs button.send", { hasText: "Submit a resource" }).click();
    await page.waitForTimeout(300);
    const selects = f.locator("dialog.ask select");
    assert.ok(await selects.count() >= 2, "expected a person and a project to pick");
    await f.locator("dialog.ask input[type=number]").nth(0).fill("60");
    await f.locator("dialog.ask input[type=number]").nth(1).fill("100");
    await page.waitForTimeout(200);
    const live = await f.locator(".livenote").innerText();
    assert.match(live, /Gross margin/, "the margin should be worked out as you type");
    await f.locator("dialog.ask button.send").click();
    await page.waitForTimeout(600);
    const title = await f.locator(".topbar h2").innerText();
    assert.equal(title, "Submission", "submitting should land on the new submission");
  });

  await check(`${label}: nothing logs an error`, () => {
    assert.deepEqual(errs, []);
  });

  await ctx.close();
}

await browser.close();
fs.rmSync(work, { recursive: true, force: true });

for (const [state, name] of results) {
  console.log(`${state === "ok" ? "ok  " : "FAIL"} ${name}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
