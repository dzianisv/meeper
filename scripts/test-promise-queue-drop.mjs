#!/usr/bin/env node

import { promiseQueue } from "../src/lib/system.ts";

process.removeAllListeners("warning");

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
