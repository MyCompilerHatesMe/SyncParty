import { browserApi } from '../shared/browserApi';
import {
  BackgroundToContentMessage,
  ContentToBackgroundMessage,
  TabSyncState,
} from '../shared/messages';
import {
  ClientToServerMessage,
  HostMediaInfo,
  ServerToClientMessage,
  SyncActionPayload,
} from '../shared/protocol';

const DEFAULT_URL = 'ws://localhost:8080';
const KEEPALIVE_MS = 20_000;

interface TabSession {
  tabId: number;
  ws: WebSocket | null;
  keepAliveTimer: ReturnType<typeof setInterval> | null;
  onOpenCb: (() => void) | null;
  lockedOnPageUrl: string;
  state: TabSyncState;
}

const sessions = new Map<number, TabSession>();

function makeState(serverUrl = DEFAULT_URL): TabSyncState {
  return {
    connectionStatus: 'disconnected',
    serverUrl,
    roomId: null,
    clientId: null,
    nickname: `peer-${Math.floor(100 + Math.random() * 900)}`,
    isHost: false,
    participants: [],
    hostMedia: null,
    pageUrl: '',
    pageTitle: '',
    videoLocked: false,
    activeVideoFrameId: null,
    videoMetadata: null,
    pickerActive: false,
    lastError: null,
    lastSyncNotification: null,
  };
}

function getSession(tabId: number): TabSession {
  let s = sessions.get(tabId);
  if (!s) {
    s = {
      tabId,
      ws: null,
      keepAliveTimer: null,
      onOpenCb: null,
      lockedOnPageUrl: '',
      state: makeState(),
    };
    sessions.set(tabId, s);
  }
  return s;
}

function getLocalMedia(s: TabSession): HostMediaInfo {
  return {
    url: s.state.pageUrl || s.state.videoMetadata?.frameUrl || '',
    title: s.state.pageTitle || '',
    duration: s.state.videoMetadata?.duration ?? 0,
  };
}

function pushHostMediaIfHost(s: TabSession) {
  if (!s.state.isHost || !s.state.roomId) return;
  const media = getLocalMedia(s);
  s.state.hostMedia = media;
  sendWs(s, { action: 'UPDATE_MEDIA', media });
}

function syncUI(s: TabSession) {
  const msg: BackgroundToContentMessage = {
    type: 'STATE_UPDATED',
    state: s.state,
  };
  browserApi.tabs.sendMessage(s.tabId, msg, { frameId: 0 });
}

function sendToVideoFrame(s: TabSession, senderNickname: string, payload: SyncActionPayload) {
  const msg: BackgroundToContentMessage = {
    type: 'INBOUND_SYNC_COMMAND',
    senderNickname,
    payload,
  };

  if (s.state.activeVideoFrameId !== null) {
    browserApi.tabs.sendMessage(s.tabId, msg, { frameId: s.state.activeVideoFrameId });
  } else {
    browserApi.tabs.sendMessage(s.tabId, msg);
  }
}

function sendWs(s: TabSession, msg: ClientToServerMessage) {
  if (s.ws && s.ws.readyState === WebSocket.OPEN) {
    s.ws.send(JSON.stringify(msg));
  }
}

function killWs(s: TabSession) {
  if (s.keepAliveTimer) {
    clearInterval(s.keepAliveTimer);
    s.keepAliveTimer = null;
  }
  if (s.ws) {
    try {
      s.ws.onclose = null;
      s.ws.onerror = null;
      s.ws.onmessage = null;
      s.ws.close();
    } catch {}
    s.ws = null;
  }
  s.state.connectionStatus = 'disconnected';
  s.state.roomId = null;
  s.state.isHost = false;
  s.state.participants = [];
  s.state.hostMedia = null;
}

function swapLoopback(url: string): string | null {
  if (url.includes('://localhost')) return url.replace('://localhost', '://127.0.0.1');
  if (url.includes('://127.0.0.1')) return url.replace('://127.0.0.1', '://localhost');
  return null;
}

