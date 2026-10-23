import { homedir } from "node:os";
import { join } from "node:path";

const playwrightCorePath =
  process.env.PLAYWRIGHT_CORE_PATH ??
  join(homedir(), "Code", "herdr-web-ui", "node_modules", "playwright-core");
const { chromium } = await import(playwrightCorePath);

const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
  join(homedir(), "Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");

const outDir = join(import.meta.dir, "..", "docs");

const browser = await chromium.launch({ executablePath });

// 1. Screenshot: Tab Bar
{
  const page = await browser.newPage({ viewport: { width: 920, height: 180 }, deviceScaleFactor: 2 });
  const html = `<!DOCTYPE html>
<html>
<head>
<style>
  body {
    margin: 0;
    padding: 24px;
    background: transparent;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
  }
  .window {
    background: #181825;
    border-radius: 10px;
    box-shadow: 0 16px 36px rgba(0,0,0,0.5), 0 0 0 1px #313244;
    overflow: hidden;
  }
  .titlebar {
    display: flex;
    align-items: center;
    padding: 10px 14px 4px 14px;
    background: #181825;
  }
  .dots {
    display: flex;
    gap: 7px;
  }
  .dot {
    width: 11px;
    height: 11px;
    border-radius: 50%;
  }
  .dot-red { background: #f38ba8; }
  .dot-yellow { background: #f9e2af; }
  .dot-green { background: #a6e3a1; }
  
  .tab-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: #11111b;
    border-top: 1px solid #313244;
    border-bottom: 1px solid #313244;
    padding: 0 16px;
    font-family: "SF Mono", Menlo, Monaco, Consolas, "JetBrains Mono", monospace;
    font-size: 12.5px;
    height: 38px;
  }
  .tabs {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .tab {
    padding: 4px 10px;
    border-radius: 5px;
    color: #a6adc8;
  }
  .tab.active {
    background: #313244;
    color: #cdd6f4;
    font-weight: 600;
  }
  .tab-right {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #89b4fa;
    font-weight: 500;
    letter-spacing: 0.2px;
  }
  .sep {
    color: #585b70;
  }
</style>
</head>
<body>
  <div class="window">
    <div class="titlebar">
      <div class="dots">
        <div class="dot dot-red"></div>
        <div class="dot dot-yellow"></div>
        <div class="dot dot-green"></div>
      </div>
    </div>
    <div class="tab-row">
      <div class="tabs">
        <div class="tab active">1: code</div>
        <div class="tab">2: server</div>
        <div class="tab">3: agent</div>
      </div>
      <div class="tab-right">
        <span>Claude 97%</span>
        <span class="sep">·</span>
        <span>Codex 90%</span>
        <span class="sep">·</span>
        <span>AGY 100%</span>
      </div>
    </div>
    <div style="height: 36px; background: #1e1e2e;"></div>
  </div>
</body>
</html>`;
  await page.setContent(html);
  await page.locator(".window").screenshot({ path: join(outDir, "tab-bar.png") });
  await page.close();
}

