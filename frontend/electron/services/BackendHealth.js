import http from 'http';

export function waitForBackend(url, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      http.get(url, (res) => {
        if (res.statusCode === 200) resolve();
        else retry();
      }).on("error", retry);
    };
    const retry = () => {
      if (Date.now() - start > timeout) {
        reject(new Error("Backend did not start in time"));
        return;
      }
      setTimeout(check, 400);
    };
    check();
  });
}
