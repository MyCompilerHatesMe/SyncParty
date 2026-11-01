import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { RoomManager } from './roomManager';
import { ClientToServerMessage } from './types';

const PORT = Number(process.env.PORT) || 8080;
const PING_MS = 30_000;

export function startServer(port: number = PORT) {
  const roomManager = new RoomManager();

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(
        JSON.stringify({
          status: 'ok',
          uptime: process.uptime(),
          ...roomManager.getStats(),
        })
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('syncparty relay up');
  });

  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws: WebSocket) => {
    const client = roomManager.registerClient(ws);

    roomManager.sendToClient(client, {
      event: 'CONNECTED',
      clientId: client.id,
    });

    ws.on('pong', () => {
      client.isAlive = true;
    });

    ws.on('message', (rawData) => {
      client.isAlive = true;
      let msg: ClientToServerMessage;

      try {
        msg = JSON.parse(rawData.toString());
      } catch {
        roomManager.sendToClient(client, {
          event: 'ERROR',
          code: 'INVALID_JSON',
          message: 'bad json',
        });
        return;
      }

      try {
        switch (msg.action) {
          case 'CREATE_ROOM': {
            const room = roomManager.createRoom(client.id, msg.nickname, msg.initialState);
            roomManager.sendToClient(client, {
              event: 'ROOM_CREATED',
              roomId: room.id,
              clientId: client.id,
              state: roomManager.getExtrapolatedPlaybackState(room),
              participants: roomManager.getParticipantList(room),
            });
            break;
          }

          case 'JOIN_ROOM': {
            if (!msg.roomId || typeof msg.roomId !== 'string') {
              roomManager.sendToClient(client, {
                event: 'ERROR',
                code: 'INVALID_ROOM_CODE',
                message: 'need a 6 char room code',
              });
              return;
            }
            const room = roomManager.joinRoom(client.id, msg.roomId, msg.nickname);
            roomManager.sendToClient(client, {
              event: 'ROOM_JOINED',
              roomId: room.id,
              clientId: client.id,
              state: roomManager.getExtrapolatedPlaybackState(room),
              participants: roomManager.getParticipantList(room),
            });
            break;
          }

          case 'LEAVE_ROOM': {
            roomManager.leaveRoom(client.id);
            roomManager.sendToClient(client, { event: 'ROOM_LEFT' });
            break;
          }

          case 'SYNC_ACTION': {
            if (!msg.payload || typeof msg.payload.time !== 'number') return;
            roomManager.handleSyncAction(client.id, msg.payload);
            break;
          }

          case 'UPDATE_MEDIA': {
            if (!msg.media || typeof msg.media.url !== 'string') return;
            roomManager.updateHostMedia(client.id, msg.media);
            break;
          }

          case 'REQUEST_SYNC': {
            roomManager.requestHostSync(client.id);
            break;
          }

          case 'PING': {
            roomManager.sendToClient(client, {
              event: 'PONG',
              serverTimestamp: Date.now(),
            });
            break;
          }

          default: {
            roomManager.sendToClient(client, {
              event: 'ERROR',
              code: 'UNKNOWN_ACTION',
              message: 'unknown action',
            });
          }
        }
      } catch (err) {
        roomManager.sendToClient(client, {
          event: 'ERROR',
          code: 'OPERATION_FAILED',
          message: err instanceof Error ? err.message : 'failed',
        });
      }
    });

    ws.on('close', () => roomManager.removeClient(client.id));
    ws.on('error', () => roomManager.removeClient(client.id));
  });

  // kill dead sockets every 30s
  const pingTimer = setInterval(() => {
    for (const client of roomManager.getAllClients()) {
      if (!client.isAlive) {
        client.ws.terminate();
        roomManager.removeClient(client.id);
        continue;
      }
      client.isAlive = false;
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.ping();
      }
    }
  }, PING_MS);

  wss.on('close', () => clearInterval(pingTimer));

  server.listen(port, () => {
    console.log(`relay listening on ws://localhost:${port}`);
  });

  return { server, wss, roomManager };
}

if (require.main === module) {
  startServer(PORT);
}
