const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function takeScreenshots() {
  const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const userDataDir = path.join(process.cwd(), '.edge-profile');
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  const port = 9222;
  const edgeProcess = spawn(edgePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    `--user-data-dir=${userDataDir}`,
    'about:blank'
  ], {
    stdio: 'ignore'
  });

  console.log('Edge spawned, waiting for CDP...');
  let versionData = null;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        versionData = await res.json();
        break;
      }
    } catch (e) {}
    await sleep(300);
  }

  if (!versionData) {
    console.error('Failed to connect to Edge CDP');
    edgeProcess.kill();
    return;
  }

  console.log('Connected to Edge CDP:', versionData.Browser);

  function createCdpSession(wsUrl) {
    const ws = new WebSocket(wsUrl);
    let id = 1;
    const callbacks = new Map();

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id && callbacks.has(data.id)) {
        const { resolve, reject } = callbacks.get(data.id);
        callbacks.delete(data.id);
        if (data.error) reject(data.error);
        else resolve(data.result);
      }
    };

    const send = (method, params = {}) => {
      return new Promise((resolve, reject) => {
        const msgId = id++;
        callbacks.set(msgId, { resolve, reject });
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });
    };

    return new Promise((resolve) => {
      ws.onopen = () => resolve({ send, close: () => ws.close() });
    });
  }

  const targetRes = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  const target = await targetRes.json();
  const session = await createCdpSession(target.webSocketDebuggerUrl);

  await session.send('Page.enable');
  await session.send('DOM.enable');

  const htmlUrl = 'file:///' + path.resolve('index.html').replace(/\\/g, '/');
  const screenshotsDir = path.join(process.cwd(), 'screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  async function capture(fileName, width, height, dark = false, action = null, fullPage = false) {
    console.log(`Capturing ${fileName} (${width}x${height}, dark=${dark}, fullPage=${fullPage})...`);
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: width,
      height: height,
      deviceScaleFactor: 1,
      mobile: width <= 768,
      screenOrientation: { angle: 0, type: 'portraitPrimary' }
    });

    await session.send('Page.navigate', { url: htmlUrl });
    await sleep(1500);

    await session.send('Runtime.evaluate', {
      expression: `
        if (${dark}) {
          document.documentElement.classList.add('dark');
          localStorage.setItem('theme', 'dark');
        } else {
          document.documentElement.classList.remove('dark');
          localStorage.setItem('theme', 'light');
        }
        if (typeof renderCharts === 'function') renderCharts();
      `
    });
    await sleep(500);

    if (action) {
      await session.send('Runtime.evaluate', { expression: action });
      await sleep(500);
    }

    const screenshotParams = {
      format: 'png',
      captureBeyondViewport: fullPage
    };

    const screenshotData = await session.send('Page.captureScreenshot', screenshotParams);
    const filePath = path.join(screenshotsDir, fileName);
    fs.writeFileSync(filePath, Buffer.from(screenshotData.data, 'base64'));
    console.log(`Saved ${fileName} (${fs.statSync(filePath).size} bytes)`);
  }

  // 1. Desktop 1280px (Light Mode)
  await capture('desktop-1280.png', 1280, 900, false);

  // 2. Desktop Full Page (Light Mode - shows table, stock, GST summary, footer)
  await capture('desktop-full-1280.png', 1280, 900, false, null, true);

  // 3. New Invoice Modal (Desktop)
  await capture('modal-new-invoice.png', 1280, 900, false, `
    openNewInvoiceModal();
  `);

  // 3b. Lab Rubric Guide Modal (Desktop)
  await capture('modal-rubric-guide.png', 1280, 900, false, `
    toggleRubricModal();
  `);

  // 4. Tablet 768px (Light Mode)
  await capture('tablet-768.png', 768, 1024, false);

  // 5. Mobile 375px (Light Mode)
  await capture('mobile-375.png', 375, 812, false);

  // 6. Mobile 375px Sidebar Open (Light Mode)
  await capture('mobile-sidebar-open-375.png', 375, 812, false, `
    toggleSidebar();
  `);

  // 7. Desktop 1280px (Dark Mode)
  await capture('desktop-dark-1280.png', 1280, 900, true);

  // 8. Desktop Full Page (Dark Mode)
  await capture('desktop-dark-full-1280.png', 1280, 900, true, null, true);

  // 9. Mobile 375px (Dark Mode)
  await capture('mobile-dark-375.png', 375, 812, true);

  session.close();
  edgeProcess.kill();
  console.log('All screenshots completed successfully!');
}

takeScreenshots().catch(err => {
  console.error('Screenshot error:', err);
  process.exit(1);
});
