import { browserApi } from '../../shared/browserApi';
import { ContentToBackgroundMessage } from '../../shared/messages';
import { SyncActionPayload, SyncActionType } from '../../shared/protocol';

const IGNORE_DRIFT = 0.25;
const HARD_SEEK_DRIFT = 1.5;
const SETTLE_DRIFT = 0.1;
const RATE_FAST = 1.05;
const RATE_SLOW = 0.95;
const HEARTBEAT_MS = 3000;

export class SyncEngine {
  private video: HTMLVideoElement | null = null;

  // mutex stuff so we don't bounce events back and forth forever
  private isRemoteAction = false;
  private isRemoteSeeking = false;
  private suppressUntil = 0;
  private mutexTimer: ReturnType<typeof setTimeout> | null = null;
  private seekTimer: ReturnType<typeof setTimeout> | null = null;

  private isSoftSyncing = false;
  private lastRefTime = 0;
  private lastRefPerf = 0;

  private hbTimer: ReturnType<typeof setInterval> | null = null;

  private readonly onPlay = () => this.handlePlay();
  private readonly onPause = () => this.handlePause();
  private readonly onSeeked = () => this.handleSeeked();
  private readonly onTimeUpdate = () => this.handleTimeUpdate();

  attach(video: HTMLVideoElement) {
    if (this.video === video) return;
    this.detach();

    this.video = video;
    this.isRemoteAction = false;
    this.isRemoteSeeking = false;
    this.suppressUntil = 0;
    this.isSoftSyncing = false;

    video.addEventListener('play', this.onPlay);
    video.addEventListener('pause', this.onPause);
    video.addEventListener('seeked', this.onSeeked);
    video.addEventListener('timeupdate', this.onTimeUpdate);

    this.hbTimer = setInterval(() => {
      if (!this.video) return;
      browserApi.runtime.sendMessage({
        type: 'VIDEO_STATE_REPORT',
        currentTime: this.video.currentTime,
        duration: this.video.duration || 0,
        isPlaying: !this.video.paused,
      } satisfies ContentToBackgroundMessage);

      if (!this.video.paused && !this.video.seeking && !this.isMutedByRemote()) {
        this.emit('HEARTBEAT', this.video.currentTime);
      }
    }, HEARTBEAT_MS);
  }

  detach() {
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (this.mutexTimer) clearTimeout(this.mutexTimer);
    if (this.seekTimer) clearTimeout(this.seekTimer);
    this.hbTimer = null;
    this.mutexTimer = null;
    this.seekTimer = null;

    if (this.video) {
      this.video.removeEventListener('play', this.onPlay);
      this.video.removeEventListener('pause', this.onPause);
      this.video.removeEventListener('seeked', this.onSeeked);
      this.video.removeEventListener('timeupdate', this.onTimeUpdate);
      if (this.isSoftSyncing) {
        try {
          this.video.playbackRate = 1.0;
        } catch {}
      }
      this.video = null;
    }

    this.isRemoteAction = false;
    this.isRemoteSeeking = false;
    this.suppressUntil = 0;
    this.isSoftSyncing = false;
  }

  getAttachedVideo() {
    return this.video;
  }

  private isMutedByRemote() {
    return this.isRemoteAction || this.isRemoteSeeking || Date.now() < this.suppressUntil;
  }

  private lockPlayPause(ev: 'play' | 'pause') {
    this.isRemoteAction = true;
    this.suppressUntil = Math.max(this.suppressUntil, Date.now() + 350);

    if (this.mutexTimer) clearTimeout(this.mutexTimer);

    const unlock = () => {
      if (this.mutexTimer) {
        clearTimeout(this.mutexTimer);
        this.mutexTimer = null;
      }
      setTimeout(() => {
        if (!this.isRemoteSeeking) this.isRemoteAction = false;
      }, 100);
    };

    this.video?.addEventListener(ev, unlock, { once: true });

    this.mutexTimer = setTimeout(() => {
      if (!this.isRemoteSeeking) this.isRemoteAction = false;
      this.mutexTimer = null;
    }, 450);
  }