function connectWs(s: TabSession, onOpen: () => void, retried = false) {
  if (s.ws && s.ws.readyState === WebSocket.OPEN) {
    onOpen();
    return;
  }

  killWs(s);

  s.state.connectionStatus = 'connecting';
  s.state.lastError = null;
  s.onOpenCb = onOpen;
  syncUI(s);

  let ws: WebSocket;
  try {
    ws = new WebSocket(s.state.serverUrl);
  } catch (err) {
    s.state.connectionStatus = 'error';
    s.state.lastError = err instanceof Error ? err.message : 'bad ws url';
    syncUI(s);
    return;
  }

  s.ws = ws;
  let opened = false;

  ws.onopen = () => {
    opened = true;
    s.state.connectionStatus = 'connected';
    s.state.lastError = null;

    s.keepAliveTimer = setInterval(() => {
      sendWs(s, { action: 'PING' });
    }, KEEPALIVE_MS);

    if (s.onOpenCb) {
      const fn = s.onOpenCb;
      s.onOpenCb = null;
      fn();
    }
    syncUI(s);
  };

  ws.onmessage = (ev) => {
    let msg: ServerToClientMessage;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }

    switch (msg.event) {
      case 'CONNECTED':
        s.state.clientId = msg.clientId;
        syncUI(s);
        break;

      case 'ROOM_CREATED':
        s.state.roomId = msg.roomId;
        s.state.clientId = msg.clientId;
        s.state.isHost = true;
        s.state.participants = msg.participants;
        s.state.hostMedia = msg.state.hostMedia ?? getLocalMedia(s);
        s.state.lastError = null;
        s.state.lastSyncNotification = `room ${msg.roomId} created`;
        syncUI(s);
        break;

      case 'ROOM_JOINED':
        s.state.roomId = msg.roomId;
        s.state.clientId = msg.clientId;
        s.state.isHost = msg.state.hostId === msg.clientId;
        s.state.participants = msg.participants;
        s.state.hostMedia = msg.state.hostMedia ?? null;
        s.state.lastError = null;
        s.state.lastSyncNotification = `joined ${msg.roomId}`;
        syncUI(s);

        sendToVideoFrame(s, 'room', {
          type: msg.state.isPlaying ? 'PLAY' : 'PAUSE',
          time: msg.state.currentTime,
          playbackRate: msg.state.playbackRate,
          hostTimestamp: msg.state.lastUpdatedTimestamp,
        });
        break;

      case 'ROOM_UPDATED': {
        const wasHost = s.state.isHost;
        s.state.participants = msg.participants;
        s.state.isHost = msg.hostId === s.state.clientId;
        if (msg.hostMedia) {
          s.state.hostMedia = msg.hostMedia;
        }
        // if host left and we just got promoted to host, broadcast our media info
        if (!wasHost && s.state.isHost) {
          pushHostMediaIfHost(s);
        }
        syncUI(s);
        break;
      }

      case 'SYNC_ACTION': {
        const { senderNickname, payload } = msg;
        if (payload.type !== 'HEARTBEAT') {
          s.state.lastSyncNotification = `${senderNickname}: ${payload.type.toLowerCase()} (${fmtTime(payload.time)})`;
          syncUI(s);
        }
        sendToVideoFrame(s, senderNickname, payload);
        break;
      }

      case 'REQUEST_HOST_STATE': {
        if (!s.state.isHost) break;
        const queryMsg: BackgroundToContentMessage = { type: 'QUERY_LIVE_VIDEO_STATE' };
        const frameOpts =
          s.state.activeVideoFrameId !== null
            ? { frameId: s.state.activeVideoFrameId }
            : undefined;
        browserApi.tabs
          .sendMessage<BackgroundToContentMessage, { ok?: boolean; currentTime?: number; isPlaying?: boolean }>(
            s.tabId,
            queryMsg,
            frameOpts
          )
          .then((res) => {
            const time = res?.ok && typeof res.currentTime === 'number'
              ? res.currentTime
              : (s.state.videoMetadata?.currentTime ?? 0);
            const playing = res?.ok && typeof res.isPlaying === 'boolean'
              ? res.isPlaying
              : (s.state.videoMetadata?.isPlaying ?? false);

            sendWs(s, {
              action: 'SYNC_ACTION',
              payload: {
                type: playing ? 'PLAY' : 'PAUSE',
                time,
                playbackRate: 1.0,
                hostTimestamp: Date.now(),
                forceSeek: true,
              },
            });
          });
        break;
      }

      case 'ROOM_LEFT':
        s.state.roomId = null;
        s.state.isHost = false;
        s.state.participants = [];
        s.state.hostMedia = null;
        s.state.lastSyncNotification = 'left room';
        syncUI(s);
        break;

      case 'ERROR':
        s.state.lastError = msg.message;
        syncUI(s);
        break;

      case 'PONG':
        break;
    }
  };

  ws.onerror = () => {
    if (!opened && !retried) {
      const alt = swapLoopback(s.state.serverUrl);
      if (alt) {
        const cb = s.onOpenCb ?? onOpen;
        s.state.serverUrl = alt;
        connectWs(s, cb, true);
        return;
      }
    }

    s.state.connectionStatus = 'error';
    s.state.lastError = `can't reach ${s.state.serverUrl}`;
    syncUI(s);
  };

  ws.onclose = () => {
    if (s.keepAliveTimer) {
      clearInterval(s.keepAliveTimer);
      s.keepAliveTimer = null;
    }
    if (s.ws === ws) {
      s.ws = null;
      if (s.state.connectionStatus !== 'error') {
        s.state.connectionStatus = 'disconnected';
      }
      s.state.roomId = null;
      s.state.isHost = false;
      s.state.participants = [];
      s.state.hostMedia = null;
      syncUI(s);
    }
  };
}

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '00:00';
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

