const { app } = require("electron");
app.on("browser-window-created", (_event, window) => {
  window.webContents.capturePage = async () => { throw new Error("CAPTURE_UNAVAILABLE_TEST"); };
});
require("../../probes/desktop/main.cjs");
