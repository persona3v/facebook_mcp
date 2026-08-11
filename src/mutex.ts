/**
 * Keyed async mutex. Work sharing a key runs one at a time; different keys run
 * concurrently. Used to serialize browser work per profile: one account cannot
 * launch Chrome twice against the same locked user data directory, and two tool
 * calls cannot drive the same page at once, while separate accounts stay parallel.
 */
const chains = new Map<string, Promise<void>>();

export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  // Run after the predecessor settles either way, so one failure does not wedge
  // every later caller on this key.
  const run = previous.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined
  );

  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) {
      chains.delete(key);
    }
  });

  return run;
}
