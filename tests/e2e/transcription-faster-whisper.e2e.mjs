#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");

const extensionPath = path.join(projectRoot, "ext");
const fixturePath = path.join(projectRoot, "tests/fixtures/audio/hello-world.wav");
const serverScriptPath = path.join(projectRoot, "scripts/faster-whisper-test-server.py");
const serverHost = process.env.FW_TEST_HOST || "127.0.0.1";
const serverPort = Number(process.env.FW_TEST_PORT || "8978");
const serverBaseUrl = `http://${serverHost}:${serverPort}/v1`;
const expectedWords = ["world"];
const runHeadless = process.env.MEEPER_E2E_HEADED !== "1";
const serverStartupTimeoutMs = Number(process.env.FW_TEST_HEALTH_TIMEOUT_MS || "20000");
const recordRouteTimeoutMs = Number(process.env.MEEPER_E2E_READY_TIMEOUT_MS || "30000");
const requireRealFasterWhisper = process.env.MEEPER_E2E_REQUIRE_REAL_FW === "1";
const usePulseAudio =
  process.env.MEEPER_E2E_USE_PULSE === "1" || Boolean(process.env.PULSE_SERVER);
const pulseSinkName = process.env.MEEPER_PULSE_SINK_NAME || "meeper_e2e_sink";
const pulseServer = process.env.PULSE_SERVER || "";
const meetUrl = process.env.MEEPER_E2E_MEET_URL || "https://meet.google.com/exh-bsyc-ddc";
const meetUrlPrefix = meetUrl.split("?")[0];

function assertPathExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTranscript(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasExpectedTranscript(text) {
  const normalized = normalizeTranscript(text);

  return expectedWords.every((word) => {
    if (normalized.includes(word)) {
      return true;
    }

    const compactNeedle = word.replace(/\s+/g, "");
    const compactHaystack = normalized.replace(/\s+/g, "");
    return compactHaystack.includes(compactNeedle);
  });
}

async function playFixtureViaPulse() {
  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-stream_loop",
      "4",
      "-re",
      "-i",
      fixturePath,
      "-af",
      "volume=4",
      "-f",
      "pulse",
      ...(pulseServer ? ["-server", pulseServer] : []),
      "-device",
      pulseSinkName,
      "-buffer_duration",
      "100",
      "-prebuf",
      "0",
      "meeper-e2e-fixture",
    ];

    const child = spawn("ffmpeg", ffmpegArgs, {
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

async function waitForRecordPageReady(page, timeoutMs) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const result = await page.evaluate(() => {
      const hooks = window.__MEEPER_E2E__;
      if (!hooks) {
        return {
          hasHooks: false,
          ready: false,
          state: null,
        };
      }

      return {
        hasHooks: true,
        ready: Boolean(hooks.ready),
        state: hooks.state || null,
      };
    });

    if (result.ready) {
      return result;
    }

    if (result.state?.lastError) {
      throw new Error(`Recorder initialization failed: ${result.state.lastError}`);
    }

    await wait(500);
  }

  const debugState = await page.evaluate(() => {
    return {
      url: location.href,
      hasHooks: Boolean(window.__MEEPER_E2E__),
      hooks: window.__MEEPER_E2E__
        ? {
            ready: Boolean(window.__MEEPER_E2E__.ready),
            hasStop: typeof window.__MEEPER_E2E__.stop === "function",
            state: window.__MEEPER_E2E__.state || null,
          }
        : null,
      bodyText: (document.body?.innerText || "").slice(0, 300),
    };
  });

  throw new Error(`Record page did not become ready: ${JSON.stringify(debugState)}`);
}

async function installRecordPageHooks(page, baseUrl, useInPageAudio) {
  await page.evaluateOnNewDocument(
    (baseUrlValue, useInPageAudioValue) => {
      const globalWindow = window;

      globalWindow.__MEEPER_E2E__ = {
        ready: false,
        keepOpen: true,
        state: null,
        stop: null,
        beforeStart: async () => {
          await chrome.storage.local.set({
            _whisper_settings: {
              provider: "typewhisper",
              baseUrl: baseUrlValue,
              apiKey: "",
            },
          });
        },
      };

      if (!useInPageAudioValue) {
        return;
      }

      if (!globalWindow.__MEEPER_E2E_AUDIO_CONTEXT__) {
        const context = new AudioContext();
        const destination = context.createMediaStreamDestination();
        globalWindow.__MEEPER_E2E_AUDIO_CONTEXT__ = context;
        globalWindow.__MEEPER_E2E_AUDIO_DESTINATION__ = destination;
        globalWindow.__MEEPER_E2E_AUDIO_STREAM_GETTER__ = () => destination.stream;
      }

      const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );

      navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (
          constraints?.audio &&
          typeof globalWindow.__MEEPER_E2E_AUDIO_STREAM_GETTER__ === "function"
        ) {
          const stream = globalWindow.__MEEPER_E2E_AUDIO_STREAM_GETTER__();
          if (stream) {
            return stream;
          }
        }

        return originalGetUserMedia(constraints);
      };
    },
    baseUrl,
    useInPageAudio,
  );
}

