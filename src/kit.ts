/* eslint-disable @typescript-eslint/naming-convention */
/* eslint-disable no-case-declarations */
/* eslint-disable @typescript-eslint/no-use-before-define */
import { app, clipboard, ipcMain, screen } from 'electron';
import { autoUpdater } from 'electron-updater';
import url from 'url';
import http from 'http';
import https from 'https';
import sizeOf from 'image-size';
import minimist from 'minimist';

import path from 'path';
import { fork, ChildProcess } from 'child_process';
import log from 'electron-log';
import { isUndefined } from 'lodash';
import ipc from 'node-ipc';
import {
  focusPrompt,
  getPromptCache,
  hideEmitter,
  hidePromptWindow,
  sendToPrompt,
  setBlurredByKit,
  showPrompt,
  resizePrompt,
  escapePromptWindow,
} from './prompt';
import { consoleLog, getLog } from './logs';
import { showNotification } from './notifications';
import { show } from './show';
import {
  kitPath,
  kenvPath,
  KIT,
  KENV,
  execPath,
  NODE_PATH,
  PATH,
  DOTENV_CONFIG_PATH,
  KIT_MAC_APP,
} from './helpers';
import { makeRestartNecessary } from './state';
import { getVersion } from './version';
import {
  CHOICE_FOCUSED,
  GENERATE_CHOICES,
  RESET_PROMPT,
  RUN_SCRIPT,
  SET_CHOICES,
  SET_HINT,
  SET_IGNORE_BLUR,
  SET_INPUT,
  SET_MODE,
  SET_PANEL,
  SET_PLACEHOLDER,
  SET_TAB_INDEX,
  SHOW_PROMPT,
  TAB_CHANGED,
  VALUE_SUBMITTED,
  CONTENT_SIZE_UPDATED,
  ESCAPE_PRESSED,
} from './channels';
import { serverState, startServer, stopServer } from './server';
import { MODE } from './enums';
import { emitter, EVENT } from './events';
import { getSchedule } from './schedule';
import { getBackgroundTasks, toggleBackground } from './background';

const APP_SCRIPT_TIMEOUT = 10000;

let child: ChildProcess | null = null;
let appHidden = false;

let kitScriptName = '';
export const processMap = new Map();

const setPlaceholder = (text: string) => {
  if (!appHidden) sendToPrompt(SET_PLACEHOLDER, text);
};

const setChoices = (data: any) => sendToPrompt(SET_CHOICES, data);

let values: any[] = [];
ipcMain.on(VALUE_SUBMITTED, (_event, { value }) => {
  emitter.emit(EVENT.RESUME_SHORTCUTS);
  values = [...values, value];
  if (child) {
    child?.send({ channel: VALUE_SUBMITTED, value });
  }
});

ipcMain.on(GENERATE_CHOICES, (_event, input) => {
  if (child && !isUndefined(input)) {
    child?.send({ channel: GENERATE_CHOICES, input });
  }
});

ipcMain.on('PROMPT_ERROR', (_event, error: Error) => {
  log.warn(error);
  if (!appHidden) setPlaceholder(error.message);
});

ipcMain.on(CHOICE_FOCUSED, (_event, choice: any) => {
  // TODO: Think through "live selecting" choices
  // child?.send({ channel: CHOICE_FOCUSED, choice });
});

ipcMain.on(TAB_CHANGED, (event, { tab, input = '' }) => {
  emitter.emit(EVENT.RESUME_SHORTCUTS);
  if (child && tab) {
    child?.send({ channel: TAB_CHANGED, tab, input });
  }
});

ipcMain.on(CONTENT_SIZE_UPDATED, (event, size) => {
  if (!isUndefined(size)) {
    resizePrompt(size);
  }
});

ipcMain.on(ESCAPE_PRESSED, (event) => {
  reset();
  escapePromptWindow();
});

const reset = () => {
  values = [];
  emitter.emit(EVENT.RESUME_SHORTCUTS);
  sendToPrompt(RESET_PROMPT, { kitScript: kitScriptName });
  if (child) {
    log.info(`> end process ${kitScriptName} - id: ${child.pid} <\n`);
    processMap.delete(child?.pid);
    child?.removeAllListeners();
    child?.kill();
    child = null;
  }
  appHidden = false;
};

// TODO: Work out states
// Closed by user
// Closed by script
// Closed by need to copy/paste
hideEmitter.on('hide', () => {
  if (appHidden) {
    appHidden = false;
  } else {
    reset();
    hidePromptWindow();
  }
});

app.on('second-instance', async (event, argv, workingDirectory) => {
  const { _ } = minimist(argv);
  const [, , argScript, ...argArgs] = _;
  await tryKitScript(argScript, argArgs);
});

ipc.config.id = KIT;
ipc.config.retry = 1500;
ipc.config.silent = true;

ipc.serve(kitPath('tmp', 'ipc'), () => {
  ipc.server.on('message', async (argv, socket) => {
    log.info(`ipc message:`, argv);
    const { _ } = minimist(argv);
    const [, , argScript, ...argArgs] = _;
    await tryKitScript(argScript, argArgs);
  });
});

