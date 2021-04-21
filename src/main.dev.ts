/* eslint-disable import/first */
/* eslint-disable jest/no-identical-title */
/* eslint-disable jest/expect-expect */
/* eslint global-require: off, no-console: off */

/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `yarn build` or `yarn build-main`, this file is compiled to
 * `./src/main.prod.js` using webpack. This gives us some performance wins.
 */

import { app, protocol, BrowserWindow, powerMonitor } from 'electron';
import queryString from 'query-string';
import clipboardy from 'clipboardy';

if (!app.requestSingleInstanceLock()) {
  app.exit();
}

import 'core-js/stable';
import 'regenerator-runtime/runtime';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import path from 'path';
import {
  spawnSync,
  exec,
  SpawnSyncOptions,
  SpawnSyncReturns,
} from 'child_process';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { chmod, readdir, readFile, rename, rmdir } from 'fs/promises';
import { Open } from 'unzipper';
import { createTray, destroyTray } from './tray';
import { manageShortcuts } from './shortcuts';
import { getAssetPath } from './assets';
import { tryKitScript } from './kit';
import { createPromptWindow, createPromptCache } from './prompt';
import {
  APP_NAME,
  kenvPath,
  KIT,
  KENV,
  KIT_PROTOCOL,
  kitPath,
} from './helpers';
import { getVersion } from './version';
import { show } from './show';
import { getRequiresSetup, setRequiresSetup } from './state';

let configWindow: BrowserWindow | null = null;

app.setName(APP_NAME);

app.setAsDefaultProtocolClient(KIT_PROTOCOL);
app.dock.hide();
app.dock.setIcon(getAssetPath('icon.png'));

powerMonitor.on('resume', () => {
  autoUpdater.checkForUpdatesAndNotify({
    title: 'Script Kit Updated',
    body: 'Relaunching...',
  });
});

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

if (
  process.env.NODE_ENV === 'development' ||
  process.env.DEBUG_PROD === 'true'
) {
  require('electron-debug')({ showDevTools: false });
}

const callBeforeQuitAndInstall = () => {
  try {
    destroyTray();
    app.removeAllListeners('window-all-closed');
    const browserWindows = BrowserWindow.getAllWindows();
    browserWindows.forEach((browserWindow) => {
      browserWindow.removeAllListeners('close');
    });
  } catch (e) {
    console.log(e);
  }
};

const installExtensions = async () => {
  const installer = require('electron-devtools-installer');
  const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
  const extensions = ['REACT_DEVELOPER_TOOLS'];

  return installer
    .default(
      extensions.map((name) => installer[name]),
      forceDownload
    )
    .catch(log.info);
};

autoUpdater.on('checking-for-update', () => {
  log.info('Checking for update...');
});
autoUpdater.on('update-available', (info) => {
  log.info('Update available.', info);
});
autoUpdater.on('update-not-available', (info) => {
  log.info('Update not available.', info);
});
autoUpdater.on('download-progress', (progressObj) => {
  let logMessage = `Download speed: ${progressObj.bytesPerSecond}`;
  logMessage = `${logMessage} - Downloaded ${progressObj.percent}%`;
  logMessage = `${logMessage} (${progressObj.transferred}/${progressObj.total})`;
  log.info(logMessage);
});

let updateDownloaded = false;
autoUpdater.on('update-downloaded', () => {
  log.info('update downloaded');
  log.info('attempting quitAndInstall');
  updateDownloaded = true;
  setRequiresSetup(true);
  callBeforeQuitAndInstall();
  autoUpdater.quitAndInstall();
  const allWindows = BrowserWindow.getAllWindows();
  allWindows.forEach((w) => {
    w?.destroy();
  });
  setTimeout(() => {
    log.info('quit and exit');
    app.quit();
    app.exit();
  }, 3000);
});

app.on('window-all-closed', (e: Event) => {
  if (!updateDownloaded) e.preventDefault();
});

app.on('web-contents-created', (_, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl);

    if (parsedUrl.protocol.startsWith('http')) {
      event.preventDefault();
      exec(`open ${parsedUrl.href}`);
    }
  });
});

const prepareProtocols = async () => {
  const PROTOCOL_START = `${KIT_PROTOCOL}://`;

  app.on('open-url', async (e, url) => {
    log.info(`URL PROTOCOL`, url);
    e.preventDefault();
    const [name, params] = url.slice(PROTOCOL_START.length).split('?');
    const argObject = queryString.parse(params);

    const args = Object.entries(argObject)
      .map(([key, value]) => `--${key} ${value}`)
      .join(' ')
      .split(' ');

    await tryKitScript(kitPath('cli/new.js'), [name, ...args]);
  });

  protocol.registerFileProtocol(KIT_PROTOCOL, (request, callback) => {
    const url = request.url.substr(KIT_PROTOCOL.length + 2);
    const file = { path: url };

    log.info(`fileProtocol loading:`, file);

    callback(file);
  });
};

