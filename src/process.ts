/* eslint-disable no-nested-ternary */
/* eslint-disable @typescript-eslint/no-use-before-define */
/* eslint-disable import/prefer-default-export */
import log from 'electron-log';
import { app, clipboard, screen } from 'electron';
import http from 'http';
import https from 'https';
import url from 'url';
import sizeOf from 'image-size';
import path from 'path';

import { isUndefined } from 'lodash';
import { autoUpdater } from 'electron-updater';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { ChildProcess, fork } from 'child_process';
import { getLog } from './logs';
import {
  focusPrompt,
  setBlurredByKit,
  setIgnoreBlur,
  setPlaceholder,
  showPrompt,
  setScript,
  setMode,
  setInput,
  setPanel,
  setHint,
  setTabIndex,
  setPromptData,
  setChoices,
  clearPromptCache,
} from './prompt';
import { setAppHidden } from './appHidden';
import {
  makeRestartNecessary,
  serverState,
  getBackgroundTasks,
  getSchedule,
} from './state';

import { emitter, KitEvent } from './events';
import { Channel, Mode, ProcessType } from './enums';
import { show } from './show';
import { showNotification } from './notifications';
import {
  setKenv,
  createKenv,
  kenvPath,
  KIT_MAC_APP,
  KIT_MAC_APP_PROMPT,
  PATH,
  execPath,
  KIT,
  getKenv,
  getKenvDotEnv,
} from './helpers';
import { Choice, MessageData, Script, PromptData } from './types';
import { getVersion } from './version';

export const prepChoices = (data: MessageData) => {
  if (data?.scripts) {
    const dataChoices: Script[] = (data?.choices || []) as Script[];
    const choices = dataChoices.map((script) => {
      if (script.background) {
        const backgroundScript = getBackgroundTasks().find(
          (t) => t.filePath === script.filePath
        );

        script.description = `${script.description || ''}${
          backgroundScript
            ? `🟢  Uptime: ${formatDistanceToNowStrict(
                new Date(backgroundScript.process.start)
              )} PID: ${backgroundScript.process.pid}`
            : "🛑 isn't running"
        }`;
      }

      if (script.schedule) {
        const scheduleScript = getSchedule().find(
          (s) => s.filePath === script.filePath
        );

        if (scheduleScript) {
          const date = new Date(scheduleScript.date);
          const next = `Next ${formatDistanceToNowStrict(date)}`;
          const cal = `${format(date, 'MMM eo, h:mm:ssa ')}`;

          script.description = `${
            script.description || ``
          } ${next} - ${cal} - ${script.schedule}`;
        }
      }

      if (script.watch) {
        script.description = `${script.description || ``} Watching: ${
          script.watch
        }`;
      }

      return script;
    });

    data.choices = choices as Choice[];
  }

  setChoices(data.choices as Choice[]);
};

export type ChannelHandler = {
  [key in Channel]?: (data: MessageData) => void;
};

const SHOW_IMAGE = async (data: MessageData) => {
  setBlurredByKit();

  const { image, options } = data;
  const imgOptions = url.parse(image.src);

  // eslint-disable-next-line promise/param-names
  const { width, height } = await new Promise((resolveImage, rejectImage) => {
    const proto = imgOptions.protocol?.startsWith('https') ? https : http;
    proto.get(imgOptions, (response: any) => {
      const chunks: any = [];
      response
        .on('data', (chunk: any) => {
          chunks.push(chunk);
        })
        .on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolveImage(sizeOf(buffer));
        });
    });
  });

  const imageWindow = await show(
    data?.script?.command || 'show-image',
    String.raw`<img src="${image?.src}" alt="${image?.alt}" title="${image?.title}" />`,
    { width, height, ...options }
  );
  if (imageWindow && !imageWindow.isDestroyed()) {
    imageWindow.on('close', () => {
      focusPrompt();
    });
  }
};

