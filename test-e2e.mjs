import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();

  // Step 1: Go to pingdog.net
  console.log('1. Opening pingdog.net...');
  await page.goto('https://pingdog.net', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.screenshot({ path: '/tmp/pingdog-1-home.png' });
  console.log('   Page title:', await page.title());

  // Step 2: Click generate key
  console.log('2. Generating key...');
  await page.click('#gen-btn');
  await page.waitForSelector('#key-display', { state: 'visible', timeout: 5000 });
  const key = await page.textContent('#key-text');
  console.log('   Generated key:', key.substring(0, 20) + '...');
  await page.screenshot({ path: '/tmp/pingdog-2-key.png' });

  // Step 3: Go to account page
  console.log('3. Going to account page...');
  await page.goto('https://pingdog.net/account.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.screenshot({ path: '/tmp/pingdog-3-account.png' });

  // Step 4: Enter the key
  console.log('4. Entering key...');
  await page.fill('#key-input', key.trim());
  await page.click('#load-btn');
  await page.waitForSelector('#account-data', { state: 'visible', timeout: 10000 });
  await page.screenshot({ path: '/tmp/pingdog-4-loaded.png' });
  console.log('   Account loaded');

  // Step 5: Add a monitor
  console.log('5. Adding monitor...');
  await page.click('button:has-text("+ Add monitor")');
  await page.waitForSelector('#add-monitor-modal.open', { timeout: 5000 });
  await page.fill('#m-url', 'https://chainrpc.net');
  await page.fill('#m-name', 'ChainRPC E2E Test');
  await page.screenshot({ path: '/tmp/pingdog-5-modal.png' });
  await page.locator('#add-monitor-modal .btn-primary').first().click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: '/tmp/pingdog-6-after-add.png' });
  console.log('   Monitor add submitted');

  // Step 6: Verify monitors table has data
  const monitorRows = await page.locator('#monitors-table tr').count();
  console.log('   Monitor rows in table:', monitorRows);

  const hasContent = await page.locator('#monitors-table tr').first().textContent();
  console.log('   First row:', hasContent.substring(0, 100).trim());

  await browser.close();

  if (monitorRows === 0 || hasContent.includes('No monitors')) {
    console.error('FAILED: No monitors shown in table');
    process.exit(1);
  }
  console.log('SUCCESS: PingDog E2E test passed!');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
