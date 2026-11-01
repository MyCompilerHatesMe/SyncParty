import { WebSocket } from 'ws';
import { startServer } from '../src/index';
import { ServerToClientMessage } from '../src/types';

const TEST_PORT = 8999;

function connectClient(url: string): Promise<{
  ws: WebSocket;
  messages: ServerToClientMessage[];
  waitForEvent: <T extends ServerToClientMessage['event']>(
    event: T
  ) => Promise<Extract<ServerToClientMessage, { event: T }>>;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: ServerToClientMessage[] = [];
    const waiters: Array<{ event: string; resolve: (msg: any) => void }> = [];

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerToClientMessage;
      messages.push(msg);
      const idx = waiters.findIndex((w) => w.event === msg.event);
      if (idx !== -1) {
        const [w] = waiters.splice(idx, 1);
        w.resolve(msg);
      }
    });

    ws.on('open', () => {
      resolve({
        ws,
        messages,
        waitForEvent: (event) => {
          const existing = messages.find((m) => m.event === event);
          if (existing) {
            messages.splice(messages.indexOf(existing), 1);
            return Promise.resolve(existing as any);
          }
          return new Promise((res) => waiters.push({ event, resolve: res }));
        },
      });
    });

    ws.on('error', reject);
  });
}

async function runTests() {
  const { server, wss, roomManager } = startServer(TEST_PORT);
  const url = `ws://localhost:${TEST_PORT}`;

  try {
    const a = await connectClient(url);
    const b = await connectClient(url);

    await a.waitForEvent('CONNECTED');
    await b.waitForEvent('CONNECTED');

    a.ws.send(
      JSON.stringify({
        action: 'CREATE_ROOM',
        nickname: 'alice',
        initialState: { currentTime: 42.5, isPlaying: false },
      })
    );

    const created = await a.waitForEvent('ROOM_CREATED');
    const roomId = created.roomId;
    if (roomId.length !== 6) throw new Error(`bad room code: ${roomId}`);

    b.ws.send(JSON.stringify({ action: 'JOIN_ROOM', roomId, nickname: 'bob' }));

    const joined = await b.waitForEvent('ROOM_JOINED');
    if (joined.state.currentTime !== 42.5 || joined.participants.length !== 2) {
      throw new Error('join state wrong');
    }
    await a.waitForEvent('ROOM_UPDATED');

    a.ws.send(
      JSON.stringify({
        action: 'SYNC_ACTION',
        payload: { type: 'PLAY', time: 120.0, hostTimestamp: Date.now() },
      })
    );

    const sync = await b.waitForEvent('SYNC_ACTION');
    if (sync.payload.type !== 'PLAY' || sync.payload.time !== 120.0) {
      throw new Error('sync mismatch');
    }

    // host leaves, bob should get promoted
    a.ws.close();
    const afterLeave = await b.waitForEvent('ROOM_UPDATED');
    if (afterLeave.participants.length !== 1 || !afterLeave.participants[0].isHost) {
      throw new Error('host migration broke');
    }

    // last peer leaves, room should get nuked
    b.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    if (roomManager.getStats().activeRooms !== 0) {
      throw new Error('room leak');
    }

    console.log('all tests passed');
  } finally {
    wss.close();
    server.close();
  }
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
