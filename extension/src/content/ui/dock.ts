import { browserApi } from '../../shared/browserApi';
import {
  ContentToBackgroundMessage,
  TabSyncState,
} from '../../shared/messages';
import { DOCK_STYLES } from './compiledStyles';

export const DOCK_TAG = 'sp-ext-dock';

export class FloatingDock {
  private hostEl: HTMLElement | null = null;
  private shadowRoot: ShadowRoot | null = null;
  private containerEl: HTMLDivElement | null = null;

  private isHidden = true;
  private isCollapsed = false;
  private showSettings = false;
  private copiedFeedback = false;
  private lastSig = '';

  private isDragging = false;
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private posX = Math.max(20, (window.innerWidth || 1024) - 320);
  private posY = 20;
  private rafPending = false;

  private draftNickname = '';
  private draftRoomCode = '';
  private draftServerUrl = 'ws://localhost:8080';

  private state: TabSyncState = {
    connectionStatus: 'disconnected',
    serverUrl: 'ws://localhost:8080',
    roomId: null,
    clientId: null,
    nickname: '',
    isHost: false,
    participants: [],
    hostMedia: null,
    pageUrl: window.location.href,
    pageTitle: document.title,
    videoLocked: false,
    activeVideoFrameId: null,
    videoMetadata: null,
    pickerActive: false,
    lastError: null,
    lastSyncNotification: null,
  };

  mount() {
    this.ensureHost();
    this.render(true);

    setInterval(() => {
      if (this.hostEl && !this.hostEl.isConnected) {
        (document.body || document.documentElement)?.appendChild(this.hostEl);
      }
    }, 1500);

    window.addEventListener(
      'resize',
      () => {
        if (!this.containerEl) return;
        this.posX = Math.min(this.posX, Math.max(8, window.innerWidth - 310));
        this.posY = Math.min(this.posY, Math.max(8, window.innerHeight - 80));
        this.containerEl.style.transform = `translate3d(${this.posX}px, ${this.posY}px, 0)`;
      },
      { passive: true }
    );

    this.hydrate();
  }

  private ensureHost() {
    const existing = document.querySelector(DOCK_TAG) as HTMLElement | null;
    if (existing && this.hostEl === existing) return;

    const host = document.createElement(DOCK_TAG);
    const shadow = host.attachShadow({ mode: 'open' });

    const styleTag = document.createElement('style');
    styleTag.textContent = DOCK_STYLES;
    shadow.appendChild(styleTag);

    const container = document.createElement('div');
    container.id = 'sp-dock-container';
    Object.assign(container.style, {
      position: 'fixed',
      top: '0px',
      left: '0px',
      transform: `translate3d(${this.posX}px, ${this.posY}px, 0)`,
      pointerEvents: 'auto',
      zIndex: '2147483640',
      willChange: 'transform',
    });
    shadow.appendChild(container);

    const root = document.body || document.documentElement;
    if (root) {
      root.appendChild(host);
    } else {
      window.addEventListener('DOMContentLoaded', () => {
        (document.body || document.documentElement)?.appendChild(host);
      });
    }

    this.hostEl = host;
    this.shadowRoot = shadow;
    this.containerEl = container;
  }

  private async hydrate() {
    try {
      const stored = await browserApi.storage.local.get<{
        sp_nickname?: string;
        sp_serverUrl?: string;
      }>(['sp_nickname', 'sp_serverUrl']);

      if (stored.sp_nickname && !this.draftNickname) this.draftNickname = stored.sp_nickname;
      if (stored.sp_serverUrl) this.draftServerUrl = stored.sp_serverUrl;
      this.render();
    } catch {}

    try {
      const res = await browserApi.runtime.sendMessage<
        ContentToBackgroundMessage,
        { state?: TabSyncState }
      >({
        type: 'UI_GET_STATE',
        pageUrl: window.location.href,
        pageTitle: document.title,
      });
      if (res?.state) this.updateState(res.state);
    } catch {}
  }

  updateState(next: TabSyncState) {
    // if we're already in an active room (e.g. after navigating to the host's link in the same tab),
    // keep the dock open automatically
    if (next.roomId && !this.state.roomId) {
      this.isHidden = false;
    }
    this.state = next;
    if (!this.draftNickname && next.nickname) this.draftNickname = next.nickname;
    if (next.serverUrl) this.draftServerUrl = next.serverUrl;
    this.render();
  }

