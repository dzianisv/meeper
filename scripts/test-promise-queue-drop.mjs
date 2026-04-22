#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadPromiseQueue() {
  const systemFilePath = path.resolve(__dirname, "../src/lib/system.ts");
  const source = fs.readFileSync(systemFilePath, "utf8");

  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: systemFilePath,
  }).outputText;

  const localModule = { exports: {} };
  const context = vm.createContext({
    module: localModule,
    exports: localModule.exports,
    require,
    console,
    setTimeout,
    clearTimeout,
    Promise,
  });

  new vm.Script(transpiled, { filename: "system.js" }).runInContext(context);

  if (typeof localModule.exports.promiseQueue !== "function") {
    throw new Error("Failed to load promiseQueue from src/lib/system.ts");
  }

  return localModule.exports.promiseQueue;
}

const promiseQueue = loadPromiseQueue();

const queue = promiseQueue();
let completed = 0;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const first = queue(async () => {
  await wait(80);
  completed += 1;
  return "first";
});

const second = queue(async () => {
  completed += 1;
  return "second";
});

await first;
const secondResult = await second;

if (secondResult !== "second") {
  throw new Error(`Expected second queue task to run, got: ${String(secondResult)}`);
}

if (completed !== 2) {
  throw new Error(`Expected both queue tasks to complete, got ${completed}`);
}

console.log("promiseQueue processes queued tasks sequentially");
