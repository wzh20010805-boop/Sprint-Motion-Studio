export type EditCommand = "save" | "undo";

export interface EditCommandTarget {
  label: string;
  priority?: number;
  enabled?: boolean;
  available?: () => boolean;
  save?: () => unknown | Promise<unknown>;
  undo?: () => unknown | Promise<unknown>;
  canSave?: boolean;
  canUndo?: boolean;
  busy?: boolean;
  dirty?: boolean;
  allowShortcut?: (command: EditCommand) => boolean;
  modal?: boolean;
  autoSave?: boolean;
}

export interface EditCommandSnapshot {
  label: string;
  priority: number;
  canSave: boolean;
  canUndo: boolean;
  busy: boolean;
  dirty: boolean;
  result: "idle" | "saved" | "undone" | "failed";
  modal: boolean;
  autoSave: boolean;
}

/** 只向当前工作台分发命令，不恢复整个数据库或后台任务。 */
export class EditingCommandStore {
  private targets = new Map<symbol, () => EditCommandTarget>();
  private listeners = new Set<() => void>();
  private running = false;
  private result: EditCommandSnapshot["result"] = "idle";
  private owner: symbol | undefined;
  private snapshot: EditCommandSnapshot = { label: "", priority: -1, canSave: false, canUndo: false, busy: false, dirty: false, result: "idle", modal: false, autoSave: false };

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  allowsShortcut = (command: EditCommand) => this.active()?.target.allowShortcut?.(command) !== false;

  register(target: () => EditCommandTarget) {
    const id = Symbol();
    this.targets.set(id, target);
    this.refresh();
    return () => { this.targets.delete(id); this.refresh(); };
  }

  private active() {
    let choice: { id: symbol; target: EditCommandTarget } | undefined;
    for (const [id, read] of this.targets) {
      const target = read();
      if (target.enabled === false || target.available?.() === false) continue;
      if (!choice || (target.priority ?? 10) >= (choice.target.priority ?? 10)) choice = { id, target };
    }
    return choice;
  }

  refresh = () => {
    const active = this.active();
    if (this.owner !== active?.id) { this.owner = active?.id; this.result = "idle"; }
    const target = active?.target;
    const next: EditCommandSnapshot = {
      label: target?.label ?? "", priority: target?.priority ?? -1,
      canSave: !!target?.save && target.canSave !== false,
      canUndo: !!target?.undo && target.canUndo !== false,
      busy: this.running || !!target?.busy, dirty: !!target?.dirty, result: this.result, modal: !!target?.modal, autoSave: !!target?.autoSave,
    };
    if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  };

  async execute(command: EditCommand): Promise<boolean> {
    const active = this.active();
    if (!active || this.running || active.target.busy) return false;
    const action = active.target[command];
    if (!action || active.target[command === "save" ? "canSave" : "canUndo"] === false) return false;
    this.running = true;
    this.result = "idle";
    this.refresh();
    try {
      const result = await action();
      if (result === false) throw new Error("EDIT_COMMAND_INCOMPLETE");
      // 操作期间若切换了页面，不把旧页面的保存结果显示到新页面。
      if (this.active()?.id === active.id) this.result = command === "save" ? "saved" : "undone";
      return true;
    } catch (error) {
      if (this.active()?.id === active.id) this.result = "failed";
      throw error;
    } finally {
      this.running = false;
      this.refresh();
    }
  }
}
