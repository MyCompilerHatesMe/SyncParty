import { browserApi } from '../../shared/browserApi';
import {
  ContentToBackgroundMessage,
  VideoCandidateMetadata,
} from '../../shared/messages';
import { SyncEngine } from './syncEngine';

const MIN_W = 400;
const MIN_H = 250;
const MIN_DUR = 180; // skip <3m preroll ads

export class VideoHunter {
  private syncEngine: SyncEngine;
  private observer: MutationObserver | null = null;
  private seen = new WeakSet<HTMLVideoElement>();
  private lockedVideo: HTMLVideoElement | null = null;
  private lockMode: 'none' | 'auto' | 'manual' = 'none';
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(syncEngine: SyncEngine) {
    this.syncEngine = syncEngine;
  }

  start() {
    this.scanDocument();

    // only care when new nodes show up, watching attributes lags the page to death
    this.observer = new MutationObserver((mutations) => {
      for (let i = 0; i < mutations.length; i++) {
        const added = mutations[i].addedNodes;
        for (let j = 0; j < added.length; j++) {
          const node = added[j];
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as Element;
            if (
              el.tagName === 'VIDEO' ||
              el.getElementsByTagName('video').length > 0 ||
              el.shadowRoot
            ) {
              this.scheduleScan();
              return;
            }
          }
        }
      }
    });

    if (document.documentElement) {
      this.observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    }

    this.checkTimer = setInterval(() => {
      if (this.lockedVideo) {
        if (!this.lockedVideo.isConnected) {
          this.unlock();
          this.scheduleScan();
        }
        return;
      }
      this.scheduleScan();
    }, 5000);
  }

  stop() {
    this.observer?.disconnect();
    this.observer = null;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.scanTimer = null;
    this.checkTimer = null;
  }

  private scheduleScan() {
    if (this.scanTimer) return;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      const idle = (window as any).requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 16));
      idle(() => this.scanDocument());
    }, 500);
  }

  collectAllVideos(
    root: Document | ShadowRoot | Element = document,
    checkShadows = false
  ): HTMLVideoElement[] {
    const vids: HTMLVideoElement[] = Array.from(root.querySelectorAll('video'));
    if (checkShadows || vids.length === 0) {
      const all = root.querySelectorAll('*');
      const cap = Math.min(all.length, 1500);
      for (let i = 0; i < cap; i++) {
        const el = all[i];
        if (el.shadowRoot) {
          vids.push(...this.collectAllVideos(el.shadowRoot, false));
        }
      }
    }
    return vids;
  }

  private score(v: HTMLVideoElement): number {
    if (!v.isConnected || v.style.display === 'none' || v.hidden) return -1;

    // check duration before touching layout so we don't thrash reflows
    const d = v.duration;
    if (typeof d !== 'number' || Number.isNaN(d) || (d <= MIN_DUR && d !== Infinity)) {
      return -1;
    }

    const r = v.getBoundingClientRect();
    if (r.width <= MIN_W || r.height <= MIN_H) return -1;

    const cs = window.getComputedStyle(v);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') {
      return -1;
    }

    const area = r.width * r.height;
    const playingBonus = !v.paused ? 500_000 : 0;
    const durBonus = Number.isFinite(d) ? Math.min(d, 10_000) * 10 : 50_000;

    return area + playingBonus + durBonus;
  }

  private hookVideo(v: HTMLVideoElement) {
    if (this.seen.has(v)) return;
    this.seen.add(v);

    const onDurChange = () => {
      // if a 15s ad just finished and swapped to the real movie, re-lock it
      if (v === this.lockedVideo) {
        if (this.lockMode === 'auto' && v.duration > 0 && v.duration <= MIN_DUR) {
          this.unlock();
          return;
        }
        this.syncEngine.attach(v);
        this.reportLock(v, this.lockMode === 'manual' ? 'manual' : 'auto');
      } else {
        this.scanDocument();
      }
    };

    v.addEventListener('loadedmetadata', onDurChange, { passive: true });
    v.addEventListener('durationchange', onDurChange, { passive: true });
    v.addEventListener(
      'playing',
      () => {
        if (!this.lockedVideo) this.scheduleScan();
      },
      { passive: true }
    );
  }

  scanDocument() {
    if (this.lockMode === 'manual' && this.lockedVideo?.isConnected) return;

    const vids = this.collectAllVideos(document, false);
    if (vids.length === 0) return;

    let best: HTMLVideoElement | null = null;
    let bestScore = -1;

    for (let i = 0; i < vids.length; i++) {
      const v = vids[i];
      this.hookVideo(v);
      const s = this.score(v);
      if (s > bestScore) {
        bestScore = s;
        best = v;
      }
    }

    if (best && bestScore > 0) {
      if (this.lockedVideo !== best) this.lockVideo(best, 'auto');
    } else if (this.lockedVideo && this.lockMode === 'auto') {
      if (this.score(this.lockedVideo) < 0) this.unlock();
    }
  }

  lockVideo(v: HTMLVideoElement, mode: 'auto' | 'manual') {
    this.hookVideo(v);
    this.lockedVideo = v;
    this.lockMode = mode;

    this.syncEngine.attach(v);
    this.reportLock(v, mode);
  }

  forceLockBestAvailable(): boolean {
    const vids = this.collectAllVideos(document, true);
    if (vids.length === 0) return false;

    let best: HTMLVideoElement | null = null;
    let maxArea = -1;

    for (const v of vids) {
      if (!v.isConnected) continue;
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > maxArea) {
        maxArea = area;
        best = v;
      }
    }

    if (best && maxArea > 0) {
      this.lockVideo(best, 'manual');
      return true;
    }
    return false;
  }

  private reportLock(v: HTMLVideoElement, mode: 'auto' | 'manual') {
    const r = v.getBoundingClientRect();
    const metadata: VideoCandidateMetadata = {
      duration: Number.isFinite(v.duration) ? v.duration : 0,
      currentTime: v.currentTime || 0,
      isPlaying: !v.paused,
      width: Math.round(r.width),
      height: Math.round(r.height),
      frameUrl: window.location.href,
      lockMode: mode,
    };

    browserApi.runtime.sendMessage({
      type: 'VIDEO_LOCKED',
      metadata,
    } satisfies ContentToBackgroundMessage);
  }

  private unlock() {
    this.syncEngine.detach();
    this.lockedVideo = null;
    this.lockMode = 'none';
    browserApi.runtime.sendMessage({
      type: 'VIDEO_UNLOCKED',
    } satisfies ContentToBackgroundMessage);
  }
}