browserApi.runtime.onMessage.addListener(
  (
    msg: ContentToBackgroundMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (res?: any) => void
  ) => {
    const tabId = sender.tab?.id;
    const frameId = sender.frameId ?? 0;

    if (tabId === undefined) {
      sendResponse({ ok: false });
      return false;
    }

    const s = getSession(tabId);

    // keep top-frame url & title fresh; if tab navigated to a new page, clear old page's video lock
    if (frameId === 0) {
      const nextUrl = ('pageUrl' in msg && msg.pageUrl) ? msg.pageUrl : (sender.tab?.url || '');
      if (nextUrl && s.state.pageUrl && nextUrl !== s.state.pageUrl) {
        s.state.videoLocked = false;
        s.state.activeVideoFrameId = null;
        s.state.videoMetadata = null;
      }
      if (nextUrl) s.state.pageUrl = nextUrl;

      if ('pageTitle' in msg && msg.pageTitle !== undefined) s.state.pageTitle = msg.pageTitle;
      else if (sender.tab?.title) s.state.pageTitle = sender.tab.title;
    } else if (!s.state.pageUrl && sender.tab?.url) {
      s.state.pageUrl = sender.tab.url;
      if (sender.tab?.title) s.state.pageTitle = sender.tab.title;
    }

    switch (msg.type) {
      case 'UI_GET_STATE':
        sendResponse({ state: s.state });
        return false;

      case 'UI_UPDATE_SERVER_URL':
        if (msg.serverUrl?.trim()) {
          s.state.serverUrl = msg.serverUrl.trim();
          syncUI(s);
        }
        sendResponse({ state: s.state });
        return false;

      case 'UI_CREATE_ROOM':
        if (msg.nickname?.trim()) s.state.nickname = msg.nickname.trim().slice(0, 24);
        if (msg.serverUrl?.trim()) s.state.serverUrl = msg.serverUrl.trim();

        connectWs(s, () => {
          sendWs(s, {
            action: 'CREATE_ROOM',
            nickname: s.state.nickname,
            initialState: {
              currentTime: s.state.videoMetadata?.currentTime ?? 0,
              isPlaying: s.state.videoMetadata?.isPlaying ?? false,
              hostMedia: getLocalMedia(s),
            },
          });
        });
        sendResponse({ ok: true });
        return false;

      case 'UI_JOIN_ROOM': {
        const code = msg.roomId?.trim().toUpperCase();
        if (!code) {
          s.state.lastError = 'enter a room code';
          syncUI(s);
          sendResponse({ ok: false });
          return false;
        }
        if (msg.nickname?.trim()) s.state.nickname = msg.nickname.trim().slice(0, 24);
        if (msg.serverUrl?.trim()) s.state.serverUrl = msg.serverUrl.trim();

        connectWs(s, () => {
          sendWs(s, {
            action: 'JOIN_ROOM',
            roomId: code,
            nickname: s.state.nickname,
          });
        });
        sendResponse({ ok: true });
        return false;
      }

      case 'UI_LEAVE_ROOM':
        if (s.ws && s.ws.readyState === WebSocket.OPEN) {
          sendWs(s, { action: 'LEAVE_ROOM' });
        }
        killWs(s);
        syncUI(s);
        sendResponse({ ok: true });
        return false;

      case 'UI_REQUEST_RESYNC':
        if (s.state.roomId && s.ws && s.ws.readyState === WebSocket.OPEN) {
          s.state.lastSyncNotification = 'requesting host time...';
          syncUI(s);
          sendWs(s, { action: 'REQUEST_SYNC' });
        }
        sendResponse({ ok: true });
        return false;

      case 'UI_TOGGLE_PICKER': {
        const next = msg.active !== undefined ? msg.active : !s.state.pickerActive;
        s.state.pickerActive = next;
        browserApi.tabs.sendMessage(tabId, {
          type: 'PICKER_MODE_BROADCAST',
          active: next,
        } satisfies BackgroundToContentMessage);
        syncUI(s);
        sendResponse({ ok: true, pickerActive: next });
        return false;
      }

      case 'PICKER_FORCE_SCAN_FRAMES':
        browserApi.tabs.sendMessage(tabId, {
          type: 'FORCE_LOCK_BEST_VIDEO',
        } satisfies BackgroundToContentMessage);
        sendResponse({ ok: true });
        return false;

      case 'VIDEO_LOCKED': {
        const { metadata } = msg;
        const isManual = metadata.lockMode === 'manual';
        const curManual = s.state.videoMetadata?.lockMode === 'manual';
        const samePage = s.lockedOnPageUrl === s.state.pageUrl;

        if (
          samePage &&
          curManual &&
          !isManual &&
          s.state.activeVideoFrameId !== null &&
          s.state.activeVideoFrameId !== frameId
        ) {
          sendResponse({ ok: false });
          return false;
        }

        const wasUnlocked = !s.state.videoLocked || !samePage;
        s.state.videoLocked = true;
        s.state.activeVideoFrameId = frameId;
        s.state.videoMetadata = metadata;
        s.lockedOnPageUrl = s.state.pageUrl;

        if (isManual && s.state.pickerActive) {
          s.state.pickerActive = false;
          browserApi.tabs.sendMessage(tabId, {
            type: 'PICKER_MODE_BROADCAST',
            active: false,
          } satisfies BackgroundToContentMessage);
        }

        pushHostMediaIfHost(s);

        // if peer just navigated to host's link and locked the new video, auto-sync to host
        if (wasUnlocked && !s.state.isHost && s.state.roomId && s.ws?.readyState === WebSocket.OPEN) {
          sendWs(s, { action: 'REQUEST_SYNC' });
        }

        syncUI(s);
        sendResponse({ ok: true, frameId });
        return false;
      }

      case 'VIDEO_STATE_REPORT':
        if (s.state.activeVideoFrameId === frameId && s.state.videoMetadata) {
          const oldDur = s.state.videoMetadata.duration;
          s.state.videoMetadata.currentTime = msg.currentTime;
          s.state.videoMetadata.duration = msg.duration;
          s.state.videoMetadata.isPlaying = msg.isPlaying;
          if (Math.abs((oldDur || 0) - (msg.duration || 0)) > 1) {
            pushHostMediaIfHost(s);
            syncUI(s);
          }
        }
        sendResponse({ ok: true });
        return false;

      case 'VIDEO_UNLOCKED':
        if (s.state.activeVideoFrameId === frameId) {
          s.state.videoLocked = false;
          s.state.activeVideoFrameId = null;
          s.state.videoMetadata = null;
          syncUI(s);
        }
        sendResponse({ ok: true });
        return false;

      case 'OUTBOUND_VIDEO_EVENT':
        if (s.state.activeVideoFrameId === null) {
          s.state.activeVideoFrameId = frameId;
          s.state.videoLocked = true;
        }
        if (s.state.activeVideoFrameId !== frameId) {
          sendResponse({ ok: false });
          return false;
        }

        if (s.state.videoMetadata) {
          s.state.videoMetadata.currentTime = msg.payload.time;
          if (msg.payload.type === 'PLAY') s.state.videoMetadata.isPlaying = true;
          else if (msg.payload.type === 'PAUSE') s.state.videoMetadata.isPlaying = false;
        }

        if (s.state.roomId && s.ws && s.ws.readyState === WebSocket.OPEN) {
          sendWs(s, { action: 'SYNC_ACTION', payload: msg.payload });
        }
        sendResponse({ ok: true });
        return false;
    }

    return false;
  }
);

browserApi.tabs.onRemoved.addListener((tabId: number) => {
  const s = sessions.get(tabId);
  if (s) {
    killWs(s);
    sessions.delete(tabId);
  }
});

browserApi.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined) return;
  const msg: BackgroundToContentMessage = { type: 'TOGGLE_DOCK_VISIBILITY' };
  const res = await browserApi.tabs.sendMessage(tab.id, msg, { frameId: 0 });
  if (!res) {
    await browserApi.scripting.executeScript(tab.id, ['content.js']);
    await browserApi.tabs.sendMessage(tab.id, msg, { frameId: 0 });
  }
});
