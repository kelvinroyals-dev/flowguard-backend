// Socket.io real-time layer — singleton + typed emit helpers
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

let io = null;

function init(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: ['https://app.flowguard.ng', 'https://neon.flowguard.ng', 'https://flowguard.ng'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  // Optional JWT auth on connect (token passed in handshake auth or query).
  // Non-fatal: unauthenticated sockets can still receive public broadcasts,
  // but we attach user info when present for room scoping.
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token
                 || socket.handshake.query?.token
                 || (socket.handshake.headers?.authorization || '').replace('Bearer ', '');
      if (token) {
        socket.user = jwt.verify(token, process.env.JWT_SECRET);
      }
    } catch (_) { /* ignore bad token; connect anyway */ }
    next();
  });

  io.on('connection', (socket) => {
    // client emits: socket.emit('subscribe', 'reports')
    socket.on('subscribe', (room) => {
      if (typeof room === 'string' && room.length < 40) socket.join(room);
    });
    socket.on('unsubscribe', (room) => {
      if (typeof room === 'string') socket.leave(room);
    });
  });

  console.log('✅ Socket.io real-time layer active');
  return io;
}

// Generic emit — to a room if given, else broadcast to all
function emit(event, payload, room) {
  if (!io) return;
  (room ? io.to(room) : io).emit(event, payload || {});
}

// Named helpers matching the frontend's listeners
const events = {
  alertNew:      (a)  => emit('alert:new', a, 'alerts'),
  alertResolved: (a)  => emit('alert:resolved', a, 'alerts'),
  reportNew:     (r)  => emit('report:new', r, 'reports'),
  reportUpdated: (r)  => emit('report:updated', r, 'reports'),
  reportSent:    (r)  => emit('report:sent', r, 'reports'),
  sensorUpdate:  (s)  => emit('sensor:update', s, 'sensors'),
  teamStatus:    (t)  => emit('team:status', t, 'teams'),
};

module.exports = { init, emit, events, getIO: () => io };
