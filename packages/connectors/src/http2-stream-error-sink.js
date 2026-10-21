import http2 from 'node:http2';

const SINK = Symbol.for('ai-center.http2-stream-error-sink');

// undici closes an idle HTTP/2 session with InformationalError('socket idle timeout').
// Node then destroys every ClientHttp2Stream the session still tracks. undici removes
// its own listener by function identity and leaves a one-shot noop only sometimes,
// so the second 'error' event exits the process. This is not an unhandledRejection.
export function absorbHttp2TeardownError() {
  // The listener itself is the fix. Re-throwing would exit the process again.
}

function attachSink(emitter) {
  if (!emitter || typeof emitter.on !== 'function' || emitter[SINK]) return emitter;
  emitter[SINK] = true;
  emitter.on('error', absorbHttp2TeardownError);
  return emitter;
}

export function http2StreamErrorSinkInstalled(target = http2) {
  return target?.connect?.[SINK] === true;
}

// Patch the shared node:http2 export. undici looks up http2.connect when the
// session is opened, so a client created after this call gets the listeners.
export function installHttp2StreamErrorSink(target = http2) {
  if (typeof target?.connect !== 'function' || target.connect[SINK]) return false;
  const connect = target.connect;
  function connectWithSink(...args) {
    const session = connect.apply(this, args);
    if (!session || session[SINK]) return session;
    const request = session.request;
    if (typeof request === 'function') {
      session.request = function requestWithSink(...requestArgs) {
        return attachSink(request.apply(this, requestArgs));
      };
    }
    return attachSink(session);
  }
  connectWithSink[SINK] = true;
  target.connect = connectWithSink;
  return true;
}