async function resolveMeetTabIdFromExtensionPage(page, meetUrlPrefixValue) {
  const payload = await page.evaluate((prefix) => {
    return new Promise((resolve) => {
      chrome.tabs.query({}, (tabs) => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({
            error: err.message,
            tabs: [],
          });
          return;
        }

        resolve({
          tabs: (tabs || []).map((tab) => ({
            id: tab.id,
            url: tab.url || "",
            active: Boolean(tab.active),
            currentWindow: Boolean(tab.currentWindow),
          })),
        });
      });
    });
  }, meetUrlPrefixValue);

  if (payload?.error) {
    throw new Error(`chrome.tabs.query failed in extension page: ${payload.error}`);
  }

  const tabs = Array.isArray(payload?.tabs) ? payload.tabs : [];
  const meetTab = tabs.find((tab) => {
    if (typeof tab?.id !== "number") {
      return false;
    }

    return typeof tab.url === "string" && tab.url.startsWith(meetUrlPrefixValue);
  });

  if (!meetTab) {
    throw new Error(
      `Failed to find Meet tab in extension page tab list: ${JSON.stringify(tabs)}`,
    );
  }

  return meetTab.id;
}

async function waitForHealth(url, timeoutMs = serverStartupTimeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${url.replace(/\/$/, "")}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }

    await wait(500);
  }

  throw new Error(`Timed out waiting for faster-whisper test server at ${url}/health`);
}

function startServer() {
  const requireRealArgs = requireRealFasterWhisper ? ["--require-real"] : [];

  const child = spawn(
    "python3",
    [
      serverScriptPath,
      "--host",
      serverHost,
      "--port",
      String(serverPort),
      "--fixture-manifest",
      "tests/fixtures/audio/fixtures.json",
      ...requireRealArgs,
    ],
    {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    },
  );

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[fw-server] ${chunk}`);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[fw-server] ${chunk}`);
  });

  return child;
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }, 4_000);

    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    child.kill("SIGTERM");
  });
}

async function getExtensionId(browser, timeoutMs = 45_000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const targets = await browser.targets();
    const extensionTarget = targets.find((target) => {
      const url = target.url() || "";
      return url.startsWith("chrome-extension://");
    });

    if (extensionTarget) {
      const match = extensionTarget.url().match(/^chrome-extension:\/\/([^/]+)\//);
      if (match?.[1]) {
        return match[1];
      }
    }

    await wait(500);
  }

  throw new Error("Unable to derive extension ID from any extension target");
}

async function playFixtureIntoMic(page) {
  const audioBase64 = fs.readFileSync(fixturePath).toString("base64");

  await page.evaluate(async (wavBase64) => {
    // @ts-ignore
    const globalWindow = window;

    const toArrayBuffer = (base64) => {
      const binary = atob(base64);
      const length = binary.length;
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes.buffer;
    };

    const buffer = toArrayBuffer(wavBase64);
    const context =
      globalWindow.__MEEPER_E2E_AUDIO_CONTEXT__ || new AudioContext();
    const destination =
      globalWindow.__MEEPER_E2E_AUDIO_DESTINATION__ ||
      context.createMediaStreamDestination();

    globalWindow.__MEEPER_E2E_AUDIO_CONTEXT__ = context;
    globalWindow.__MEEPER_E2E_AUDIO_DESTINATION__ = destination;
    globalWindow.__MEEPER_E2E_AUDIO_STREAM_GETTER__ = () => destination.stream;

    if (context.state === "suspended") {
      await context.resume();
    }

    const decoded = await context.decodeAudioData(buffer.slice(0));
    const source = context.createBufferSource();
    source.buffer = decoded;
    source.connect(destination);

    source.start(0);

    await new Promise((resolve) => {
      source.onended = resolve;
    });
  }, audioBase64);
}

