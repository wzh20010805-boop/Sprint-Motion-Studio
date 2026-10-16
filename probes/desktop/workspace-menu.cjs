const fs = require("node:fs");
const path = require("node:path");

function existingDirectory(directory) {
  if (typeof directory !== "string" || !directory.trim() || !path.isAbsolute(directory)) {
    throw new Error("工作区必须是已存在文件夹的绝对路径");
  }
  const resolved = fs.realpathSync(directory);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`工作区不是文件夹：${directory}`);
  return resolved;
}

function pathKey(directory) {
  return process.platform === "win32" ? directory.toLowerCase() : directory;
}

function cliData(reply) {
  if (reply?.ok !== true) {
    const error = new Error(reply?.error?.message || "工作区命令未返回有效结果");
    if (reply?.error?.code) error.code = reply.error.code;
    throw error;
  }
  return reply.data;
}

/** 菜单仅通过现有 CLI 打开窗口和登记选择；不接管当前服务的生命周期。 */
async function installWorkspaceMenu({ Menu, dialog, window, workspace, runCli, onSwitched = async () => {}, onError = () => {} }) {
  const currentWorkspace = existingDirectory(workspace);
  const currentKey = pathKey(currentWorkspace);
  let entries = [];
  try {
    const data = cliData(await runCli(["workspace", "list"]));
    if (!Array.isArray(data?.entries)) throw new Error("工作区列表未返回有效结果");
    entries = data.entries.flatMap(entry => {
      try {
        const directory = existingDirectory(entry.path);
        return [{ ...entry, path: directory }];
      } catch { return []; }
    });
  } catch (error) { await onError(error); }

  const registered = entries.find(entry => entry.registered && pathKey(entry.path) === currentKey);
  const currentName = registered?.name || path.basename(currentWorkspace);
  if (!entries.some(entry => pathKey(entry.path) === currentKey)) {
    entries.push({ name: currentName, path: currentWorkspace, registered: false });
  }
  let busy = false, menu;
  const choices = entries.map((entry, index) => ({
    id: `workspace-choice-${index}`,
    label: entry.name,
    type: "radio",
    checked: pathKey(entry.path) === currentKey,
    click: () => switchTo(entry.path),
  }));

  // Electron 会先勾选点击的 radio；旧窗口仍绑定原工作区，须立即恢复真实选择。
  function restoreSelection() {
    choices.forEach((choice, index) => {
      const checked = pathKey(entries[index].path) === currentKey;
      choice.checked = checked;
      const native = menu?.getMenuItemById(choice.id);
      if (native) native.checked = checked;
    });
  }

  async function openTarget(target) {
    const directory = existingDirectory(target);
    if (pathKey(directory) === currentKey) return { status: "unchanged", workspace: currentWorkspace };
    const gui = cliData(await runCli(["gui", "--workspace", directory]));
    cliData(await runCli(["workspace", "use", "--directory", directory]));
    await onSwitched(directory, gui);
    return { status: "opened", workspace: directory };
  }

  async function withBusy(action) {
    restoreSelection();
    if (busy) return { status: "busy" };
    busy = true;
    try { return await action(); }
    catch (error) { await onError(error); return { status: "failed" }; }
    finally { busy = false; restoreSelection(); }
  }

  function switchTo(target) {
    return withBusy(() => openTarget(target));
  }

  function chooseDirectory() {
    return withBusy(async () => {
      const selection = await dialog.showOpenDialog(window, {
        title: "选择工作区文件夹",
        defaultPath: currentWorkspace,
        properties: ["openDirectory"],
      });
      if (selection.canceled || !selection.filePaths?.length) return { status: "canceled" };
      return openTarget(selection.filePaths[0]);
    });
  }

  const template = [
    {
      label: "素材工坊",
      submenu: [
        { label: `当前工作区：${currentName}`, enabled: false },
        { label: currentWorkspace, enabled: false },
        { type: "separator" },
        {
          id: "switch-workspace",
          label: "切换工作区",
          submenu: [
            { label: "在新窗口打开，当前窗口和后台任务保留", enabled: false },
            { type: "separator" },
            ...choices,
            { type: "separator" },
            { id: "choose-workspace-directory", label: "选择其他工作区文件夹…", click: chooseDirectory },
          ],
        },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  window.setMenu(menu);
  window.setAutoHideMenuBar(false);
  window.setMenuBarVisibility(true);
  return { switchTo, chooseDirectory, template, menu, currentName, workspace: currentWorkspace };
}

module.exports = { installWorkspaceMenu };
