// firefox browser.* uses promises and throws if you pass a callback arg.
// chrome.* wants callbacks (or promises in mv3). handle both so neither cries.

const ff: any = (globalThis as any).browser;
const cr: any = (globalThis as any).chrome;
const isFF = typeof ff !== 'undefined' && typeof ff?.runtime?.sendMessage === 'function';

export const browserApi = {
  runtime: {
    sendMessage<M = any, R = any>(msg: M): Promise<R | undefined> {
      if (isFF) {
        try {
          if (!ff?.runtime?.id) return Promise.resolve(undefined);
          return Promise.resolve(ff.runtime.sendMessage(msg)).catch(() => undefined);
        } catch {
          return Promise.resolve(undefined);
        }
      }

      return new Promise((resolve) => {
        try {
          if (!cr?.runtime?.id) return resolve(undefined);
          cr.runtime.sendMessage(msg, (res: R) => {
            void cr.runtime.lastError;
            resolve(res);
          });
        } catch {
          resolve(undefined);
        }
      });
    },

    onMessage: {
      addListener(
        cb: (
          msg: any,
          sender: chrome.runtime.MessageSender,
          sendResponse: (res?: any) => void
        ) => boolean | void | Promise<any>
      ) {
        (isFF ? ff : cr)?.runtime?.onMessage?.addListener(cb);
      },
    },
  },

  tabs: {
    sendMessage<M = any, R = any>(
      tabId: number,
      msg: M,
      opts?: chrome.tabs.MessageSendOptions
    ): Promise<R | undefined> {
      if (isFF) {
        try {
          const p = opts
            ? ff.tabs.sendMessage(tabId, msg, opts)
            : ff.tabs.sendMessage(tabId, msg);
          return Promise.resolve(p).catch(() => undefined);
        } catch {
          return Promise.resolve(undefined);
        }
      }

      return new Promise((resolve) => {
        try {
          const done = (res: R) => {
            void cr.runtime.lastError;
            resolve(res);
          };
          if (opts) cr.tabs.sendMessage(tabId, msg, opts, done);
          else cr.tabs.sendMessage(tabId, msg, done);
        } catch {
          resolve(undefined);
        }
      });
    },

    onRemoved: {
      addListener(cb: (tabId: number) => void) {
        (isFF ? ff : cr)?.tabs?.onRemoved?.addListener(cb);
      },
    },
  },

  action: {
    onClicked: {
      addListener(cb: (tab: chrome.tabs.Tab) => void) {
        (isFF ? ff : cr)?.action?.onClicked?.addListener(cb);
      },
    },
  },

  scripting: {
    executeScript(tabId: number, files: string[]): Promise<void> {
      const api = isFF ? ff : cr;
      try {
        const res = api?.scripting?.executeScript?.({
          target: { tabId, allFrames: true },
          files,
        });
        return Promise.resolve(res)
          .then(() => undefined)
          .catch(() => undefined);
      } catch {
        return Promise.resolve();
      }
    },
  },

  storage: {
    local: {
      get<T = Record<string, any>>(keys: string | string[]): Promise<T> {
        if (isFF) {
          try {
            return Promise.resolve(ff.storage.local.get(keys))
              .then((items) => (items ?? {}) as T)
              .catch(() => ({} as T));
          } catch {
            return Promise.resolve({} as T);
          }
        }

        return new Promise((resolve) => {
          try {
            cr.storage.local.get(keys, (items: Record<string, any>) => {
              void cr.runtime.lastError;
              resolve((items ?? {}) as T);
            });
          } catch {
            resolve({} as T);
          }
        });
      },

      set(items: Record<string, any>): Promise<void> {
        if (isFF) {
          try {
            return Promise.resolve(ff.storage.local.set(items))
              .then(() => undefined)
              .catch(() => undefined);
          } catch {
            return Promise.resolve();
          }
        }

        return new Promise((resolve) => {
          try {
            cr.storage.local.set(items, () => {
              void cr.runtime.lastError;
              resolve();
            });
          } catch {
            resolve();
          }
        });
      },
    },
  },
};
