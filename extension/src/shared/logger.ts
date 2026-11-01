const isTopFrame = typeof window !== 'undefined' && window === window.top;
const frameTag =
  typeof window === 'undefined'
    ? 'BG'
    : isTopFrame
    ? 'TOP'
    : 'FRAME';

export const logger = {
  info(component: string, message: string, ...args: unknown[]) {
    console.log(`[SyncParty:${frameTag}:${component}] ${message}`, ...args);
  },
  warn(component: string, message: string, ...args: unknown[]) {
    console.warn(`[SyncParty:${frameTag}:${component}] ${message}`, ...args);
  },
  error(component: string, message: string, ...args: unknown[]) {
    console.error(`[SyncParty:${frameTag}:${component}] ${message}`, ...args);
  },
};
