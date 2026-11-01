import { browserApi } from '../../shared/browserApi';
import { ContentToBackgroundMessage } from '../../shared/messages';
import { VideoHunter } from '../engine/videoHunter';
import { DOCK_TAG } from './dock';

export const PICKER_TAG = 'sp-ext-picker';

export class PickerOverlay {
  private hunter: VideoHunter;
  private active = false;
  private host: HTMLElement | null = null;
  private box: HTMLDivElement | null = null;
  private badge: HTMLDivElement | null = null;
  private banner: HTMLDivElement | null = null;
  private rafPending = false;
  private lastX = 0;
  private lastY = 0;
  private lastTarget: EventTarget | null = null;

  private readonly onMove = (e: MouseEvent) => this.handleMove(e);
  private readonly onClick = (e: MouseEvent) => this.handleClick(e);
  private readonly onKey = (e: KeyboardEvent) => this.handleKey(e);

  constructor(hunter: VideoHunter) {
    this.hunter = hunter;
  }

  isActive() {
    return this.active;
  }

  setActive(enable: boolean) {
    if (this.active === enable) return;
    this.active = enable;

    if (enable) {
      this.mount();
      window.addEventListener('mousemove', this.onMove, { capture: true, passive: true });
      window.addEventListener('click', this.onClick, true);
      window.addEventListener('keydown', this.onKey, true);
      document.documentElement.style.cursor = 'crosshair';
    } else {
      window.removeEventListener('mousemove', this.onMove, true);
      window.removeEventListener('click', this.onClick, true);
      window.removeEventListener('keydown', this.onKey, true);
      document.documentElement.style.cursor = '';
      this.unmount();
    }
  }