const kitMessageMap: ChannelHandler = {
  CONSOLE_LOG: (data) => {
    getLog(data.kitScript).info(data.log);
  },

  CONSOLE_WARN: (data) => {
    getLog(data.kitScript).warn(data.warn);
  },

  COPY_PATH_AS_PICTURE: (data) => {
    clipboard.writeImage(data.path as any);
  },

  CREATE_KENV: (data) => {
    if (data.kenvPath) createKenv(data.kenvPath);
  },

  GET_SCRIPTS_STATE: (data) => {
    processes.ifPid(data.pid, ({ child }) => {
      child?.send({
        channel: 'SCRIPTS_STATE',
        schedule: getSchedule(),
        tasks: getBackgroundTasks(),
      });
    });
  },

  GET_SCHEDULE: (data) => {
    processes.ifPid(data.pid, ({ child }) => {
      child?.send({ channel: 'SCHEDULE', schedule: getSchedule() });
    });
  },

  GET_BACKGROUND: (data) => {
    processes.ifPid(data.pid, ({ child }) => {
      child?.send({ channel: 'BACKGROUND', tasks: getBackgroundTasks() });
    });
  },

  TOGGLE_BACKGROUND: (data) => {
    emitter.emit(KitEvent.ToggleBackground, data);
  },

  GET_SCREEN_INFO: (data) => {
    processes.ifPid(data.pid, ({ child }) => {
      const cursor = screen.getCursorScreenPoint();
      // Get display with cursor
      const activeScreen = screen.getDisplayNearestPoint({
        x: cursor.x,
        y: cursor.y,
      });

      child?.send({ channel: 'SCREEN_INFO', activeScreen });
    });
  },

  GET_MOUSE: (data) => {
    processes.ifPid(data.pid, ({ child }) => {
      const mouseCursor = screen.getCursorScreenPoint();
      child?.send({ channel: 'MOUSE', mouseCursor });
    });
  },
  GET_SERVER_STATE: (data) => {
    processes.ifPid(data.pid, ({ child }) => {
      child?.send({ channel: 'SERVER', ...serverState });
    });
  },
  HIDE_APP: () => {
    setAppHidden(true);
  },
  NEEDS_RESTART: () => {
    makeRestartNecessary();
  },
  QUIT_APP: () => {
    app.exit();
  },
  SET_SCRIPT: (data) => {
    processes.ifPid(data.pid, ({ type }) => {
      log.info(`🏘 SET_SCRIPT ${type} ${data.pid}`, data.script);
      if (type === ProcessType.Prompt) {
        setScript(data.script as Script);
      }
    });
  },

  SET_LOGIN: (data) => {
    app.setLoginItemSettings(data);
  },
  SET_MODE: (data) => {
    if (data.mode === Mode.HOTKEY) {
      emitter.emit(KitEvent.PauseShortcuts);
    }
    setMode(data.mode as Mode);
  },

  SET_HINT: (data) => {
    setHint(data.hint as string);
  },

  SET_IGNORE_BLUR: (data) => {
    setIgnoreBlur(data?.ignore);
  },

  SET_INPUT: (data) => {
    setInput(data.input as string);
  },

  SET_PLACEHOLDER: (data) => {
    setPlaceholder(data.text as string);
    processes.ifPid(data.pid, () => {
      showPrompt();
    });
  },

  SET_PANEL: (data) => {
    setPanel(data.html as string);
  },
  SET_TAB_INDEX: (data) => {
    setTabIndex(data.tabIndex as number);
  },
  SHOW_TEXT: (data) => {
    setBlurredByKit();

    show(
      String.raw`<div class="text-xs font-mono">${data.text}</div>`,
      data.options
    );
  },
  SHOW_NOTIFICATION: (data) => {
    setBlurredByKit();

    showNotification(data.html || 'You forgot html', data.options);
  },
  SET_PROMPT_DATA: (data) => {
    setPromptData(data as PromptData);
  },
  SHOW_IMAGE,
  SHOW: async (data) => {
    setBlurredByKit();
    const showWindow = await show(
      'show',
      data.html || 'You forgot html',
      data.options
    );
    if (showWindow && !showWindow.isDestroyed()) {
      showWindow.on('close', () => {
        focusPrompt();
      });
    }
  },
  UPDATE_APP: () => {
    autoUpdater.checkForUpdatesAndNotify({
      title: 'Script Kit Updated',
      body: 'Relaunching...',
    });
  },
  SET_CHOICES: (data) => {
    prepChoices(data);
  },
  SWITCH_KENV: (data) => {
    if (data.kenvPath) setKenv(data.kenvPath);
  },
  UPDATE_PROMPT_WARN: (data) => {
    setPlaceholder(data.info as string);
  },
  CLEAR_PROMPT_CACHE: () => {
    clearPromptCache();
  },
};

export const createMessageHandler =
  (type: ProcessType) => (data: MessageData) => {
    if (!data.kitScript) log.info(data);
    log.info(
      `${data.channel} ${type} process ${data.kitScript.replace(
        /.*\//gi,
        ''
      )} id: ${data.pid}`
    );

    if (kitMessageMap[data?.channel]) {
      const channelFn = kitMessageMap[data.channel] as (data: any) => void;
      channelFn(data);
    } else {
      console.warn(`Channel ${data?.channel} not found on ${type}.`);
    }
  };

export interface ProcessInfo {
  pid: number;
  scriptPath: string;
  child: ChildProcess;
  type: ProcessType;
  values: any[];
  date: Date;
}

interface CreateChildInfo {
  type: ProcessType;
  scriptPath?: string;
  runArgs?: string[];
  resolve?: (data: any) => void;
  reject?: (error: any) => void;
}

const DEFAULT_TIMEOUT = 15000;

