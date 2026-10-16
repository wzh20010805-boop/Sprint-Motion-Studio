type Key<T> = Extract<keyof T, string>;
type Writer<T> = (key: Key<T>, value: unknown) => unknown | Promise<unknown>;

/** 只携带分组名，不把设置值或密钥放入错误文本。 */
export class SettingsWriteError extends Error {
  constructor(readonly completed: string[], readonly remaining: string[], readonly cause: unknown) {
    super(`SETTINGS_WRITE_INCOMPLETE: ${remaining.join(", ")}`);
  }
}

const copy = <T>(value: T): T => structuredClone(value);
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** 设置页的内存草稿历史；保存和撤销仅写显式注册的分组，不接触其他全局设置。 */
export class GroupedSettingsHistory<T extends object> {
  private value: T;
  private baseline: T;
  private persisted: Partial<Record<Key<T>, unknown>> = {};
  private entries: Array<{ before: T; rawBefore: Partial<Record<Key<T>, unknown>> }> = [];
  busy = false;

  constructor(initial: T, private readonly keys: readonly Key<T>[], private readonly encode: (key: Key<T>, value: T[Key<T>]) => unknown) {
    this.value = copy(initial);
    this.baseline = copy(initial);
  }

  get current(): T { return this.value; }
  get dirtyKeys(): Key<T>[] { return this.keys.filter(key => !equal(this.value[key], this.baseline[key])); }
  get dirty(): boolean { return this.dirtyKeys.length > 0; }
  get canUndo(): boolean { return this.entries.length > 0; }

  reset(value: T, persisted: Partial<Record<Key<T>, unknown>>) {
    if (this.busy) throw new Error("SETTINGS_BUSY");
    this.value = copy(value);
    this.baseline = copy(value);
    this.persisted = Object.fromEntries(this.keys.map(key => [key, copy(persisted[key] ?? null)])) as Partial<Record<Key<T>, unknown>>;
    this.entries = [];
  }

  edit<K extends Key<T>>(key: K, next: T[K] | ((previous: T[K]) => T[K])) {
    if (this.busy) throw new Error("SETTINGS_BUSY");
    const value = typeof next === "function" ? (next as (previous: T[K]) => T[K])(copy(this.value[key])) : next;
    if (equal(value, this.value[key])) return false;
    const rawBefore = equal(this.value[key], this.baseline[key]) ? { [key]: copy(this.persisted[key] ?? null) } : {};
    this.entries.push({ before: copy(this.value), rawBefore: rawBefore as Partial<Record<Key<T>, unknown>> });
    if (this.entries.length > 100) this.entries.shift();
    this.value = { ...this.value, [key]: copy(value) };
    return true;
  }

  private async write(target: T, keys: Key<T>[], payloads: Partial<Record<Key<T>, unknown>>, writer: Writer<T>) {
    const completed: Key<T>[] = [];
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!;
      try {
        if (await writer(key, copy(payloads[key])) === false) throw new Error("SETTINGS_WRITE_REJECTED");
        this.baseline = { ...this.baseline, [key]: copy(target[key]) };
        this.persisted[key] = copy(payloads[key]);
        completed.push(key);
      } catch (cause) {
        throw new SettingsWriteError(completed, keys.slice(index), cause);
      }
    }
    return completed;
  }

  async save(keys: readonly Key<T>[], writer: Writer<T>): Promise<Key<T>[]> {
    if (this.busy) throw new Error("SETTINGS_BUSY");
    this.busy = true;
    try {
      const dirty = this.dirtyKeys;
      const requested = this.keys.filter(key => keys.includes(key) && dirty.includes(key));
      // 全部校验先于第一次写入，避免后面的无效输入导致不必要的部分提交。
      const payloads = Object.fromEntries(requested.map(key => [key, this.encode(key, this.value[key])])) as Partial<Record<Key<T>, unknown>>;
      return await this.write(this.value, requested, payloads, writer);
    } finally { this.busy = false; }
  }

  async undo(writer: Writer<T>): Promise<boolean> {
    if (this.busy) throw new Error("SETTINGS_BUSY");
    const entry = this.entries.at(-1);
    if (!entry) return false;
    this.busy = true;
    try {
      // 未保存草稿仅恢复本地；已保存的修改必须先把旧配置真实写回。
      const keys = this.keys.filter(key => !equal(this.value[key], entry.before[key]) && equal(this.value[key], this.baseline[key]));
      const payloads = Object.fromEntries(keys.map(key => [key, Object.hasOwn(entry.rawBefore, key) ? entry.rawBefore[key] : this.encode(key, entry.before[key])])) as Partial<Record<Key<T>, unknown>>;
      await this.write(entry.before, keys, payloads, writer);
      this.value = copy(entry.before);
      this.entries.pop();
      return true;
    } finally { this.busy = false; }
  }
}