  private mount() {
    this.unmount();

    // mount inside a custom tag shadow root so ublock doesn't hide the picker box either
    const host = document.createElement(PICKER_TAG);
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial !important;
        display: block !important;
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        width: 0 !important;
        height: 0 !important;
        z-index: 2147483639 !important;
        pointer-events: none !important;
      }
    `;
    shadow.appendChild(style);

    if (window === window.top) {
      const b = document.createElement('div');
      Object.assign(b.style, {
        position: 'fixed',
        top: '16px',
        left: '50%',
        transform: 'translateX(-50%)',
        background: '#111113',
        color: '#f4f4f5',
        border: '1px solid #dc2626',
        borderRadius: '6px',
        padding: '6px 14px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: '12px',
        fontWeight: '500',
        boxShadow: '0 8px 20px rgba(0, 0, 0, 0.8)',
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      });
      const dot = document.createElement('span');
      Object.assign(dot.style, {
        display: 'inline-block',
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background: '#ef4444',
      });
      const label = document.createElement('span');
      label.textContent = 'Click video player to lock sync (ESC to cancel)';
      b.append(dot, label);
      shadow.appendChild(b);
      this.banner = b;
    }

    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'fixed',
      top: '0px',
      left: '0px',
      width: '0px',
      height: '0px',
      pointerEvents: 'none',
      border: '2px solid #dc2626',
      background: 'rgba(220, 38, 38, 0.12)',
      borderRadius: '4px',
      willChange: 'transform, width, height',
      display: 'none',
    });

    const badge = document.createElement('div');
    Object.assign(badge.style, {
      position: 'absolute',
      top: '-24px',
      left: '0px',
      background: '#dc2626',
      color: '#ffffff',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: '11px',
      fontWeight: '600',
      padding: '2px 6px',
      borderRadius: '3px',
      whiteSpace: 'nowrap',
    });
    box.appendChild(badge);
    shadow.appendChild(box);

    (document.body || document.documentElement)?.appendChild(host);
    this.host = host;
    this.box = box;
    this.badge = badge;
  }

  private unmount() {
    this.host?.remove();
    this.host = null;
    this.box = null;
    this.banner = null;
    this.badge = null;
  }

  private findAt(x: number, y: number, fallback: EventTarget | null) {
    const stack = document.elementsFromPoint(x, y).filter((el) => {
      const tag = el.tagName.toLowerCase();
      return tag !== DOCK_TAG && tag !== PICKER_TAG;
    });

    for (const el of stack) {
      if (el instanceof HTMLVideoElement) {
        return { video: el, iframe: null, el };
      }
      if (el.shadowRoot) {
        const sv = this.hunter.collectAllVideos(el.shadowRoot, false);
        if (sv.length > 0) return { video: sv[0], iframe: null, el: sv[0] };
      }
    }

    for (const el of stack) {
      if (el instanceof HTMLIFrameElement) {
        return { video: null, iframe: el, el };
      }
      const cv = el.querySelector?.('video') as HTMLVideoElement | null;
      if (cv) return { video: cv, iframe: null, el: cv };
    }

    const top = stack[0] ?? (fallback instanceof Element ? fallback : null);
    let cur: Element | null = top;
    for (let d = 0; cur && d < 5 && cur !== document.body && cur !== document.documentElement; d++) {
      const v = cur.querySelector('video') as HTMLVideoElement | null;
      if (v) return { video: v, iframe: null, el: v };
      cur = cur.parentElement;
    }

    return { video: null, iframe: null, el: top };
  }

  private handleMove(e: MouseEvent) {
    if (!this.active) return;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.lastTarget = e.target;

    if (this.rafPending) return;
    this.rafPending = true;

    requestAnimationFrame(() => {
      this.rafPending = false;
      if (!this.active || !this.box || !this.badge) return;

      const { video, iframe, el } = this.findAt(this.lastX, this.lastY, this.lastTarget);
      const target = video ?? iframe ?? el;
      if (!target) {
        this.box.style.display = 'none';
        return;
      }

      const r = target.getBoundingClientRect();
      this.box.style.display = 'block';
      this.box.style.transform = `translate3d(${Math.max(0, r.left)}px, ${Math.max(0, r.top)}px, 0)`;
      this.box.style.width = `${Math.max(20, r.width)}px`;
      this.box.style.height = `${Math.max(20, r.height)}px`;
      this.badge.style.top = r.top < 30 ? '4px' : '-24px';

      if (video) {
        this.box.style.borderColor = '#ef4444';
        this.box.style.background = 'rgba(239, 68, 68, 0.14)';
        this.badge.style.background = '#dc2626';
        const dur =
          Number.isFinite(video.duration) && video.duration > 0
            ? ` · ${Math.round(video.duration)}s`
            : '';
        this.badge.textContent = `video (${Math.round(r.width)}x${Math.round(r.height)}${dur})`;
      } else if (iframe) {
        this.box.style.borderColor = '#dc2626';
        this.box.style.background = 'rgba(220, 38, 38, 0.1)';
        this.badge.style.background = '#b91c1c';
        this.badge.textContent = `iframe (click to lock child video)`;
      } else {
        this.box.style.borderColor = '#52525b';
        this.box.style.background = 'rgba(82, 82, 91, 0.12)';
        this.badge.style.background = '#3f3f46';
        this.badge.textContent = target.tagName.toLowerCase();
      }
    });
  }

  private handleClick(e: MouseEvent) {
    if (!this.active) return;

    if (
      e
        .composedPath()
        .some((n) => n instanceof Element && n.tagName.toLowerCase() === DOCK_TAG)
    ) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const { video, iframe } = this.findAt(e.clientX, e.clientY, e.target);

    if (video) {
      this.hunter.lockVideo(video, 'manual');
      this.setActive(false);
      return;
    }

    if (iframe) {
      browserApi.runtime.sendMessage({
        type: 'PICKER_FORCE_SCAN_FRAMES',
      } satisfies ContentToBackgroundMessage);
      browserApi.runtime.sendMessage({
        type: 'UI_TOGGLE_PICKER',
        active: false,
      } satisfies ContentToBackgroundMessage);
      this.setActive(false);
      return;
    }

    if (!this.hunter.forceLockBestAvailable()) {
      browserApi.runtime.sendMessage({
        type: 'PICKER_FORCE_SCAN_FRAMES',
      } satisfies ContentToBackgroundMessage);
    }

    browserApi.runtime.sendMessage({
      type: 'UI_TOGGLE_PICKER',
      active: false,
    } satisfies ContentToBackgroundMessage);
    this.setActive(false);
  }

  private handleKey(e: KeyboardEvent) {
    if (!this.active || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    browserApi.runtime.sendMessage({
      type: 'UI_TOGGLE_PICKER',
      active: false,
    } satisfies ContentToBackgroundMessage);
    this.setActive(false);
  }
}
