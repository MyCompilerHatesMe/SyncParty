import crypto from 'crypto';
import { WebSocket } from 'ws';
import {
  HostMediaInfo,
  ParticipantInfo,
  Room,
  RoomPlaybackState,
  ServerToClientMessage,
  SyncActionPayload,
  TrackedClient,
} from './types';

// no 0/O or 1/I so people don't misread codes
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;

export class RoomManager {
  private rooms = new Map<string, Room>();
  private clients = new Map<string, TrackedClient>();

  registerClient(ws: WebSocket): TrackedClient {
    const id = crypto.randomUUID();
    const client: TrackedClient = {
      id,
      ws,
      nickname: `user-${id.slice(0, 4)}`,
      roomId: null,
      isAlive: true,
      joinedAt: Date.now(),
    };
    this.clients.set(id, client);
    return client;
  }

  getClient(id: string) {
    return this.clients.get(id);
  }

  getAllClients() {
    return this.clients.values();
  }

  getStats() {
    return {
      activeRooms: this.rooms.size,
      connectedClients: this.clients.size,
    };
  }

  private genCode(): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      const bytes = crypto.randomBytes(CODE_LEN);
      let code = '';
      for (let i = 0; i < CODE_LEN; i++) {
        code += ALPHABET[bytes[i] % ALPHABET.length];
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('ran out of room codes somehow');
  }

  createRoom(
    clientId: string,
    nickname?: string,
    initialState?: { currentTime: number; isPlaying: boolean; hostMedia?: HostMediaInfo }
  ): Room {
    const client = this.clients.get(clientId);
    if (!client) throw new Error('client not found');

    if (client.roomId) this.leaveRoom(clientId);
    if (nickname?.trim()) client.nickname = nickname.trim().slice(0, 24);

    const roomId = this.genCode();
    const now = Date.now();

    const playbackState: RoomPlaybackState = {
      isPlaying: initialState?.isPlaying ?? false,
      currentTime: initialState?.currentTime ?? 0,
      playbackRate: 1.0,
      lastUpdatedTimestamp: now,
      hostId: client.id,
      hostMedia: initialState?.hostMedia,
    };

    const room: Room = {
      id: roomId,
      hostId: client.id,
      clients: new Map([[client.id, client]]),
      playbackState,
      createdAt: now,
    };

    client.roomId = roomId;
    client.joinedAt = now;
    this.rooms.set(roomId, room);

    return room;
  }

  joinRoom(clientId: string, rawRoomId: string, nickname?: string): Room {
    const client = this.clients.get(clientId);
    if (!client) throw new Error('client not found');

    const roomId = rawRoomId.trim().toUpperCase();
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`room ${roomId} doesn't exist`);

    if (client.roomId && client.roomId !== roomId) {
      this.leaveRoom(clientId);
    }

    if (nickname?.trim()) client.nickname = nickname.trim().slice(0, 24);

    client.roomId = roomId;
    client.joinedAt = Date.now();
    room.clients.set(client.id, client);

    this.broadcastToRoom(
      roomId,
      {
        event: 'ROOM_UPDATED',
        roomId,
        participants: this.getParticipantList(room),
        hostId: room.hostId,
        hostMedia: room.playbackState.hostMedia,
      },
      client.id
    );

