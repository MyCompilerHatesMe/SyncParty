import { browserApi } from '../shared/browserApi';
import { BackgroundToContentMessage } from '../shared/messages';
import { SyncEngine } from './engine/syncEngine';
import { VideoHunter } from './engine/videoHunter';
import { DOCK_TAG, FloatingDock } from './ui/dock';
import { PickerOverlay } from './ui/pickerOverlay';

(function init() {
  const isTop = window === window.top;

  if ((window as any).__SYNCPARTY_INIT__) {
    if (!isTop || document.querySelector(DOCK_TAG)) return;
  }
  (window as any).__SYNCPARTY_INIT__ = true;

  const engine = new SyncEngine();
  const hunter = new VideoHunter(engine);
  const picker = new PickerOverlay(hunter);

  let dock: FloatingDock | null = null;
  if (isTop) {
    dock = new FloatingDock();
    dock.mount();
  }

  hunter.start();

  browserApi.runtime.onMessage.addListener(
    (msg: BackgroundToContentMessage, _sender, sendResponse) => {
      switch (msg.type) {
        case 'STATE_UPDATED':
          if (isTop && dock) dock.updateState(msg.state);
          picker.setActive(msg.state.pickerActive);
          sendResponse({ ok: true });
          break;

        case 'INBOUND_SYNC_COMMAND':
          if (!engine.getAttachedVideo()) hunter.scanDocument();
          if (engine.getAttachedVideo()) {
            engine.applyRemoteSync(msg.payload);
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false });
          }
          break;

        case 'QUERY_LIVE_VIDEO_STATE': {
          const v = engine.getAttachedVideo();
          if (v) {
            sendResponse({
              ok: true,
              currentTime: v.currentTime,
              isPlaying: !v.paused,
              duration: v.duration || 0,
            });
          } else {
            sendResponse({ ok: false });
          }
          break;
        }

        case 'PICKER_MODE_BROADCAST':
          picker.setActive(msg.active);
          sendResponse({ ok: true });
          break;

        case 'FORCE_LOCK_BEST_VIDEO':
          sendResponse({ ok: !isTop ? hunter.forceLockBestAvailable() : false });
          break;

        case 'TOGGLE_DOCK_VISIBILITY':
          if (isTop && dock) dock.toggleVisibility();
          sendResponse({ ok: true });
          break;
      }
      return false;
    }
  );
})();
