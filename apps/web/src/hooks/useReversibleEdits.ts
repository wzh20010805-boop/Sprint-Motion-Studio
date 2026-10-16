import { useRef, useState } from "react";

/** 轻量元数据操作的逆向命令；图片、审核与后台任务不进入此历史。 */
export function useReversibleEdits() {
  const actions = useRef<Array<() => Promise<void>>>([]);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const record = (undo: () => Promise<void>) => {
    actions.current = [...actions.current.slice(-49), undo];
    setCount(actions.current.length);
  };
  const undo = async () => {
    if (busyRef.current || !actions.current.length) return false;
    busyRef.current = true; setBusy(true);
    const action = actions.current.at(-1)!;
    try {
      await action();
      // 撤销失败时保留历史；撤销期间新记录不误删。
      const index = actions.current.lastIndexOf(action);
      if (index >= 0) actions.current.splice(index, 1);
      setCount(actions.current.length);
      return true;
    } finally { busyRef.current = false; setBusy(false); }
  };
  return { record, undo, canUndo: count > 0, busy };
}
