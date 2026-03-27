import { io } from 'socket.io-client';
import { ENV } from '../config/env';

let socket         = null;
let storedUid      = null;
let heartbeatTimer = null;
let _navigationRef = null;

// ✅ Stores callerUids whose calls were cancelled before screen mounted
// This is the KEY fix — survives the navigation transition gap
const cancelledCallsCache = new Set();

export const setNavigationRef = (ref) => { _navigationRef = ref; };

export const wasCallCancelled  = (callerUid) => cancelledCallsCache.has(callerUid);
export const clearCallCache    = (callerUid) => cancelledCallsCache.delete(callerUid);

const getCurrentRoute = () => {
  try { return _navigationRef?.getCurrentRoute?.()?.name ?? null; }
  catch { return null; }
};

const startHeartbeat = () => {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (socket?.connected) socket.emit('ping');
  }, 20000);
};

const stopHeartbeat = () => {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
};

export const connectSocket = (uid) => {
  storedUid = uid;

  if (socket?.connected) return socket;

  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }

  socket = io(ENV.BASE_URL, {
    transports:           ['polling'],
    upgrade:              false,
    reconnection:         true,
    reconnectionDelay:    2000,
    reconnectionDelayMax: 10000,
    reconnectionAttempts: 50,
    timeout:              30000,
    forceNew:             true,
    withCredentials:      false,
  });

  socket.on('connect', () => {
    console.log('✅ Socket connected:', socket.id);
    socket.emit('user_online', uid);
    startHeartbeat();
  });

  socket.on('disconnect', (reason) => {
    console.log('❌ Disconnected:', reason);
    stopHeartbeat();
    if (reason === 'io server disconnect' || reason === 'transport error') {
      setTimeout(() => socket?.connect(), 1000);
    }
  });

  socket.on('connect_error', (err) => {
    console.log('❌ Socket error:', err.message);
  });

  socket.on('reconnect', (attempt) => {
    console.log('✅ Reconnected after', attempt, 'attempts');
    socket.emit('user_online', storedUid);
    startHeartbeat();
    socket.emit('rejoin_online', storedUid);
  });

  socket.on('reconnect_failed', () => {
    console.log('❌ All reconnection attempts failed');
  });

  // ── Incoming call ──────────────────────────────────────────────────────────
  socket.on('incoming_call', (data) => {
    console.log('📞 Incoming call:', data);

    if (!_navigationRef) {
      console.warn('navigationRef not set');
      return;
    }

    // ✅ Check cache BEFORE navigating — caller may have already cancelled
    // while this device was waking up / processing the incoming_call event
    if (cancelledCallsCache.has(data.callerUid)) {
      console.log('🚫 Call already cancelled before screen opened — ignoring');
      cancelledCallsCache.delete(data.callerUid);
      return;   // ← don't even open the screen
    }

    if (getCurrentRoute() === 'VideoCall') {
      console.warn('Already in a call — declining');
      declineCall({ callerUid: data.callerUid });
      return;
    }

    _navigationRef.navigate('VideoCall', {
      type:        'incoming',
      callType:    data.callType    || 'video',
      channelName: data.channelName || '',
      name:        data.callerName  || 'Unknown',
      image:       data.callerImage ?? null,
      callerUid:   data.callerUid,
      receiverUid: storedUid,
    });
  });

  // ── call_ended ─────────────────────────────────────────────────────────────
  socket.on('call_ended', (data) => {
    console.log('📴 call_ended received');

    // ✅ Always cache the callerUid so VideoCall can detect it on mount
    if (data?.callerUid) {
      cancelledCallsCache.add(data.callerUid);
      // Auto-clear after 30s to prevent memory leak
      setTimeout(() => cancelledCallsCache.delete(data.callerUid), 30_000);
    }

    if (getCurrentRoute() === 'VideoCall') {
      try {
        _navigationRef?.goBack?.();
      } catch {
        _navigationRef?.navigate?.('Home');
      }
    }
  });

  // ── call_already_ended (server validation reject) ──────────────────────────
  socket.on('call_already_ended', () => {
    console.log('📴 call_already_ended received');
    if (getCurrentRoute() === 'VideoCall') {
      try {
        _navigationRef?.goBack?.();
      } catch {
        _navigationRef?.navigate?.('Home');
      }
    }
  });

  return socket;
};

export const disconnectSocket = () => {
  stopHeartbeat();
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket    = null;
    storedUid = null;
  }
};

export const getSocket   = () => socket;
export const isConnected = () => socket?.connected || false;

export const sendMessage      = (data) => {
  if (socket?.connected) { socket.emit('send_message', data); return true; }
  return false;
};

export const loadHistory      = (chatId, page = 1) => socket?.connected && socket.emit('load_history', { chatId, page });
export const sendTyping       = (senderUid, receiverUid, isTyping) => socket?.connected && socket.emit('typing', { senderUid, receiverUid, isTyping });
export const markRead         = (chatId, readerUid) => socket?.connected && socket.emit('mark_read', { chatId, readerUid });

export const sendOffer        = ({ to, offer })     => socket?.emit('webrtc_offer',         { to, offer });
export const sendAnswer       = ({ to, answer })    => socket?.emit('webrtc_answer',        { to, answer });
export const sendIceCandidate = ({ to, candidate }) => socket?.emit('webrtc_ice_candidate', { to, candidate });

export const callUser         = (data) => socket?.emit('call_user',     data);
export const acceptCall       = (data) => socket?.emit('call_accepted', data);
export const declineCall      = (data) => socket?.emit('call_declined', data);
export const endCall          = (data) => socket?.emit('call_ended',    data);