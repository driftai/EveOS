const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const result = {};
  try {
    await page.goto(process.env.VOXELVISION_URL || 'http://127.0.0.1:9095');
    await page.waitForFunction(() => window.app?.depthData);
    await page.evaluate(async () => {
      const { createDepthCacheDescriptor } = await import('/js/depth-cache-codec.js');
      const store = window.app.depthPlayback.controller.store;
      await store.initialize();
      await store.saveSource('test:profiles', { title: 'Profile deletion fixture', url: '/media/voxelvision-demo.mp4' });
      for (const [id, fps] of [['delete-me', 4], ['keep-me', 8]]) {
        const descriptor = createDepthCacheDescriptor({ sourceIdentity: 'test:profiles', cols: 2, rows: 2, fps, modelKey: 'enhanced' });
        await store.openVariant(id, descriptor, { sourceIdentity: 'test:profiles', sourceTitle: 'Profile deletion fixture', frameCount: 1, totalFrames: 10, reusableFrames: 5 });
        await store.putFrame(id, 0, new Uint16Array([1, 2, 3, 4]));
      }
      await window.app.depthPlayback.library.refresh();
    });
    await page.evaluate(() => {
      const details = document.querySelector('.cache-profiles');
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    await page.waitForFunction(() => document.querySelectorAll('.cache-profile').length === 2);
    // Exercise the actual confirmation/button handler, including cancellation.
    page.once('dialog', dialog => dialog.dismiss());
    await page.evaluate(() => [...document.querySelectorAll('.cache-profile')].find(e => e.textContent.includes('4 depth FPS')).querySelectorAll('button')[2].click());
    if (!await page.evaluate(() => window.app.depthPlayback.controller.store.getSession('delete-me'))) throw new Error('Cancelled deletion removed profile');
    page.once('dialog', dialog => dialog.accept());
    await page.evaluate(() => [...document.querySelectorAll('.cache-profile')].find(e => e.textContent.includes('4 depth FPS')).querySelectorAll('button')[2].click());
    await page.waitForFunction(async () => !(await window.app.depthPlayback.controller.store.getSession('delete-me')));
    result.storage = await page.evaluate(async () => {
      const store = window.app.depthPlayback.controller.store;
      return { gone: !(await store.getFrame('delete-me', 0)), kept: Boolean(await store.getFrame('keep-me', 0)),
        source: Boolean(await store.getSource('test:profiles')), shared: (await store.getSession('keep-me')).reusableFrames };
    });
    if (!result.storage.gone || !result.storage.kept || !result.storage.source || result.storage.shared !== 0) throw new Error('Profile deletion affected wrong data or left stale shared counts');
    console.log('Cache profile deletion passed: cancel, exact removal, retained video/profile and refreshed counts.');
  } catch (error) { result.failure = error.message; throw error; }
  finally {
    const dir = path.resolve(__dirname, '../test-results'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cache-profile-delete.json'), JSON.stringify(result));
    await browser.close();
  }
})().catch(error => { console.error('cache-profile-delete:', error.message); process.exitCode = 1; });