const createLogs = () => {
  log.transports.file.resolvePath = () => kenvPath('logs', 'kit.log');
};

const createCaches = () => {
  createPromptCache();
};

const configWindowDone = () => {
  if (configWindow?.isVisible()) {
    configWindow?.webContents.send('UPDATE', {
      header: `Script Kit ${getVersion()}`,
      message: `
  <div class="flex flex-col justify-center items-center">
    <div><span class="font-bold"><kbd>cmd</kbd> <kbd>;</kbd></span> to launch main prompt (or click tray icon)</div>
    <div><span class="font-bold"><kbd>cmd</kbd> <kbd>shift</kbd><kbd>;</kbd></span> to launch cli prompt (or right-click tray icon)</div>
  </div>
  `.trim(),
    });
    configWindow?.on('blur', () => {
      if (!configWindow?.webContents?.isDevToolsOpened()) {
        configWindow?.destroy();
      }
    });
  } else {
    configWindow?.destroy();
  }
};

const updateConfigWindow = (message: string) => {
  if (configWindow?.isVisible()) {
    configWindow?.webContents.send('UPDATE', { message });
  }
};

const setupLog = (message: string) => {
  updateConfigWindow(message);
  log.info(message);
};

const ready = async () => {
  try {
    createLogs();
    createCaches();
    await prepareProtocols();
    setupLog(`Protocols Prepared`);
    await createTray();
    setupLog(`Tray created`);
    await manageShortcuts();
    setupLog(`Shortcuts Assigned`);
    await createPromptWindow();
    setupLog(`Prompt window created`);
    try {
      const tick = await import('./tick');
      setupLog(JSON.stringify({ tick }));
      setupLog(`Tick started`);
    } catch (error) {
      setupLog(error.message);
    }

    setupLog(`Kit.app is ready...`);
    configWindowDone();

    autoUpdater.logger = log;
    autoUpdater.checkForUpdatesAndNotify({
      title: 'Script Kit Updated',
      body: 'Relaunching...',
    });
  } catch (error) {
    log.warn(error);
  }
};

const handleSpawnReturns = async (
  message: string,
  result: SpawnSyncReturns<any>
) => {
  console.log(`HANDLE SPAWN RETURNS`);
  console.log(`stdout:`, result?.stdout?.toString());
  console.log(`stderr:`, result?.stderr?.toString());
  const { stdout, stderr, error } = result;

  if (stdout?.toString().length) {
    log.info(message, stdout.toString());
    updateConfigWindow(stdout.toString());
  }

  if (error) {
    throw new Error(error.message);
  }

  if (stderr?.toString().length) {
    console.log({ stderr: stderr.toString() });
    // throw new Error(stderr.toString());
  }

  return result;
};

const kitExists = () => {
  setupLog(KIT);
  const doesKitExist = existsSync(KIT);

  setupLog(`kit${doesKitExist ? `` : ` not`} found`);

  return doesKitExist;
};
const kitIsGit = () => {
  const isGit = existsSync(KENV);
  setupLog(`kit is${isGit ? ` not` : ``} a .git repo`);
  return isGit;
};
const kitNotTag = async () => {
  const HEADfile = await readFile(kitPath('.git', 'HEAD'), 'utf-8');
  setupLog(`HEAD: ${HEADfile}`);

  const isReleaseBranch = HEADfile.match(/alpha|beta|main/);

  setupLog(`.kit is${isReleaseBranch ? ` not` : ``} a release branch`);

  return isReleaseBranch;
};

const isContributor = async () => {
  // eslint-disable-next-line no-return-await
  return kitExists() && kitIsGit() && (await kitNotTag());
};

const kenvExists = () => {
  const doesKenvExist = existsSync(KENV);
  setupLog(`kenv${doesKenvExist ? `` : ` not`} found`);

  return doesKenvExist;
};

