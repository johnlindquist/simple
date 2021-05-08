/* eslint-disable import/prefer-default-export */
import log from 'electron-log';
import { kenvPath } from './helpers';

export const consoleLog = log.create('consoleLog');
consoleLog.transports.file.resolvePath = () => kenvPath('logs', 'console.log');

const logMap = new Map<string, log.ElectronLog>();
export const getLog = (id: string) => {
  const normalizedId = id.replace(/.*\//g, '');

  if (logMap.get(normalizedId))
    return logMap.get(normalizedId) as log.ElectronLog;

  const scriptLog = log.create(normalizedId);
  scriptLog.transports.file.resolvePath = () =>
    kenvPath('logs', `${normalizedId}.log`);

  return scriptLog;
};