    return room;
  }

  updateHostMedia(clientId: string, media: HostMediaInfo) {
    const client = this.clients.get(clientId);
    if (!client || !client.roomId) return;

    const room = this.rooms.get(client.roomId);
    if (!room || room.hostId !== clientId) return;

    room.playbackState.hostMedia = media;

    this.broadcastToRoom(room.id, {
      event: 'ROOM_UPDATED',
      roomId: room.id,
      participants: this.getParticipantList(room),
      hostId: room.hostId,
      hostMedia: room.playbackState.hostMedia,
    });
  }

  requestHostSync(clientId: string) {
    const client = this.clients.get(clientId);
    if (!client || !client.roomId) return;

    const room = this.rooms.get(client.roomId);
    if (!room) return;

    const host = room.clients.get(room.hostId);
    if (host && host.id !== clientId) {
      // ask the host for their live timestamp
      this.sendToClient(host, { event: 'REQUEST_HOST_STATE' });
    } else {
      // fallback to server's extrapolated state
      const st = this.getExtrapolatedPlaybackState(room);
      this.sendToClient(client, {
        event: 'SYNC_ACTION',
        senderId: room.hostId,
        senderNickname: host?.nickname || 'host',
        payload: {
          type: st.isPlaying ? 'PLAY' : 'PAUSE',
          time: st.currentTime,
          playbackRate: st.playbackRate,
          hostTimestamp: Date.now(),
          forceSeek: true,
        },
      });
    }
  }

  handleSyncAction(clientId: string, payload: SyncActionPayload) {
    const client = this.clients.get(clientId);
    if (!client || !client.roomId) {
      this.sendToClient(client, {
        event: 'ERROR',
        code: 'NOT_IN_ROOM',
        message: 'not in a room',
      });
      return;
    }

    const room = this.rooms.get(client.roomId);
    if (!room) {
      client.roomId = null;
      return;
    }

    const now = Date.now();

    if (payload.type === 'PLAY') {
      room.playbackState.isPlaying = true;
      room.playbackState.currentTime = payload.time;
      room.playbackState.lastUpdatedTimestamp = now;
    } else if (payload.type === 'PAUSE' || payload.type === 'BUFFERING') {
      room.playbackState.isPlaying = false;
      room.playbackState.currentTime = payload.time;
      room.playbackState.lastUpdatedTimestamp = now;
    } else if (payload.type === 'SEEK') {
      room.playbackState.currentTime = payload.time;
      room.playbackState.lastUpdatedTimestamp = now;
    } else if (payload.type === 'HEARTBEAT' && client.id === room.hostId) {
      room.playbackState.currentTime = payload.time;
      room.playbackState.lastUpdatedTimestamp = now;
    }

    if (payload.playbackRate !== undefined) {
      room.playbackState.playbackRate = payload.playbackRate;
    }

    this.broadcastToRoom(
      room.id,
      {
        event: 'SYNC_ACTION',
        senderId: client.id,
        senderNickname: client.nickname,
        payload: {
          ...payload,
          hostTimestamp: payload.hostTimestamp || now,
        },
      },
      client.id
    );
  }

  getExtrapolatedPlaybackState(room: Room): RoomPlaybackState {
    const state = { ...room.playbackState };
    if (state.isPlaying) {
      const dt = Math.max(0, (Date.now() - state.lastUpdatedTimestamp) / 1000);
      state.currentTime += dt * (state.playbackRate || 1.0);
      state.lastUpdatedTimestamp = Date.now();
    }
    return state;
  }

  getParticipantList(room: Room): ParticipantInfo[] {
    return Array.from(room.clients.values())
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((c) => ({
        id: c.id,
        nickname: c.nickname,
        isHost: c.id === room.hostId,
        joinedAt: c.joinedAt,
      }));
  }

  leaveRoom(clientId: string) {
    const client = this.clients.get(clientId);
    if (!client || !client.roomId) return;

    const roomId = client.roomId;
    const room = this.rooms.get(roomId);
    client.roomId = null;
    if (!room) return;

    room.clients.delete(clientId);

    // nuke room if empty
    if (room.clients.size === 0) {
      this.rooms.delete(roomId);
      return;
    }

    // host left, hand it to whoever's been here longest
    if (room.hostId === clientId) {
      const next = Array.from(room.clients.values()).sort((a, b) => a.joinedAt - b.joinedAt)[0];
      if (next) {
        room.hostId = next.id;
        room.playbackState.hostId = next.id;
      }
    }

    this.broadcastToRoom(roomId, {
      event: 'ROOM_UPDATED',
      roomId,
      participants: this.getParticipantList(room),
      hostId: room.hostId,
      hostMedia: room.playbackState.hostMedia,
    });
  }

  removeClient(clientId: string) {
    this.leaveRoom(clientId);
    this.clients.delete(clientId);
  }

  sendToClient(client: TrackedClient | undefined, message: ServerToClientMessage) {
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }

  broadcastToRoom(roomId: string, message: ServerToClientMessage, excludeId?: string) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const raw = JSON.stringify(message);
    for (const [id, member] of room.clients.entries()) {
      if (excludeId && id === excludeId) continue;
      if (member.ws.readyState === WebSocket.OPEN) {
        member.ws.send(raw);
      }
    }
  }
}
