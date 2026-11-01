import { WebSocket } from 'ws';

export type SyncActionType = 'PLAY' | 'PAUSE' | 'SEEK' | 'HEARTBEAT' | 'BUFFERING';

export interface SyncActionPayload {
  type: SyncActionType;
  time: number;
  playbackRate?: number;
  hostTimestamp: number;
  forceSeek?: boolean;
}

export interface HostMediaInfo {
  url: string;
  title: string;
  duration: number;
}

export interface ParticipantInfo {
  id: string;
  nickname: string;
  isHost: boolean;
  joinedAt: number;
}

export interface RoomPlaybackState {
  isPlaying: boolean;
  currentTime: number;
  playbackRate: number;
  lastUpdatedTimestamp: number;
  hostId: string;
  hostMedia?: HostMediaInfo;
}

export type ClientToServerMessage =
  | {
      action: 'CREATE_ROOM';
      nickname?: string;
      initialState?: {
        currentTime: number;
        isPlaying: boolean;
        hostMedia?: HostMediaInfo;
      };
    }
  | {
      action: 'JOIN_ROOM';
      roomId: string;
      nickname?: string;
    }
  | { action: 'LEAVE_ROOM' }
  | { action: 'SYNC_ACTION'; payload: SyncActionPayload }
  | { action: 'UPDATE_MEDIA'; media: HostMediaInfo }
  | { action: 'REQUEST_SYNC' }
  | { action: 'PING' };

export type ServerToClientMessage =
  | { event: 'CONNECTED'; clientId: string }
  | {
      event: 'ROOM_CREATED';
      roomId: string;
      clientId: string;
      state: RoomPlaybackState;
      participants: ParticipantInfo[];
    }
  | {
      event: 'ROOM_JOINED';
      roomId: string;
      clientId: string;
      state: RoomPlaybackState;
      participants: ParticipantInfo[];
    }
  | {
      event: 'ROOM_UPDATED';
      roomId: string;
      participants: ParticipantInfo[];
      hostId: string;
      hostMedia?: HostMediaInfo;
    }
  | {
      event: 'SYNC_ACTION';
      senderId: string;
      senderNickname: string;
      payload: SyncActionPayload;
    }
  | { event: 'REQUEST_HOST_STATE' }
  | { event: 'ROOM_LEFT' }
  | { event: 'ERROR'; code: string; message: string }
  | { event: 'PONG'; serverTimestamp: number };

export interface TrackedClient {
  id: string;
  ws: WebSocket;
  nickname: string;
  roomId: string | null;
  isAlive: boolean;
  joinedAt: number;
}

export interface Room {
  id: string;
  hostId: string;
  clients: Map<string, TrackedClient>;
  playbackState: RoomPlaybackState;
  createdAt: number;
}
