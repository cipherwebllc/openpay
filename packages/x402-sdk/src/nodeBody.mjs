// WHATWG body for the default transport's IncomingMessage. Internal: index.mjs does not export it.
//
// Readable.toWeb is not used. On Node 22 (the engines minimum) its adapter enqueues a chunk the
// response had already buffered after the executor cancels an over-cap body, and the
// "Controller is already closed" TypeError escapes as an uncaught exception in the buyer's
// process. Here a chunk, end, error or close after the body was cancelled or settled is dropped.
export function nodeResponseBody(response) {
  let settled = false;
  return new ReadableStream({
    start(controller) {
      const settle = (error) => {
        if (settled) return;
        settled = true;
        if (error) controller.error(error);
        else controller.close();
      };
      response.on('data', (chunk) => {
        if (settled) return;
        // Copy so the chunk is detached from Node's shared Buffer pool.
        controller.enqueue(new Uint8Array(chunk));
        if (controller.desiredSize <= 0) response.pause();
      });
      response.on('end', () => settle());
      // Stays attached after settling, so a socket error that arrives after the body was
      // cancelled or finished is not an unhandled 'error' event.
      response.on('error', (error) => settle(error));
      // 'close' without 'end' or 'error': the connection went away mid-body.
      response.on('close', () => settle(new Error('payment response closed before the body ended')));
    },
    pull() {
      response.resume();
    },
    cancel() {
      settled = true;
      response.destroy();
    },
  });
}