const createChild = ({
  type,
  scriptPath = 'kit',
  runArgs = [],
}: CreateChildInfo) => {
  let args = [];
  if (!scriptPath) {
    args = ['--app'];
  } else {
    let resolvePath = scriptPath.startsWith(path.sep)
      ? scriptPath
      : scriptPath.includes(path.sep)
      ? kenvPath(scriptPath)
      : kenvPath('scripts', scriptPath);

    if (!resolvePath.endsWith('.js')) resolvePath = `${resolvePath}.js`;
    args = [resolvePath, ...runArgs, '--app'];
  }

  const entry = type === ProcessType.Prompt ? KIT_MAC_APP_PROMPT : KIT_MAC_APP;
  const child = fork(entry, args, {
    silent: false,
    // stdio: 'inherit',
    execPath,
    env: {
      ...process.env,
      KIT_CONTEXT: 'app',
      KIT_MAIN: scriptPath,
      PATH,
      KENV: getKenv(),
      KIT,
      KIT_DOTENV: getKenvDotEnv(),
      KIT_APP_VERSION: getVersion(),
      PROCESS_TYPE: type,
    },
  });

  return child;
};

/* eslint-disable import/prefer-default-export */

interface ProcessHandlers {
  onExit?: () => void;
  onError?: (error: Error) => void;
  onMessage?: (data: MessageData) => void;
  resolve?: (values: any[]) => any;
  reject?: (value: any) => any;
}

class Processes extends Array<ProcessInfo> {
  public endPreviousPromptProcess() {
    const previousPromptProcess = this.find(
      (info) => info.type === ProcessType.Prompt && info.scriptPath
    );

    if (previousPromptProcess) {
      this.removeByPid(previousPromptProcess.pid);
    }
  }

  public getAllProcessInfo() {
    return this.map(({ scriptPath, type, pid }) => ({
      type,
      scriptPath,
      pid,
    }));
  }

  public add(
    type: ProcessType,
    scriptPath = '',
    args: string[] = [],
    { resolve, reject }: ProcessHandlers = {}
  ) {
    const child = createChild({
      type,
      scriptPath,
      runArgs: args,
    });

    this.push({
      pid: child.pid,
      child,
      type,
      scriptPath,
      values: [],
      date: new Date(),
    });

    log.info(`🟢 start ${type} process: ${scriptPath} id: ${child.pid}`);

    const id =
      ![ProcessType.Background, ProcessType.Prompt].includes(type) &&
      setTimeout(() => {
        log.info(
          `> ${type} process: ${scriptPath} took > ${DEFAULT_TIMEOUT} seconds. Ending...`
        );
        child?.kill();
      }, DEFAULT_TIMEOUT);

    child?.on('message', createMessageHandler(type));

    const { pid } = child;
    child.on('exit', () => {
      if (id) clearTimeout(id);
      if (type === ProcessType.Prompt) {
        setAppHidden(false);
        emitter.emit(KitEvent.ExitPrompt);
        emitter.emit(KitEvent.ResumeShortcuts);
      }

      const { values } = processes.getByPid(pid) as ProcessInfo;
      if (resolve) {
        resolve(values);
      }
      log.info(`🟡 end ${type} process: ${scriptPath} id: ${child.pid}`);
      processes.removeByPid(pid);
    });

    child.on('error', (error) => {
      if (reject) reject(error);
    });

    return child;
  }

  public findPromptProcess() {
    const promptProcess = this.find(
      (processInfo) => processInfo.type === ProcessType.Prompt
    );
    if (promptProcess) return promptProcess;

    throw new Error(`☠️ Can't find Prompt Process`);
  }

  public getByPid(pid: number) {
    return this.find((processInfo) => processInfo.pid === pid);
  }

  public removeByPid(pid: number) {
    const processInfo = this.find((info) => info.pid === pid);

    if (processInfo) {
      const { child, type, scriptPath } = processInfo;
      if (child) {
        child?.removeAllListeners();
        child?.kill();
        log.info(`🛑 kill ${type} process: ${scriptPath} id: ${child.pid}`);
      }
      this.splice(
        this.findIndex((info) => info.pid === pid),
        1
      );
    }
  }

  public ifPid(pid: number, callback: (info: ProcessInfo) => void) {
    const processInfo = this.getByPid(pid);
    if (processInfo) {
      callback(processInfo);
    } else {
      log.warn(`⚠️ Can't find ${pid}`);
    }
  }

  public assignScriptToProcess(
    scriptPath: ProcessInfo['scriptPath'],
    pid: number
  ) {
    const index = this.findIndex((processInfo) => processInfo.pid === pid);
    if (index !== -1) {
      this[index] = { ...this[index], scriptPath };
    } else {
      log.warn(`⚠️ pid ${pid} not found. Can't run`, scriptPath);
    }
  }
}

export const processes = new Processes();