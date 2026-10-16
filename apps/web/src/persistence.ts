const pending = new Map<Promise<unknown>, { key: string; version: number }>();
const failures = new Map<string, { error: Error; retry: () => Promise<unknown>; retryOnFlush: boolean }>();
const versions = new Map<string, number>();

/** 记录实际写请求；上层即使显示错误并吞掉 reject，保存仍不能谎报成功。 */
export function trackPersistence<T>(key: string, write: () => Promise<T>, retainFailure = true, retryOnFlush = true): Promise<T> {
  const version = (versions.get(key) ?? 0) + 1;
  versions.set(key, version);
  const promise = write().then(value => { if (versions.get(key) === version) failures.delete(key); return value; }, error => {
    if (retainFailure && versions.get(key) === version) failures.set(key, { error: error instanceof Error ? error : new Error(String(error)), retry: write, retryOnFlush });
    throw error;
  });
  pending.set(promise, { key, version });
  void promise.finally(() => pending.delete(promise)).catch(() => {});
  return promise;
}

export async function flushPersistence(owns: (key: string) => boolean = () => true): Promise<void> {
  for (;;) {
    const writes = [...pending].filter(([, item]) => owns(item.key) && versions.get(item.key) === item.version).map(([promise]) => promise);
    if (!writes.length) break;
    await Promise.allSettled(writes);
  }
  // 自动保存失败时，明确的“保存”会重试本上下文的原写入；只有真正写入才清错误。
  const retries = [...failures].filter(([key, failure]) => owns(key) && failure.retryOnFlush);
  await Promise.allSettled(retries.map(([key, failure]) => trackPersistence(key, failure.retry)));
  for (const [key, failure] of failures) {
    if (owns(key)) throw failure.error;
  }
}

/** 对象已明确删除或编辑已明确放弃时，才能移除对应的待重试写入。 */
export function discardPersistence(owns: (key: string) => boolean) {
  for (const [key, version] of versions) {
    if (!owns(key)) continue;
    versions.set(key, version + 1);
    failures.delete(key);
  }
}
