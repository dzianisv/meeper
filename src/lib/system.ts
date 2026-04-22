export async function retry<T>(
  action: () => Promise<T>,
  delay = 100,
  retries = 10
): Promise<T> {
  try {
    return await action();
  } catch (err) {
    if (retries > 0) {
      await new Promise((r) => setTimeout(r, delay));
      return retry(action, delay, retries - 1);
    }

    throw err;
  }
}

// It simply doesn't allow the provided function to be executed in parallel.
export function promiseQueue() {
  let worker: Promise<unknown> = Promise.resolve();

  return <T>(factory: () => Promise<T>) => {
    const task = worker.then(factory, factory);
    worker = task.then(
      () => undefined,
      () => undefined,
    );

    return task;
  };
}

export function createPendingOperationsTracker() {
  let pendingCount = 0;
  const waiters = new Set<() => void>();

  const notifyIfIdle = () => {
    if (pendingCount !== 0) {
      return;
    }

    waiters.forEach((resolve) => resolve());
    waiters.clear();
  };

  return {
    begin() {
      pendingCount += 1;
      let ended = false;

      return () => {
        if (ended) {
          return;
        }

        ended = true;
        pendingCount = Math.max(0, pendingCount - 1);
        notifyIfIdle();
      };
    },

    waitForIdle() {
      if (pendingCount === 0) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve) => {
        waiters.add(resolve);
      });
    },

    getPendingCount() {
      return pendingCount;
    },
  };
}

export function pick<T, K extends keyof T>(obj: T, ...keys: K[]): Pick<T, K> {
  const ret: any = {};
  keys.forEach((key) => {
    ret[key] = obj[key];
  });
  return ret;
}