// 2. Screenshot: Modal Popup Breakdown
{
  const page = await browser.newPage({ viewport: { width: 920, height: 620 }, deviceScaleFactor: 2 });
  const html = `<!DOCTYPE html>
<html>
<head>
<style>
  body {
    margin: 0;
    padding: 24px;
    background: transparent;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
  }
  .window {
    background: #181825;
    border-radius: 10px;
    box-shadow: 0 20px 48px rgba(0,0,0,0.6), 0 0 0 1px #313244;
    overflow: hidden;
    position: relative;
    height: 570px;
  }
  .titlebar {
    display: flex;
    align-items: center;
    padding: 10px 14px;
    background: #181825;
    border-bottom: 1px solid #313244;
  }
  .dots {
    display: flex;
    gap: 7px;
  }
  .dot {
    width: 11px;
    height: 11px;
    border-radius: 50%;
  }
  .dot-red { background: #f38ba8; }
  .dot-yellow { background: #f9e2af; }
  .dot-green { background: #a6e3a1; }

  /* Background terminal surface */
  .terminal-bg {
    padding: 18px 24px;
    font-family: "SF Mono", Menlo, Monaco, Consolas, monospace;
    font-size: 13px;
    color: #45475a;
    line-height: 1.5;
  }

  /* Modal Popup */
  .popup-overlay {
    position: absolute;
    top: 36px;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(17, 17, 27, 0.72);
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(2px);
  }
  .popup-card {
    background: #1e1e2e;
    border: 1px solid #89b4fa;
    border-radius: 8px;
    width: 680px;
    padding: 18px 22px;
    box-shadow: 0 18px 42px rgba(0,0,0,0.65);
    font-family: "SF Mono", Menlo, Monaco, Consolas, "JetBrains Mono", monospace;
    font-size: 12.5px;
    color: #cdd6f4;
    line-height: 1.45;
  }
  .bold { font-weight: bold; color: #f5e0dc; }
  .dim { color: #6c7086; }
  .bar-green { color: #a6e3a1; letter-spacing: -1px; }
  .bar-amber { color: #fab387; letter-spacing: -1px; }
  .bar-red { color: #f38ba8; letter-spacing: -1px; }
  .bar-empty { color: #45475a; letter-spacing: -1px; }
  .bullet { color: #89dceb; }
  .section-title { font-weight: 700; color: #cdd6f4; font-size: 13px; margin-bottom: 2px; }
  .row { display: flex; align-items: center; }
  .label-cell { width: 140px; }
  .label-wide { width: 230px; }
  .bar-cell { margin-right: 12px; font-size: 14px; }
  .pct-cell { width: 105px; font-variant-numeric: tabular-nums; }
  .sub-indent { padding-left: 18px; margin-top: 3px; }
  .footer-stamp {
    margin-top: 14px;
    padding-top: 10px;
    border-top: 1px dashed #313244;
    font-size: 11.5px;
    text-align: right;
    color: #6c7086;
  }
</style>
</head>
<body>
  <div class="window">
    <div class="titlebar">
      <div class="dots">
        <div class="dot dot-red"></div>
        <div class="dot dot-yellow"></div>
        <div class="dot dot-green"></div>
      </div>
    </div>
    <div class="terminal-bg">
      $ herdr<br>
      Attaching to session 'main' (3 workspaces, 4 panes)...<br>
      [tmux mode active] Press prefix + u for usage breakdown...
    </div>
    
    <div class="popup-overlay">
      <div class="popup-card">
        <!-- Claude -->
        <div>
          <div class="section-title"><span class="bold">Claude</span> <span class="dim">pro · ehsanr.web@gmail.com</span></div>
          <div class="sub-indent">
            <div class="row">
              <span class="label-cell dim">5h session</span>
              <span class="bar-cell"><span class="bar-green">████████████████</span></span>
              <span class="pct-cell">97% remaining</span>
              <span class="dim">↻2h40 (03:30 PM)</span>
            </div>
            <div class="row">
              <span class="label-cell dim">7d weekly</span>
              <span class="bar-cell"><span class="bar-green">████████████████</span></span>
              <span class="pct-cell">100% remaining</span>
              <span class="dim">↻7d (Oct 30, 03:00 AM)</span>
            </div>
            <div class="row">
              <span class="label-cell dim">Extra usage</span>
              <span class="dim">£12.92 / £15.39</span>
              <span style="color:#fab387; margin-left:14px; margin-right:8px;">16% remaining</span>
              <span class="dim">(£2.47 left)</span>
            </div>
          </div>
        </div>

        <div style="height: 10px;"></div>

        <!-- Codex -->
        <div>
          <div class="section-title"><span class="bold">Codex</span> <span class="dim">plus · ehsanr.web@gmail.com</span></div>
          <div class="sub-indent">
            <div class="row">
              <span class="label-cell dim">5h session</span>
              <span class="bar-cell"><span class="bar-green">██████████████</span><span class="bar-empty">░░</span></span>
              <span class="pct-cell">90% remaining</span>
              <span class="dim">↻2h56 (03:46 PM)</span>
            </div>
            <div class="row">
              <span class="label-cell dim">Weekly</span>
              <span class="bar-cell"><span class="bar-green">████████████████</span></span>
              <span class="pct-cell">98% remaining</span>
              <span class="dim">↻7d (Oct 30, 09:46 AM)</span>
            </div>
            <div style="margin-top: 3px;">
              <span class="dim" style="font-weight:600;">Rate limit resets (2 available):</span>
              <div style="padding-left: 12px; margin-top: 2px;">
                <div><span class="bullet">•</span> Reset #1: Full reset (Weekly + 5 hr) <span class="dim">· expires in 6d (Oct 29, 05:02 PM)</span></div>
                <div><span class="bullet">•</span> Reset #2: Full reset (Weekly + 5 hr) <span class="dim">· expires in 14d (Nov 6, 09:57 PM)</span></div>
              </div>
            </div>
          </div>
        </div>

        <div style="height: 10px;"></div>

        <!-- Antigravity -->
        <div>
          <div class="section-title"><span class="bold">Antigravity</span> <span class="dim">· ehsanr.web@gmail.com</span></div>
          <div class="sub-indent">
            <div>
              <span class="dim" style="font-weight:600;">Gemini Models</span> <span class="dim">(Gemini Flash, Gemini Pro)</span>
              <div style="padding-left: 12px;">
                <div class="row">
                  <span class="label-wide dim">Weekly Limit Remaining</span>
                  <span class="bar-cell"><span class="bar-green">████████████████</span></span>
                  <span class="pct-cell">97% remaining</span>
                  <span class="dim">↻3d (Oct 26, 12:15 PM)</span>
                </div>
                <div class="row">
                  <span class="label-wide dim">Five Hour Limit Remaining</span>
                  <span class="bar-cell"><span class="bar-green">███████████████</span><span class="bar-empty">░</span></span>
                  <span class="pct-cell">94% remaining</span>
                  <span class="dim">↻3h21 (04:11 PM)</span>
                </div>
              </div>
            </div>
            
            <div style="margin-top: 4px;">
              <span class="dim" style="font-weight:600;">Claude and GPT models</span> <span class="dim">(Claude Opus, Claude Sonnet, GPT-OSS)</span>
              <div style="padding-left: 12px;">
                <div class="row">
                  <span class="label-wide dim">Weekly Limit Remaining</span>
                  <span class="bar-cell"><span class="bar-green">████████████████</span></span>
                  <span class="pct-cell">98% remaining</span>
                  <span class="dim">↻4d (Oct 27, 03:15 PM)</span>
                </div>
                <div class="row">
                  <span class="label-wide dim">Five Hour Limit Remaining</span>
                  <span class="bar-cell"><span class="bar-green">████████████████</span></span>
                  <span class="pct-cell">100% remaining</span>
                  <span class="dim">↻2h42 (03:32 PM)</span>
                </div>
              </div>
            </div>

            <div style="margin-top: 4px;">
              <span class="dim" style="font-weight:600;">Gemini 4 Argon</span>
              <div style="padding-left: 12px;">
                <div class="row">
                  <span class="label-wide dim">Gemini 4 Argon Weekly</span>
                  <span class="bar-cell"><span class="bar-red">█</span><span class="bar-empty">░░░░░░░░░░░░░░░</span></span>
                  <span class="pct-cell" style="color:#f38ba8;">4% remaining</span>
                  <span class="dim">↻2d (Oct 25, 04:34 PM)</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="footer-stamp">
          updated 12:51 · press <span style="color:#cdd6f4;">q</span> or <span style="color:#cdd6f4;">esc</span> to close
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
  await page.setContent(html);
  await page.locator(".window").screenshot({ path: join(outDir, "modal-breakdown.png") });
  await page.close();
}

await browser.close();
console.log("Screenshots generated successfully in docs/");
