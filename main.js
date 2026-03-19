const { app, BrowserWindow } = require("electron");
const path = require("path");
const http = require("http");
const expressApp = require("./server");

const PORT = 3000;
let mainWindow;

// Icon path — works both in dev and when packaged
const iconPath = app.isPackaged
  ? path.join(process.resourcesPath, "app", "public", "icon.ico")
  : path.join(__dirname, "public", "icon.ico");

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(expressApp);
    server.on("error", reject);
    server.listen(PORT, "127.0.0.1", () => {
      console.log("Express ready on port " + PORT);
      resolve();
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Dibujandola Toda",
    backgroundColor: "#0f1012",
    icon: iconPath,  // taskbar + window icon
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL("http://localhost:" + PORT);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // Set dock icon on macOS
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(iconPath);
  }

  try {
    await startServer();
    createWindow();
  } catch (err) {
    console.error("Failed to start server:", err);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
