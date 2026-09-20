// ABC → PDF via the site's abcjs + Playwright Chromium. One browser for the whole run.
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, "..", "..", "..", "WorshipCommons");
const ABCJS = path.join(SITE, "node_modules", "abcjs", "dist", "abcjs-basic-min.js");
const PW = path.join(SITE, "node_modules", "playwright");

let browser, page, htmlFile;

function htmlTemplate() {
  const abcjsUrl = pathToFileURL(ABCJS).href;
  return `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 12px 18px; background: #fff; color: #111; font-family: Georgia, serif; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { font-size: 11px; color: #444; margin: 0 0 12px; }
  #paper svg { max-width: 100%; }
  .foot { font-size: 9px; color: #555; margin-top: 16px; }
</style>
<script src="${abcjsUrl}"></script>
<h1 id="title"></h1>
<p class="sub" id="sub"></p>
<div id="paper"></div>
<p class="foot" id="foot"></p>
<script>
  window.renderAbcPdf = (abc, title, sub, foot, transpose) => {
    document.getElementById("title").textContent = title || "";
    document.getElementById("sub").textContent = sub || "";
    document.getElementById("foot").textContent = foot || "";
    document.getElementById("paper").innerHTML = "";
    ABCJS.renderAbc("paper", abc, { visualTranspose: transpose || 0, staffwidth: 720 });
  };
</script>`;
}

export async function startEngraver() {
  if (page) return page;
  if (!fs.existsSync(ABCJS) || !fs.existsSync(PW)) {
    throw new Error(`abcjs/playwright not found under ${SITE} — run yarn in WorshipCommons`);
  }
  const { chromium } = await import(pathToFileURL(path.join(PW, "index.mjs")).href);
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1200 } });
  page = await ctx.newPage();
  htmlFile = path.join(HERE, ".engrave.html");
  fs.writeFileSync(htmlFile, htmlTemplate());
  await page.goto(pathToFileURL(htmlFile).href);
  return page;
}

export async function engraveAbc(abc, dest, { title = "", subtitle = "", footer = "", transpose = 0 } = {}) {
  await startEngraver();
  await page.evaluate(([a, t, s, f, tr]) => window.renderAbcPdf(a, t, s, f, tr), [abc, title, subtitle, footer, transpose]);
  await page.evaluate(() => new Promise(r => setTimeout(r, 80)));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await page.pdf({
    path: dest,
    format: "letter",
    printBackground: true,
    margin: { top: "0.45in", bottom: "0.5in", left: "0.45in", right: "0.45in" }
  });
  return dest;
}

export async function stopEngraver() {
  if (browser) await browser.close();
  browser = page = null;
  if (htmlFile && fs.existsSync(htmlFile)) fs.unlinkSync(htmlFile);
}
