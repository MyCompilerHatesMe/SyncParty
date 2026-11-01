import { HostMediaInfo, ParticipantInfo, SyncActionPayload } from './protocol';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type VideoLockMode = 'none' | 'auto' | 'manual';

export interface VideoCandidateMetadata {
  duration: number;
  currentTime: number;
  isPlaying: boolean;
  width: number;
  height: number;
  frameUrl: string;
  lockMode: 'auto' | 'manual';
}

export interface TabSyncState {
  connectionStatus: ConnectionStatus;
  serverUrl: string;
  roomId: string | null;
  clientId: string | null;
  nickname: string;
  isHost: boolean;
  participants: ParticipantInfo[];
  hostMedia: HostMediaInfo | null;
  pageUrl: string;
  pageTitle: string;
  videoLocked: boolean;
  activeVideoFrameId: number | null;
  videoMetadata: VideoCandidateMetadata | null;
  pickerActive: boolean;
  lastError: string | null;
  lastSyncNotification: string | null;
}

export type ContentToBackgroundMessage =
  | { type: 'UI_GET_STATE'; pageUrl?: string; pageTitle?: string }
  | {
      type: 'UI_CREATE_ROOM';
      nickname?: string;
      serverUrl?: string;
      pageUrl?: string;
      pageTitle?: string;
    }
  | {
      type: 'UI_JOIN_ROOM';
      roomId: string;
      nickname?: string;
      serverUrl?: string;
      pageUrl?: string;
      pageTitle?: string;
    }
  | { type: 'UI_LEAVE_ROOM' }
  | { type: 'UI_REQUEST_RESYNC' }
  | { type: 'UI_UPDATE_SERVER_URL'; serverUrl: string }
  | { type: 'UI_TOGGLE_PICKER'; active?: boolean }
  | { type: 'PICKER_FORCE_SCAN_FRAMES' }
  | { type: 'VIDEO_LOCKED'; metadata: VideoCandidateMetadata }
  | { type: 'VIDEO_STATE_REPORT'; currentTime: number; duration: number; isPlaying: boolean }
  | { type: 'VIDEO_UNLOCKED' }
  | { type: 'OUTBOUND_VIDEO_EVENT'; payload: SyncActionPayload };

export type BackgroundToContentMessage =
  | { type: 'STATE_UPDATED'; state: TabSyncState }
  | { type: 'INBOUND_SYNC_COMMAND'; senderNickname: string; payload: SyncActionPayload }
  | { type: 'QUERY_LIVE_VIDEO_STATE' }
  | { type: 'PICKER_MODE_BROADCAST'; active: boolean }
  | { type: 'FORCE_LOCK_BEST_VIDEO' }
  | { type: 'TOGGLE_DOCK_VISIBILITY' };