ipc.server.start();

process.on('unhandledRejection', (reason, p) => {
  log.warn('Unhandled Rejection at: Promise', p, 'reason:', reason);

  // application specific logging, throwing an error, or other logic here
});

process.on('uncaughtException', (error) => {
  log.warn(error);
});

export const appScript = async (scriptPath: string, runArgs: string[]) => {
  log.info(`> start app process: ${scriptPath}`);
  const appScriptChild = fork(scriptPath, [...runArgs], {
    silent: true,
    // stdio: 'inherit',
    execPath,
    execArgv: ['--require', 'dotenv/config', '--require', KIT_MAC_APP],
    env: {
      ...process.env,
      KIT_CONTEXT: 'app',
      KIT_MAIN: scriptPath,
      PATH,
      KENV,
      KIT,
      NODE_PATH,
      DOTENV_CONFIG_PATH,
      KIT_APP_VERSION: getVersion(),
    },
  });

  const id = setTimeout(() => {
    log.info(
      `> app process: ${scriptPath} took > ${
        APP_SCRIPT_TIMEOUT / 1000
      } seconds. Ending...`
    );
    appScriptChild?.kill();
  }, APP_SCRIPT_TIMEOUT);

  appScriptChild?.on('message', (data: any) => {
    switch (data?.channel) {
      case 'CONSOLE_LOG':
        consoleLog.info(data.log);
        break;
      default:
        consoleLog.info(
          `appScriptChild: Unknown message ${data.channel} from ${data?.kitScript}`
        );
    }
  });

  appScriptChild?.on('exit', () => {
    if (id) clearTimeout(id);
    log.info(`> end app process: ${scriptPath}`);
  });
};

