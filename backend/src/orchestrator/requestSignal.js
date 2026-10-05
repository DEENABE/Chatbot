/** Express has no built-in request.signal. Abort on disconnected response. */
export function executionRequestSignal(request, response) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const close = () => { if (!response.writableEnded) abort(); cleanup(); };
  const cleanup = () => {
    request.off('aborted', abort);
    response.off('close', close);
    response.off('finish', cleanup);
  };
  request.once('aborted', abort);
  response.once('close', close);
  response.once('finish', cleanup);
  return controller.signal;
}