  toggleVisibility() {
    this.ensureHost();
    if (this.hostEl && !this.hostEl.isConnected) {
      (document.body || document.documentElement)?.appendChild(this.hostEl);
    }
    this.isHidden = !this.isHidden;
    if (!this.isHidden) this.isCollapsed = false;
    this.render(true);
  }

  private getSig(): string {
    const m = this.state.videoMetadata;
    const hm = this.state.hostMedia;
    const pKey = this.state.participants
      .map((p) => `${p.id}:${p.nickname}:${p.isHost ? 1 : 0}`)
      .join(',');
    return [
      this.isHidden ? 1 : 0,
      this.isCollapsed ? 1 : 0,
      this.showSettings ? 1 : 0,
      this.copiedFeedback ? 1 : 0,
      this.state.connectionStatus,
      this.state.roomId ?? '',
      this.state.clientId ?? '',
      this.state.isHost ? 1 : 0,
      pKey,
      hm ? `${hm.url}:${hm.title}:${Math.round(hm.duration || 0)}` : 'no-hm',
      this.state.videoLocked ? 1 : 0,
      this.state.activeVideoFrameId ?? -1,
      m ? `${m.lockMode}:${m.width}x${m.height}:${Math.round(m.duration || 0)}` : 'none',
      this.state.pickerActive ? 1 : 0,
      this.state.lastError ?? '',
      this.state.lastSyncNotification ?? '',
    ].join('|');
  }

  private dotColor(): string {
    switch (this.state.connectionStatus) {
      case 'connected':
        return 'bg-emerald-500';
      case 'connecting':
        return 'bg-amber-500';
      case 'error':
        return 'bg-red-500';
      default:
        return 'bg-zinc-600';
    }
  }

