#!/usr/bin/env node
/**
 * Smoke test to verify the built extension loads in Chromium.
 *
 * Usage: node scripts/test-extension-load.mjs [extPath]
 *
 * Defaults to ext/ (unpacked extension directory from build).
 * Works under xvfb: xvfb-run -a node scripts/test-extension-load.mjs
 */

import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_EXT_PATH = path.join(PROJECT_ROOT, 'ext');
const SERVICE_WORKER_TIMEOUT_MS = 15000;
const POPUP_TIMEOUT_MS = 15000;
const MAIN_PAGE_TIMEOUT_MS = 15000;

function getExtensionIdFromUrl(url) {
  const match = url.match(/^chrome-extension:\/\/([^/]+)\//);
  return match ? match[1] : null;
}

async function testExtensionLoad(extPath) {
  let browser = null;

  let exitCode = 0;

  // Validate extension directory and manifest
  if (!fs.existsSync(extPath)) {
    console.error(`ERROR: Extension path does not exist: ${extPath}`);
    console.error('Usage: node scripts/test-extension-load.mjs [extPath]');
    return 1;
  }

  const manifestPath = path.join(extPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`ERROR: No manifest.json found at: ${manifestPath}`);
    return 1;
  }

  console.log(`Testing extension load: ${extPath}`);

  try {
    // Launch Chromium in headful mode with extension args
    browser = await puppeteer.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        `--disable-extensions-except=${extPath}`,
        `--load-extension=${extPath}`,
      ],
      defaultViewport: { width: 1280, height: 720 },
      dumpio: false,
    });

    // Wait for extension service worker target (MV3) and parse extension ID
    const swTarget = await browser.waitForTarget(
      (target) => target.type() === 'service_worker' && target.url().startsWith('chrome-extension://'),
      { timeout: SERVICE_WORKER_TIMEOUT_MS }
    );

    const extensionId = getExtensionIdFromUrl(swTarget.url());

    if (!extensionId) {
      throw new Error('Could not parse extension ID from extension service worker URL');
    }

    console.log(`Extension ID: ${extensionId}`);

    // Open popup page and verify mount point exists
    const popupUrl = `chrome-extension://${extensionId}/popup.html`;
    console.log(`Loading: ${popupUrl}`);

    const popupPage = await browser.newPage();
    const popupErrors = [];
    popupPage.on('pageerror', (err) => {
      popupErrors.push(err?.message || String(err));
    });

    try {
      await popupPage.goto(popupUrl, { waitUntil: 'domcontentloaded', timeout: POPUP_TIMEOUT_MS });
      await popupPage.waitForSelector('#root', { timeout: POPUP_TIMEOUT_MS });

      if (popupErrors.length) {
        throw new Error(`Popup runtime errors: ${popupErrors.join(' | ')}`);
      }
    } finally {
      await popupPage.close();
    }

    // Open main route used in production flows and ensure no runtime errors.
    const welcomePage = await browser.newPage();
    const welcomeErrors = [];
    welcomePage.on('pageerror', (err) => {
      welcomeErrors.push(err?.message || String(err));
    });

    try {
      const welcomeUrl = `chrome-extension://${extensionId}/main.html#/welcome`;
      await welcomePage.goto(welcomeUrl, {
        waitUntil: 'domcontentloaded',
        timeout: MAIN_PAGE_TIMEOUT_MS,
      });
      await welcomePage.waitForSelector('#root', { timeout: MAIN_PAGE_TIMEOUT_MS });
      await new Promise((resolve) => setTimeout(resolve, 1000));

      if (welcomeErrors.length) {
        throw new Error(`Main welcome runtime errors: ${welcomeErrors.join(' | ')}`);
      }
    } finally {
      await welcomePage.close();
    }

    console.log('\n========================================');
    console.log('EXTENSION LOAD TEST: PASSED');
    console.log(`Extension ID: ${extensionId}`);
    console.log('========================================');
  } catch (err) {
    console.error('\n✗ TEST FAILED');
    console.error(`Error: ${err.message}`);
    exitCode = 1;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Ignore close errors so we keep original failure semantics.
      }
    }
  }

  return exitCode;
}

// Main
const extPath = process.argv[2] || DEFAULT_EXT_PATH;

testExtensionLoad(extPath)
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(1);
  });