  private remoteSeek(video: HTMLVideoElement, target: number) {
    this.isRemoteAction = true;
    this.isRemoteSeeking = true;
    this.suppressUntil = Math.max(this.suppressUntil, Date.now() + 600);

    if (this.seekTimer) clearTimeout(this.seekTimer);

    const done = () => {
      if (this.seekTimer) {
        clearTimeout(this.seekTimer);
        this.seekTimer = null;
      }
      this.suppressUntil = Math.max(this.suppressUntil, Date.now() + 120);
      setTimeout(() => {
        this.isRemoteSeeking = false;
        this.isRemoteAction = false;
      }, 100);
    };

    video.addEventListener('seeked', done, { once: true });

    // in case stream stalls and seeked takes forever
    this.seekTimer = setTimeout(() => {
      this.isRemoteSeeking = false;
      this.isRemoteAction = false;
      this.seekTimer = null;
    }, 1500);

    video.currentTime = target;
  }

  applyRemoteSync(payload: SyncActionPayload) {
    const video = this.video;
    if (!video) return;

    const now = Date.now();
    const lag =
      payload.hostTimestamp > 0
        ? Math.max(0, Math.min(4.0, (now - payload.hostTimestamp) / 1000))
        : 0;

    const playing = payload.type === 'PLAY' || payload.type === 'HEARTBEAT';
    const target = playing ? payload.time + lag : payload.time;
    const delta = Math.abs(video.currentTime - target);

    switch (payload.type) {
      case 'PLAY':
        if (payload.forceSeek) {
          this.resetRate(video);
          this.remoteSeek(video, target);
        } else {
          this.fixDrift(video, target, delta, true);
        }
        if (video.paused) {
          this.lockPlayPause('play');
          video.play().catch(() => {
            this.isRemoteAction = false;
          });
        }
        break;

      case 'PAUSE':
      case 'BUFFERING':
        this.resetRate(video);
        if (!video.paused) {
          this.lockPlayPause('pause');
          video.pause();
        }
        if (payload.forceSeek || delta >= IGNORE_DRIFT) {
          this.remoteSeek(video, target);
        }
        break;

      case 'SEEK':
        this.resetRate(video);
        if (delta >= IGNORE_DRIFT) {
          this.remoteSeek(video, target);
        }
        break;

      case 'HEARTBEAT':
        if (!video.paused) {
          this.fixDrift(video, target, delta, true);
        }
        break;
    }
  }

  // < 0.25s: ignore
  // 0.25s - 1.5s: nudge playbackRate so audio doesn't pop
  // > 1.5s: hard seek
  private fixDrift(video: HTMLVideoElement, target: number, delta: number, playing: boolean) {
    this.lastRefTime = target;
    this.lastRefPerf = performance.now();

    if (delta < IGNORE_DRIFT) {
      if (this.isSoftSyncing) this.resetRate(video);
      return;
    }

    if (delta > HARD_SEEK_DRIFT || !playing) {
      this.resetRate(video);
      this.remoteSeek(video, target);
      return;
    }

    const rate = video.currentTime < target ? RATE_FAST : RATE_SLOW;
    if (video.playbackRate !== rate) video.playbackRate = rate;
    this.isSoftSyncing = true;
  }

  private resetRate(video: HTMLVideoElement) {
    if (this.isSoftSyncing || video.playbackRate !== 1.0) {
      video.playbackRate = 1.0;
      this.isSoftSyncing = false;
    }
  }

  private handleTimeUpdate() {
    if (!this.video || !this.isSoftSyncing) return;

    const dt = (performance.now() - this.lastRefPerf) / 1000;
    const expected = this.lastRefTime + dt;
    const err = Math.abs(this.video.currentTime - expected);

    if (err <= SETTLE_DRIFT || dt > 10) {
      this.resetRate(this.video);
    }
  }

  private handlePlay() {
    if (!this.video || this.isMutedByRemote()) return;
    this.emit('PLAY', this.video.currentTime);
  }

  private handlePause() {
    if (!this.video || this.isMutedByRemote() || this.video.seeking) return;
    this.emit('PAUSE', this.video.currentTime);
  }

  private handleSeeked() {
    if (!this.video || this.isMutedByRemote()) return;
    this.emit('SEEK', this.video.currentTime);
  }

  private emit(type: SyncActionType, time: number) {
    browserApi.runtime.sendMessage({
      type: 'OUTBOUND_VIDEO_EVENT',
      payload: {
        type,
        time,
        playbackRate: 1.0,
        hostTimestamp: Date.now(),
      },
    } satisfies ContentToBackgroundMessage);
  }
}
