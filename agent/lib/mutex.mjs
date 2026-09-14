/**
 * Resource-keyed in-process serialization.
 *
 * A read-then-write sequence is only race-free if nothing else can interleave
 * between the read and the write. A per-resource promise chain gives callers a
 * way to run a critical section exclusively for a given key WITHOUT a process-
 * wide lock, so unrelated keys keep running concurrently.
 *
 * This is the primitive behind audit A12: genesis "single-writer", updater
 * "concurrency lock", and consent approval all checked-then-wrote with awaits
 * in between, so two same-key callers could observe the same stale state. Each
 * of those now runs its read+write inside `mutex.run(key, ...)`, so exactly one
 * same-key caller wins and every caller observes the winner's state.
 *
 * Scope is a single process. It does not coordinate across processes (that
 * needs CAS at the file boundary, which genesis additionally does).
 */

export function createKeyedMutex() {
  // key -> the tail promise of the chain for that key. Each queued task awaits
  // the previous tail before starting, so same-key tasks run strictly one at a
  // time in submission order.
  const tails = new Map();

  /**
   * Run `fn` exclusively for `key`. Returns fn's result (or rethrows fn's
   * error) after running it exactly once, serialized against any other
   * same-key `run` calls.
   *
   * @param {string} key
   * @param {() => Promise<T> | T} fn
   * @returns {Promise<T>}
   */
  async function run(key, fn) {
    const prev = tails.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => gate);
    tails.set(key, tail);
    await prev; // our turn once every earlier same-key task has finished
    try {
      return await fn();
    } finally {
      release();
      // Remove ourselves only if we are still the tail; a newer task may have
      // already chained onto our tail and must stay queued.
      if (tails.get(key) === tail) tails.delete(key);
    }
  }

  return { run };
}