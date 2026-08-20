// Not currently wired into app.js (app.js has its own inline handler with
// the same contract) — hardened anyway so it's never a footgun if it's ever
// mounted: only a deliberately-thrown 4xx error (ValidationError and
// friends, see lib/validate.js) gets its message echoed back. Anything else
// is logged server-side only, never returned in the response.
export function errorHandler(err, req, res, _next) {
  console.error(`[${req.id || '-'}]`, err);
  if (Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }
  res.status(500).json({ error: 'Unexpected local server error.' });
}