const kitScript = (
  scriptPath: string,
  runArgs: string[] = [],
  resolve: any,
  reject: any
) => {
  kitScriptName = scriptPath;
  reset();
  // eslint-disable-next-line no-nested-ternary
  let resolvePath = scriptPath.startsWith(path.sep)
    ? scriptPath
    : scriptPath.includes(path.sep)
    ? kenvPath(scriptPath)
    : kenvPath('scripts', scriptPath);

  if (!resolvePath.endsWith('.js')) resolvePath = `${resolvePath}.js`;

  child = fork(resolvePath, [...runArgs, '--app'], {
    silent: true,
    // stdio: 'inherit',
    execPath,
    execArgv: ['--require', 'dotenv/config', '--require', KIT_MAC_APP],
    env: {
      ...process.env,
      KIT_CONTEXT: 'app',
      KIT_MAIN: resolvePath,
      PATH,
      KENV,
      KIT,
      NODE_PATH,
      DOTENV_CONFIG_PATH,
      KIT_APP_VERSION: getVersion(),
    },
  });
  processMap.set(child.pid, scriptPath);

  log.info(`\n> begin process ${kitScriptName} id: ${child.pid} <`);

  const tryClean = (on: string) => () => {
    try {
      resolve(values);
      reset();
      hidePromptWindow();
    } catch (error) {
      log.warn(error);
    }
  };

  child.on('exit', tryClean('EXIT'));
  child.on('message', async (data: any) => {
    log.info(`${data?.channel} ${data?.kitScript}`);

    // TODO: Refactor into something better than this :D
    switch (data.channel) {
      case '__FORCE_UPDATE':
        console.log(`__FORCE_UPDATE`);
        break;
      case 'CLEAR_CACHE':
        getPromptCache()?.clear();
        break;

      case 'CONSOLE_LOG':
        getLog(data.kitScript).info(data.log);
        break;

      case 'CONSOLE_WARN':
        getLog(data.kitScript).warn(data.log);
        break;

      case 'COPY_PATH_AS_PICTURE':
        clipboard.writeImage(data?.path);
        break;

      case 'GET_SCRIPTS_STATE':
        child?.send({
          channel: 'SCRIPTS_STATE',
          schedule: getSchedule(),
          tasks: getBackgroundTasks(),
        });

        break;

      case 'GET_SCHEDULE':
        child?.send({ channel: 'SCHEDULE', schedule: getSchedule() });
        break;

      case 'GET_BACKGROUND':
        child?.send({ channel: 'BACKGROUND', tasks: getBackgroundTasks() });
        break;

      case 'TOGGLE_BACKGROUND':
        toggleBackground(data?.filePath);
        break;

      case 'GET_SCREEN_INFO':
        const cursor = screen.getCursorScreenPoint();
        // Get display with cursor
        const activeScreen = screen.getDisplayNearestPoint({
          x: cursor.x,
          y: cursor.y,
        });

        child?.send({ channel: 'SCREEN_INFO', activeScreen });
        break;

      case 'GET_MOUSE':
        const mouseCursor = screen.getCursorScreenPoint();

        child?.send({ channel: 'MOUSE', mouseCursor });
        break;

      case 'GET_SERVER_STATE':
        child?.send({ channel: 'SERVER', ...serverState });
        break;

      case 'HIDE_APP':
        appHidden = true;
        app?.hide();
        break;

      case 'NEEDS_RESTART':
        makeRestartNecessary();
        break;

      case 'QUIT_APP':
        reset();
        app.exit();
        break;

      case RUN_SCRIPT:
        log.info(`\n>> run ${data?.name} ${data?.args.join(' ')}`);
        sendToPrompt(RUN_SCRIPT, data);
        break;

      case 'SEND_RESPONSE':
        resolve(data);
        break;

      case 'SET_LOGIN':
        app.setLoginItemSettings(data);
        break;

      case SET_MODE:
        if (data.mode === MODE.HOTKEY) {
          emitter.emit(EVENT.PAUSE_SHORTCUTS);
        }
        sendToPrompt(SET_MODE, data);
        break;

      case SET_HINT:
        sendToPrompt(SET_HINT, data);
        break;

      case SET_IGNORE_BLUR:
        setBlurredByKit(data?.ignore);
        break;

      case SET_INPUT:
        sendToPrompt(SET_INPUT, data);
        break;

      case SET_PLACEHOLDER:
        showPrompt();
        sendToPrompt(SET_PLACEHOLDER, data);
        break;

      case SET_PANEL:
        sendToPrompt(SET_PANEL, data);
        break;

      case SET_TAB_INDEX:
        sendToPrompt(SET_TAB_INDEX, data);
        break;

      case 'SHOW_TEXT':
        setBlurredByKit();

        show(
          String.raw`<div class="text-xs font-mono">${data.text}</div>`,
          data.options
        );

        break;

      case 'SHOW_IMAGE':
        setBlurredByKit();

        const { image, options } = data;
        const imgOptions = url.parse(image.src);

        // eslint-disable-next-line promise/param-names
        const { width, height } = await new Promise(
          (resolveImage, rejectImage) => {
            const proto = imgOptions.protocol?.startsWith('https')
              ? https
              : http;
            proto.get(imgOptions, (response) => {
              const chunks: any = [];
              response
                .on('data', (chunk) => {
                  chunks.push(chunk);
                })
                .on('end', () => {
                  const buffer = Buffer.concat(chunks);
                  resolveImage(sizeOf(buffer));
                });
            });
          }
        );

        const imageWindow = await show(
          data?.kitScript || 'show-image',
          String.raw`<img src="${image?.src}" alt="${image?.alt}" title="${image?.title}" />`,
          { width, height, ...options }
        );
        if (imageWindow && !imageWindow.isDestroyed()) {
          imageWindow.on('close', () => {
            focusPrompt();
          });
        }
        break;

      case 'SHOW_NOTIFICATION':
        setBlurredByKit();

        showNotification(data.html, data.options);
        break;

      case SHOW_PROMPT:
        showPrompt(data);
        if (data?.choices) {
          // validate choices
          if (
            data?.choices.every(
              ({ name, value }: any) =>
                !isUndefined(name) && !isUndefined(value)
            )
          ) {
            sendToPrompt(SHOW_PROMPT, data);
          } else {
            log.warn(`Choices must have "name" and "value"`);
            log.warn(data?.choices);
            if (!appHidden)
              setPlaceholder(
                `Warning: arg choices must have "name" and "value"`
              );
          }
        } else {
          sendToPrompt(SHOW_PROMPT, data);
        }

        break;

      case 'SHOW':
        setBlurredByKit();
        const showWindow = await show('show', data.html, data.options);
        if (showWindow && !showWindow.isDestroyed()) {
          showWindow.on('close', () => {
            focusPrompt();
          });
        }
        break;

      case 'START_SERVER':
        startServer(data.host, parseInt(data.port, 10), tryKitScript);
        break;

      case 'STOP_SERVER':
        stopServer();
        break;

      case 'UPDATE_APP':
        autoUpdater.checkForUpdatesAndNotify({
          title: 'Script Kit Updated',
          body: 'Relaunching...',
        });

        break;

      case SET_CHOICES:
        setChoices(data);
        break;

      case 'UPDATE_PROMPT_WARN':
        setPlaceholder(data?.info);
        break;

      default:
        log.info(`kit.ts: Unknown message ${data.channel}`);
    }
  });

  child.on('error', (error) => {
    reject(error);
    reset();
    hidePromptWindow();
  });

  (child as any).stdout.on('data', (data: string) => {
    const line = data?.toString();
    log.info(line);
  });
};

export const tryKitScript = async (
  filePath: string,
  runArgs: string[] = []
) => {
  log.info(
    `
*** ${filePath} ${runArgs} ***`.trim()
  );
  try {
    return new Promise((resolve, reject) => {
      kitScript(filePath, runArgs, resolve, reject);
    });
  } catch (error) {
    log.error(error);
    return Promise.resolve(error);
  }
};

emitter.on(EVENT.RUN_APP_SCRIPT, async (filePath) => {
  await appScript(filePath, []);
});