const verifyInstall = async () => {
  setupLog(`Verifying ~/.kit exists:`);
  const kitE = kitExists();
  setupLog(`Verifying ~/.kenv exists:`);
  const kenvE = kenvExists();

  const nodeExists = await existsSync(kitPath('node', 'bin', 'node'));
  setupLog(nodeExists ? `node found` : `node missing`);

  const nodeModulesExist = await existsSync(kitPath('node_modules'));
  setupLog(nodeModulesExist ? `node_modules found` : `node_modules missing`);

  if (kitE && kenvE && nodeExists && nodeModulesExist) {
    // throw new Error(`Couldn't verify install.`);
    setupLog(`Install verified`);
    return true;
  }

  setupLog(`Couldn't verify both dirs exist...`);
  return false;
};

const ohNo = async (error: Error) => {
  log.warn(error.message);
  log.warn(error.stack);
  const mainLog = await readFile(
    path.join(homedir(), `Library/Logs/Kit/main.log`),
    {
      encoding: 'utf8',
    }
  );

  await clipboardy.write(
    `
${error.message}
${error.stack}
${mainLog}
  `.trim()
  );
  configWindow?.destroy();

  const showWindow = await show(
    'install-error',
    `
  <body class="p-1 h-screen w-screen flex flex-col">
  <h1>Kit failed to install</h1>
  <div>Please share the logs below (already copied to clipboard): </div>
  <div class="italic">Note: Kit exits when you close this window</div>
  <div><a href="https://github.com/johnlindquist/kit/discussions/categories/errors">https://github.com/johnlindquist/kit/discussions/categories/errors</a></div>

  <h2>Error: ${error.message}</h2>

  <textarea class="font-mono w-full h-full text-xs">${mainLog}</textarea>
  </body>
  `
  );

  showWindow?.on('close', () => {
    app.exit();
  });

  showWindow?.on('blur', () => {
    app.exit();
  });

  throw new Error(error.message);
};

const options: SpawnSyncOptions = {
  cwd: KIT,
  encoding: 'utf-8',
  env: {
    KIT,
    KENV,
    PATH: `${path.join(KIT, 'node', 'bin')}:${process.env.PATH}`,
  },
};

const unzipToHome = async (zipFile: string, outDir: string) => {
  const tmpDir = path.join(app.getPath('home'), '.kit-install-tmp');
  const file = await Open.file(zipFile);
  await file.extract({ path: tmpDir, concurrency: 5 });

  const [zipDir] = await readdir(tmpDir);
  const targetDir = path.join(path.join(app.getPath('home'), outDir));

  setupLog(`Renaming ${zipDir} to ${targetDir}`);

  await rename(path.join(tmpDir, zipDir), targetDir);

  await rmdir(tmpDir);
};

const checkKit = async () => {
  if (getRequiresSetup()) {
    configWindow = await show(
      'splash-setup',
      `
  <body class="h-screen w-screen flex flex-col justify-evenly items-center dark:bg-gray-800 dark:text-white">
    <h1 class="header pt-4">Configuring ~/.kit and ~/.kenv...</h1>
    <img src="${getAssetPath('icon.png')}" class="w-20"/>
    <div class="message pb-4"></div>
  </body>
  `,
      { frame: false },
      false
    );

    configWindow?.show();

    if (!(await isContributor())) {
      if (kitExists()) {
        setupLog(`Rm'ing previous .kit`);
        await rmdir(KIT, { recursive: true });
      }
      const kitZip = getAssetPath('kit.zip');
      setupLog(`.kit doesn't exist or isn't on a contributor branch`);

      await unzipToHome(kitZip, '.kit');

      if (kitExists()) {
        setupLog(`Adding node to ~/.kit...`);
        const installScript = `./install-node.sh`;
        await chmod(kitPath(installScript), 0o755);
        const nodeInstallResult = spawnSync(
          installScript,
          ` --prefix node --platform darwin`.split(' '),
          options
        );
        await handleSpawnReturns(`npm`, nodeInstallResult);

        setupLog(`adding ~/.kit packages...`);
        const npmResult = spawnSync(`npm`, [`i`], options);
        await handleSpawnReturns(`npm`, npmResult);
      }
    } else {
      setupLog(`Welcome fellow contributor! Thanks for all you do!!!`);
    }

    if (!kenvExists()) {
      // Step 4: Use kit wrapper to run setup.js script
      configWindow?.show();
      const kenvZip = getAssetPath('kenv.zip');
      await unzipToHome(kenvZip, '.kenv');

      kenvExists();

      if (kenvExists()) {
        setupLog(`Run .kenv setup script...`);

        spawnSync(`./script`, [`./setup/setup.js`], options);
      }
    }

    await verifyInstall();
  }

  setRequiresSetup(false);
  await ready();
};

app.whenReady().then(checkKit).catch(ohNo);
