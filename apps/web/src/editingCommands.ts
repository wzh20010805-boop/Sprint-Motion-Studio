import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { EditingCommandStore, type EditCommand, type EditCommandTarget } from "./editingCommandStore";
import { notify } from "./notice";
import { t } from "./i18n";

export const editingCommands = new EditingCommandStore();
export interface EditingCommands extends Omit<EditCommandTarget, "available"> {
  scope?: RefObject<HTMLElement | null>;
}

function visible(element: HTMLElement) {
  return !!element.getClientRects().length && getComputedStyle(element).visibility !== "hidden";
}

function dialogLayer(element: HTMLElement) {
  let layer = 0;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    layer = Math.max(layer, Number.parseInt(getComputedStyle(node).zIndex) || 0);
  }
  return layer;
}

function available(commands: EditingCommands) {
  const scope = commands.scope?.current;
  if (commands.scope && (!scope || !visible(scope))) return false;
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('.modal-mask, [role="dialog"], [aria-modal="true"]')).filter(visible).sort((a, b) => dialogLayer(a) - dialogLayer(b));
  // 嵌套弹窗只允许最上层工作台接管；未知弹窗也不能触发背后的项目撤销。
  const dialog = dialogs.at(-1);
  return !dialog || !!scope && (dialog === scope || dialog.contains(scope) || scope.matches('.modal-mask, [role="dialog"]') && scope.contains(dialog));
}

export async function runEditingCommand(command: EditCommand) {
  try {
    const done = await editingCommands.execute(command);
    if (done) notify(t(command === "save" ? "editing.saved" : "editing.undone"), "info");
    return done;
  } catch (error) {
    const message = (error as Error).message;
    notify(t(command === "save" ? "editing.saveFailed" : "editing.undoFailed", {
      msg: message === "EDIT_COMMAND_INCOMPLETE" ? t("editing.incomplete") : message,
    }));
    return false;
  }
}

let users = 0;
let observer: MutationObserver | undefined;
function keydown(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.repeat || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
  const key = event.key.toLowerCase();
  if (key !== "s" && key !== "z") return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (key === "z" && (target?.isContentEditable || target?.closest('input, textarea, select, [contenteditable], [role="slider"], [role="spinbutton"], [role="combobox"]'))) return;
  if (Array.from(document.querySelectorAll<HTMLElement>(".px-select.open")).some(visible)) return;
  editingCommands.refresh();
  const state = editingCommands.getSnapshot();
  if (!editingCommands.allowsShortcut(key === "s" ? "save" : "undo")) return;
  // Ctrl+S 始终屏蔽网页“另存为”；不可用上下文不显示虚假的保存成功。
  if (key === "s" || state.canUndo) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!state.busy) void runEditingCommand(key === "s" ? "save" : "undo");
  }
}

/** 工作台注册自己的真实持久化与撤销行为，隐藏页面不会争抢快捷键。 */
export function useEditingCommands(commands: EditingCommands) {
  const latest = useRef(commands);
  latest.current = commands;
  useEffect(() => {
    const unregister = editingCommands.register(() => ({ ...latest.current,
      modal: !!latest.current.scope?.current?.closest('.modal-mask, [role="dialog"], [aria-modal="true"]'),
      available: () => available(latest.current) }));
    if (users++ === 0) {
      window.addEventListener("keydown", keydown, true);
      observer = new MutationObserver(editingCommands.refresh);
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class", "hidden", "aria-modal", "role"] });
    }
    return () => {
      unregister();
      if (--users === 0) { window.removeEventListener("keydown", keydown, true); observer?.disconnect(); observer = undefined; }
    };
  }, []);
  useLayoutEffect(editingCommands.refresh);
}

export function useEditingCommandState() {
  return useSyncExternalStore(editingCommands.subscribe, editingCommands.getSnapshot, editingCommands.getSnapshot);
}