  private fmtDur(sec: number): string {
    if (!Number.isFinite(sec) || sec <= 0) return 'live';
    const total = Math.floor(sec);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}m ${s}s`;
  }

  // check if peer's video or page doesn't match the host's
  private getMismatchReason(): string | null {
    if (this.state.isHost) return null;
    const hm = this.state.hostMedia;
    if (!hm || !hm.url) return null;

    const myDur = this.state.videoMetadata?.duration ?? 0;
    const hostDur = hm.duration ?? 0;

    // if both have a valid duration and they're off by more than 5 seconds, definitely not the same video
    if (myDur > 0 && hostDur > 0 && Math.abs(myDur - hostDur) > 5) {
      return `Video length mismatch (yours: ${this.fmtDur(myDur)}, host: ${this.fmtDur(hostDur)})`;
    }

    // check if URLs differ (ignoring hash / trailing slash)
    const norm = (u: string) => u.split('#')[0].replace(/\/+$/, '').toLowerCase();
    const myUrl = norm(window.location.href);
    const hostUrl = norm(hm.url);

    if (myUrl && hostUrl && myUrl !== hostUrl) {
      // if durations match within 2s, they might just be on two mirror domains of the same episode,
      // but still let them know the URL is different if they don't have a matching duration yet
      if (myDur <= 0 || hostDur <= 0) {
        return 'Not on the same page as host';
      }
    }

    return null;
  }

  private shortHostLabel(url: string, title: string): string {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, '');
      if (title?.trim()) {
        return `${host} — ${title.trim()}`;
      }
      return `${host}${u.pathname !== '/' ? u.pathname : ''}`;
    } catch {
      return title || url;
    }
  }

  private render(force = false) {
    if (!this.containerEl) return;

    const sig = this.getSig();
    if (!force && sig === this.lastSig) return;
    this.lastSig = sig;

    if (this.isHidden) {
      this.containerEl.style.display = 'none';
      return;
    }

    this.containerEl.style.display = 'block';
    this.containerEl.style.transform = `translate3d(${this.posX}px, ${this.posY}px, 0)`;

    const activeEl = this.shadowRoot?.activeElement as HTMLElement | null;
    const activeId = activeEl?.id;
    const selPos = (activeEl as HTMLInputElement | null)?.selectionStart ?? null;

    if (this.isCollapsed) {
      this.containerEl.innerHTML = this.renderPill();
      this.bindPill();
      return;
    }

    this.containerEl.innerHTML = this.renderPanel();
    this.bindPanel();

    if (activeId && this.shadowRoot) {
      const el = this.shadowRoot.getElementById(activeId) as HTMLInputElement | null;
      if (el) {
        el.focus();
        if (selPos !== null) {
          try {
            el.setSelectionRange(selPos, selPos);
          } catch {}
        }
      }
    }
  }

  private renderPill(): string {
    const dot = this.dotColor();
    const vDot = this.state.videoLocked ? 'bg-red-500' : 'bg-zinc-600';
    const room = this.state.roomId
      ? `<span class="px-1.5 py-0.5 text-[10px] font-mono font-semibold bg-red-950/80 text-red-300 rounded border border-red-800/60">${this.state.roomId}</span>`
      : '';

    return `
      <div id="sp-drag-handle" class="sp-panel flex items-center gap-2 px-3 py-1.5 rounded-md cursor-grab active:cursor-grabbing select-none">
        <span class="w-2 h-2 rounded-full ${dot}"></span>
        <span class="text-xs font-semibold tracking-tight text-zinc-100">SyncParty</span>
        ${room}
        <span class="w-1.5 h-1.5 rounded-full ${vDot}"></span>
        <button id="sp-expand-btn" class="ml-1 text-zinc-400 hover:text-zinc-100 text-xs font-mono px-1 cursor-pointer" title="Expand">
          +
        </button>
      </div>
    `;
  }

  private renderPanel(): string {
    const dot = this.dotColor();
    const meta = this.state.videoMetadata;

    const videoBox =
      this.state.videoLocked && meta
        ? `
        <div class="flex items-center justify-between bg-zinc-900 border border-zinc-800 rounded-md px-2.5 py-2">
          <div class="flex items-center gap-2 min-w-0">
            <span class="w-2 h-2 rounded-full bg-emerald-500 shrink-0"></span>
            <div class="truncate">
              <div class="text-xs font-medium text-zinc-200 flex items-center gap-1.5">
                <span>Player locked</span>
                <span class="text-[10px] uppercase px-1 py-0.2 rounded bg-zinc-800 text-zinc-400 border border-zinc-700 font-mono">${meta.lockMode}</span>
              </div>
              <div class="text-[11px] text-zinc-500 truncate font-mono">
                F${this.state.activeVideoFrameId ?? 0} · ${meta.width}x${meta.height} · ${this.fmtDur(meta.duration)}
              </div>
            </div>
          </div>
          <button id="sp-picker-btn" class="shrink-0 ml-2 px-2 py-1 rounded text-[11px] font-medium cursor-pointer ${
            this.state.pickerActive
              ? 'bg-red-600 text-white'
              : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700'
          }">
            ${this.state.pickerActive ? 'Cancel' : 'Select video'}
          </button>
        </div>
      `
        : `
        <div class="flex items-center justify-between bg-zinc-900 border border-zinc-800 rounded-md px-2.5 py-2">
          <div class="flex items-center gap-2 min-w-0">
            <span class="w-2 h-2 rounded-full bg-zinc-600 shrink-0"></span>
            <div>
              <div class="text-xs font-medium text-zinc-300">No video locked</div>
              <div class="text-[11px] text-zinc-500">Auto-detecting or pick manually</div>
            </div>
          </div>
          <button id="sp-picker-btn" class="shrink-0 ml-2 px-2.5 py-1 rounded text-[11px] font-medium cursor-pointer ${
            this.state.pickerActive
              ? 'bg-zinc-700 text-zinc-200'
              : 'bg-red-600 hover:bg-red-500 text-white'
          }">
            ${this.state.pickerActive ? 'Cancel' : 'Select video'}
          </button>
        </div>
      `;

    const errHtml = this.state.lastError
      ? `
        <div class="bg-red-950/60 border border-red-800/60 rounded-md px-2.5 py-1.5 text-[11px] text-red-300 flex items-center justify-between">
          <span class="truncate">${this.esc(this.state.lastError)}</span>
        </div>
      `
      : '';

    const bodyHtml = this.state.roomId ? this.renderRoom() : this.renderLobby();

    const settingsHtml = this.showSettings
      ? `
        <div class="pt-2.5 border-t border-zinc-800 space-y-1.5">
          <label class="block text-[10px] font-medium uppercase tracking-wider text-zinc-500">Relay Server</label>
          <div class="flex gap-1.5">
            <input
              id="sp-server-input"
              type="text"
              value="${this.esc(this.draftServerUrl)}"
              placeholder="ws://localhost:8080"
              class="flex-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-xs font-mono text-zinc-200 focus:outline-none focus:border-red-600"
            />
            <button id="sp-save-server-btn" class="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-200 rounded border border-zinc-700 cursor-pointer">
              Save
            </button>
          </div>
        </div>
      `
      : '';

    return `
      <div class="sp-panel w-[296px] rounded-lg overflow-hidden text-zinc-100 select-none">
        <div id="sp-drag-handle" class="flex items-center justify-between px-3 py-2 bg-zinc-900/90 border-b border-zinc-800 cursor-grab active:cursor-grabbing">
          <div class="flex items-center gap-2">
            <span class="w-2 h-2 rounded-full ${dot}"></span>
            <span class="text-xs font-semibold tracking-tight text-zinc-100">SyncParty</span>
            <span class="text-[10px] font-mono text-zinc-500">${this.state.connectionStatus}</span>
          </div>
          <div class="flex items-center gap-1">
            <button id="sp-settings-btn" class="px-1.5 py-0.5 text-[11px] text-zinc-400 hover:text-zinc-200 rounded cursor-pointer">
              Server
            </button>
            <button id="sp-collapse-btn" class="px-1.5 py-0.5 text-xs font-mono text-zinc-400 hover:text-zinc-200 rounded cursor-pointer" title="Minimize">
              -
            </button>
            <button id="sp-close-btn" class="px-1.5 py-0.5 text-xs font-mono text-zinc-400 hover:text-red-400 rounded cursor-pointer" title="Hide">
              x
            </button>
          </div>
        </div>

        <div class="p-3 space-y-2.5">
          ${videoBox}
          ${errHtml}
          ${bodyHtml}
          ${settingsHtml}
        </div>
      </div>
    `;
  }

  private renderLobby(): string {
    return `
      <div class="space-y-2">
        <div>
          <label class="block text-[10px] font-medium uppercase tracking-wider text-zinc-500 mb-1">Name</label>
          <input
            id="sp-nickname-input"
            type="text"
            maxlength="24"
            value="${this.esc(this.draftNickname)}"
            placeholder="Nickname"
            class="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-red-600"
          />
        </div>

        <button
          id="sp-create-room-btn"
          class="w-full py-1.5 px-3 rounded bg-red-600 hover:bg-red-500 text-white font-medium text-xs cursor-pointer"
        >
          Create room
        </button>

        <div class="flex gap-1.5 pt-1">
          <input
            id="sp-room-code-input"
            type="text"
            maxlength="6"
            value="${this.esc(this.draftRoomCode)}"
            placeholder="ROOM CODE"
            class="flex-1 bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 text-xs font-mono uppercase tracking-widest text-center text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-red-600"
          />
          <button
            id="sp-join-room-btn"
            class="px-3.5 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-medium text-zinc-200 cursor-pointer"
          >
            Join
          </button>
        </div>
      </div>
    `;
  }

  private renderRoom(): string {
    const hm = this.state.hostMedia;
    const mismatch = this.getMismatchReason();

    // only show host page info if you're not the host
    const hostSiteHtml =
      !this.state.isHost && hm && hm.url
        ? `
        <div class="bg-zinc-900 border border-zinc-800 rounded-md px-2.5 py-1.5 text-xs">
          <div class="flex items-center justify-between gap-2">
            <span class="text-[10px] uppercase tracking-wider text-zinc-500 font-medium shrink-0">Host page</span>
            <a
              href="${this.esc(hm.url)}"
              target="_top"
              class="text-[11px] font-mono text-red-400 hover:text-red-300 underline truncate"
              title="${this.esc(hm.url)}"
            >
              Open link
            </a>
          </div>
          <div class="text-[11px] text-zinc-300 truncate mt-0.5" title="${this.esc(hm.title || hm.url)}">
            ${this.esc(this.shortHostLabel(hm.url, hm.title))}
          </div>
        </div>
      `
        : '';

    const mismatchHtml =
      !this.state.isHost && mismatch && hm?.url
        ? `
        <div class="bg-amber-950/50 border border-amber-700/60 rounded-md px-2.5 py-2 text-[11px] text-amber-200 space-y-1">
          <div class="font-medium">${this.esc(mismatch)}</div>
          <div class="text-amber-300/80">
            Sync is still running, but you might be on a different video.
            <a
              href="${this.esc(hm.url)}"
              target="_top"
              class="text-red-400 hover:text-red-300 underline font-mono ml-1"
            >
              Go to host video ->
            </a>
          </div>
        </div>
      `
        : '';

    const resyncBtnHtml = !this.state.isHost
      ? `
        <button
          id="sp-resync-btn"
          class="w-full py-1.5 px-2.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 text-xs font-medium cursor-pointer"
          title="Ask host for their exact current timestamp and jump there"
        >
          Sync to host
        </button>
      `
      : '';

    const list = this.state.participants
      .map((p) => {
        const me = p.id === this.state.clientId;
        return `
          <div class="flex items-center justify-between py-1 px-2 rounded bg-zinc-900 text-xs">
            <div class="flex items-center gap-1.5 truncate">
              <span class="w-1.5 h-1.5 rounded-full bg-red-500"></span>
              <span class="text-zinc-200 truncate">${this.esc(p.nickname)}</span>
              ${me ? '<span class="text-[10px] text-zinc-500">(you)</span>' : ''}
            </div>
            ${
              p.isHost
                ? '<span class="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700">host</span>'
                : ''
            }
          </div>
        `;
      })
      .join('');

    const notice = this.state.lastSyncNotification
      ? `
        <div class="text-[11px] font-mono text-zinc-400 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 truncate">
          ${this.esc(this.state.lastSyncNotification)}
        </div>
      `
      : '';

    return `
      <div class="space-y-2">
        <div class="flex items-center justify-between bg-zinc-900 border border-zinc-800 rounded-md px-2.5 py-2">
          <div>
            <div class="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">Room</div>
            <div class="text-sm font-mono font-bold tracking-widest text-red-400">${this.state.roomId}</div>
          </div>
          <div class="flex items-center gap-1.5">
            <button
              id="sp-copy-code-btn"
              class="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 text-xs font-medium cursor-pointer"
            >
              ${this.copiedFeedback ? 'Copied' : 'Copy'}
            </button>
            <button
              id="sp-leave-room-btn"
              class="px-2 py-1 rounded bg-red-950/60 hover:bg-red-900/60 border border-red-800/50 text-red-300 text-xs font-medium cursor-pointer"
            >
              Leave
            </button>
          </div>
        </div>

        ${hostSiteHtml}
        ${mismatchHtml}
        ${resyncBtnHtml}
        ${notice}

        <div>
          <div class="flex items-center justify-between text-[10px] font-medium uppercase tracking-wider text-zinc-500 mb-1">
            <span>Users (${this.state.participants.length})</span>
            <span>${this.state.isHost ? 'Host' : 'Peer'}</span>
          </div>
          <div class="max-h-24 overflow-y-auto space-y-1 sp-scrollbar pr-0.5">
            ${list}
          </div>
        </div>
      </div>
    `;
  }

  private bindDrag() {
    const handle = this.shadowRoot?.getElementById('sp-drag-handle');
    if (!handle) return;

    const onMove = (e: PointerEvent) => {
      if (!this.isDragging || !this.containerEl) return;
      const maxX = Math.max(20, window.innerWidth - 80);
      const maxY = Math.max(20, window.innerHeight - 60);
      this.posX = Math.min(maxX, Math.max(8, e.clientX - this.dragOffsetX));
      this.posY = Math.min(maxY, Math.max(8, e.clientY - this.dragOffsetY));

      if (!this.rafPending) {
        this.rafPending = true;
        requestAnimationFrame(() => {
          this.rafPending = false;
          if (this.containerEl) {
            this.containerEl.style.transform = `translate3d(${this.posX}px, ${this.posY}px, 0)`;
          }
        });
      }
    };

    const onUp = (e: PointerEvent) => {
      if (!this.isDragging) return;
      this.isDragging = false;
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {}
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };

    handle.addEventListener('pointerdown', (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('button') || t.closest('input') || t.closest('a')) return;
      this.isDragging = true;
      this.dragOffsetX = e.clientX - this.posX;
      this.dragOffsetY = e.clientY - this.posY;
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {}
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  }

  private bindPill() {
    this.bindDrag();
    this.shadowRoot?.getElementById('sp-expand-btn')?.addEventListener('click', () => {
      this.isCollapsed = false;
      this.render(true);
    });
  }

  private bindPanel() {
    if (!this.shadowRoot) return;
    this.bindDrag();

    this.shadowRoot.getElementById('sp-collapse-btn')?.addEventListener('click', () => {
      this.isCollapsed = true;
      this.render(true);
    });

    this.shadowRoot.getElementById('sp-close-btn')?.addEventListener('click', () => {
      this.isHidden = true;
      this.render(true);
    });

    this.shadowRoot.getElementById('sp-settings-btn')?.addEventListener('click', () => {
      this.showSettings = !this.showSettings;
      this.render(true);
    });

    this.shadowRoot.getElementById('sp-picker-btn')?.addEventListener('click', () => {
      browserApi.runtime.sendMessage({
        type: 'UI_TOGGLE_PICKER',
      } satisfies ContentToBackgroundMessage);
    });

    const nick = this.shadowRoot.getElementById('sp-nickname-input') as HTMLInputElement | null;
    nick?.addEventListener('input', (e) => {
      this.draftNickname = (e.target as HTMLInputElement).value;
      browserApi.storage.local.set({ sp_nickname: this.draftNickname });
    });

    const code = this.shadowRoot.getElementById('sp-room-code-input') as HTMLInputElement | null;
    code?.addEventListener('input', (e) => {
      this.draftRoomCode = (e.target as HTMLInputElement).value.toUpperCase();
    });
    code?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.joinRoom();
    });

    this.shadowRoot.getElementById('sp-create-room-btn')?.addEventListener('click', () => {
      browserApi.runtime.sendMessage({
        type: 'UI_CREATE_ROOM',
        nickname: this.draftNickname,
        serverUrl: this.draftServerUrl,
        pageUrl: window.location.href,
        pageTitle: document.title,
      } satisfies ContentToBackgroundMessage);
    });

    this.shadowRoot.getElementById('sp-join-room-btn')?.addEventListener('click', () => {
      this.joinRoom();
    });

    this.shadowRoot.getElementById('sp-leave-room-btn')?.addEventListener('click', () => {
      browserApi.runtime.sendMessage({
        type: 'UI_LEAVE_ROOM',
      } satisfies ContentToBackgroundMessage);
    });

    this.shadowRoot.getElementById('sp-resync-btn')?.addEventListener('click', () => {
      browserApi.runtime.sendMessage({
        type: 'UI_REQUEST_RESYNC',
      } satisfies ContentToBackgroundMessage);
    });

    this.shadowRoot.getElementById('sp-copy-code-btn')?.addEventListener('click', () => {
      if (!this.state.roomId) return;
      navigator.clipboard?.writeText(this.state.roomId).catch(() => {});
      this.copiedFeedback = true;
      this.render(true);
      setTimeout(() => {
        this.copiedFeedback = false;
        this.render(true);
      }, 1500);
    });

    const srv = this.shadowRoot.getElementById('sp-server-input') as HTMLInputElement | null;
    srv?.addEventListener('input', (e) => {
      this.draftServerUrl = (e.target as HTMLInputElement).value;
    });

    this.shadowRoot.getElementById('sp-save-server-btn')?.addEventListener('click', () => {
      browserApi.storage.local.set({ sp_serverUrl: this.draftServerUrl });
      browserApi.runtime.sendMessage({
        type: 'UI_UPDATE_SERVER_URL',
        serverUrl: this.draftServerUrl,
      } satisfies ContentToBackgroundMessage);
      this.showSettings = false;
      this.render(true);
    });
  }

  private joinRoom() {
    browserApi.runtime.sendMessage({
      type: 'UI_JOIN_ROOM',
      roomId: this.draftRoomCode,
      nickname: this.draftNickname,
      serverUrl: this.draftServerUrl,
      pageUrl: window.location.href,
      pageTitle: document.title,
    } satisfies ContentToBackgroundMessage);
  }

  private esc(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
