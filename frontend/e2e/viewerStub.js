// A stand-in for easi.run's viewer SDK (ADR-0126), served at /api/browser/viewer.js to the end-to-end tests and the
// owner's preview: a canvas on one stream that shows one picture once the far end says so, and sends the person's
// pointer and keys only while control was asked for and the far end grants it.
export const LeaseHolder = { None: 0, Agent: 1, You: 2, Other: 3 };

export function mountViewer(container, options) {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 800;
  canvas.style.width = '100%';
  canvas.tabIndex = 0;
  container.append(canvas);
  const socket = new WebSocket(options.url);
  let control = false;
  let ended = false;
  const send = (kind) => {
    if (control && socket.readyState === 1) socket.send(kind);
  };
  const pointer = () => {
    canvas.focus();
    send('pointer');
  };
  const key = () => send('key');
  canvas.addEventListener('pointerdown', pointer);
  canvas.addEventListener('keydown', key);
  socket.addEventListener('message', () => {
    const context = canvas.getContext('2d');
    context.fillStyle = 'rgb(40, 120, 200)';
    context.fillRect(0, 0, canvas.width, canvas.height);
    options.onLease?.({ holder: options.features.keyboard_pointer ? LeaseHolder.You : LeaseHolder.Agent });
    options.onPicture?.();
  });
  socket.addEventListener('close', () => {
    if (!ended) options.onError?.(new Error('the stream ended'), true);
    ended = true;
  });
  return {
    setControl(enabled) {
      control = enabled;
    },
    close() {
      ended = true;
      canvas.remove();
      socket.close();
    },
  };
}
