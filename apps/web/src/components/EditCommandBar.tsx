import { Save, Undo2 } from "lucide-react";
import { runEditingCommand, useEditingCommandState } from "../editingCommands";
import { useT } from "../i18n";

export default function EditCommandBar({ compact = false, modalOnly = false }: { compact?: boolean; modalOnly?: boolean }) {
  const t = useT();
  const state = useEditingCommandState();
  if (modalOnly && !state.modal) return null;
  const status = state.busy ? "editing.saving" : state.result === "failed" ? "editing.failed" : state.dirty ? "editing.unsaved" : state.result === "saved" ? "editing.saved" : state.autoSave ? "editing.autoSave" : "editing.noPending";
  return <div className={`edit-command-bar ${modalOnly ? "edit-command-dock pixel-panel" : ""}`} aria-label={t("editing.controls")}>
    <button type="button" className="px-btn" data-edit-save disabled={!state.canSave || state.busy} title={t("editing.saveHint", { name: state.label })} onClick={() => void runEditingCommand("save")}><Save size={14}/>{t("editing.save")}</button>
    <button type="button" className="px-btn" data-edit-undo disabled={!state.canUndo || state.busy} title={t("editing.undoHint", { name: state.label })} onClick={() => void runEditingCommand("undo")}><Undo2 size={14}/>{t("timeline.undo")}</button>
    {!compact && state.label && <small role="status">{t(status)}</small>}
  </div>;
}