async function run() {
  assertPathExists(path.join(extensionPath, "manifest.json"), "Extension manifest");
  assertPathExists(fixturePath, "Audio fixture");
  assertPathExists(serverScriptPath, "faster-whisper test server script");

  const server = startServer();
  await waitForHealth(`http://${serverHost}:${serverPort}`);

  let browser;
  let audioBootstrapPage;
  let activeMeetTab;
  let recordPage;
  try {
    browser = await puppeteer.launch({
      headless: runHeadless ? "new" : false,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--use-fake-ui-for-media-stream",
        ...(usePulseAudio ? [] : ["--use-fake-device-for-media-stream"]),
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });

    const extensionId = await getExtensionId(browser);
    audioBootstrapPage = await browser.newPage();
    await installRecordPageHooks(audioBootstrapPage, serverBaseUrl, !usePulseAudio);
    await audioBootstrapPage.goto(`chrome-extension://${extensionId}/main.html#/welcome`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });

    if (!usePulseAudio) {
      await playFixtureIntoMic(audioBootstrapPage);
    }

    activeMeetTab = await browser.newPage();
    await activeMeetTab.goto(meetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    await activeMeetTab.bringToFront();
    await wait(500);

    const activeTabInfo = await activeMeetTab.evaluate(() => {
      return {
        href: location.href,
        title: document.title,
      };
    });

    if (!activeTabInfo.href.startsWith(meetUrlPrefix)) {
      throw new Error(
        `Active tab URL does not match Meet URL. Expected prefix ${meetUrlPrefix}, got ${activeTabInfo.href}`,
      );
    }

    const activeTabId = await resolveMeetTabIdFromExtensionPage(
      audioBootstrapPage,
      meetUrlPrefix,
    );

    recordPage = await browser.newPage();
    await installRecordPageHooks(recordPage, serverBaseUrl, !usePulseAudio);
    const recordErrors = [];
    recordPage.on("pageerror", (err) => {
      recordErrors.push(err?.message || String(err));
    });
    recordPage.on("console", (msg) => {
      if (msg.type() === "error") {
        console.error("[record-console-error]", msg.text());
      }
    });

    await recordPage.goto(
      `chrome-extension://${extensionId}/main.html#/record/${activeTabId}?recordType=mic-only`,
      {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      },
    );

    if (!usePulseAudio) {
      await playFixtureIntoMic(recordPage);
    }

    await waitForRecordPageReady(recordPage, recordRouteTimeoutMs);

    if (usePulseAudio) {
      console.log(`Using PulseAudio virtual mic (sink=${pulseSinkName})`);
      await playFixtureViaPulse();
    } else {
      console.log("Using in-page MediaStreamDestination fixture injection");
      await playFixtureIntoMic(recordPage);
    }

    await wait(1_500);

    await recordPage.evaluate(() => {
      if (typeof window.__MEEPER_E2E__?.stop === "function") {
        window.__MEEPER_E2E__.stop();
      }
    });

    await recordPage.waitForFunction(
      () => {
        const state = window.__MEEPER_E2E__?.state;
        return (
          Boolean(state) &&
          state.isActive === false &&
          state.pendingTranscriptions === 0 &&
          Array.isArray(state.content) &&
          state.content.length > 0
        );
      },
      {
        timeout: 40_000,
      },
    );

    const state = await recordPage.evaluate(() => {
      // @ts-ignore
      return window.__MEEPER_E2E__?.state || null;
    });

    if (recordErrors.length > 0) {
      throw new Error(`Record page runtime errors: ${recordErrors.join(" | ")}`);
    }

    if (state?.lastError) {
      throw new Error(`Recorder reported error: ${state.lastError}`);
    }

    const joined = (state?.content || []).join(" ");

    if (!hasExpectedTranscript(joined)) {
      throw new Error(
        `Transcription text missing expected words ${JSON.stringify(expectedWords)}: ${JSON.stringify(
          state?.content || [],
        )}`,
      );
    }

    console.log("E2E transcription passed:", state.content);

  } finally {
    if (recordPage) {
      await recordPage.close().catch(() => {});
    }

    if (audioBootstrapPage) {
      await audioBootstrapPage.close().catch(() => {});
    }

    if (activeMeetTab) {
      await activeMeetTab.close().catch(() => {});
    }

    if (browser) {
      await browser.close();
    }

    await stopServer(server);
  }
}

run().catch((err) => {
  console.error("E2E transcription test failed:", err);
  process.exit(1);
});
