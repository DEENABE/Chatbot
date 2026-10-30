import http from 'node:http';
export function waitForBackend(url, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    let finished = false;
    const retry = () => {
      if (finished) return;
      if (Date.now() >= deadline) {
        finished = true;
        reject(new Error('The local service did not respond in time. See diagnostics.'));
      } else setTimeout(check, 250);
    };
    const check = () => {
      if (finished) return;
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode === 200) {
          finished = true;
          resolve();
        } else retry();
      });
      request.setTimeout(Math.max(1, Math.min(1000, deadline - Date.now())), () =>
        request.destroy(),
      );
      request.once('error', retry);
    };
    check();
  });
}
