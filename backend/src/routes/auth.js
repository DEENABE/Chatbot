import { Router } from 'express';
import { registerUser, loginUser, getUserById, updateUserProfile, changePassword, resetPassword } from '../services/authService.js';
import { createSession, revokeSession } from '../services/sessionService.js';
import { authLimiter } from '../middleware/rateLimiter.js';
import { requireAuth } from '../middleware/auth.js';

export const authRouter = Router();

// Register user — auto-issues a session, same as login, so the client can go
// straight into the app without a separate round trip.
authRouter.post('/register', async (request, response) => {
  try {
    const { username, displayName, password } = request.body || {};
    const user = await registerUser(username, displayName, password);
    const { token, expiresAt } = createSession(user.id);
    response.status(201).json({ user, token, expiresAt });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

// Login user — rate-limited: scryptSync's cost alone was the only thing
// slowing down a password-guessing script before this.
authRouter.post('/login', authLimiter, async (request, response) => {
  try {
    const { username, password } = request.body || {};
    const user = await loginUser(username, password);
    const { token, expiresAt } = createSession(user.id);
    response.json({ user, token, expiresAt });
  } catch (error) {
    response.status(401).json({ error: error.message });
  }
});

// Log out — revokes only the session making this call, not every device.
authRouter.post('/logout', requireAuth, (request, response) => {
  revokeSession(request.sessionToken);
  response.json({ ok: true });
});

// Get current user profile
authRouter.get('/me', requireAuth, async (request, response, next) => {
  try {
    const user = await getUserById(request.userId);
    if (!user) {
      return response.status(401).json({ error: 'User not found.' });
    }
    response.json({ user });
  } catch (error) {
    next(error);
  }
});

// Change password (authenticated — requires current password). Changing it
// revokes every session for the account (see authService), so this route
// re-issues a fresh token for the device that just made the change —
// otherwise the caller would immediately lock itself out too.
authRouter.post('/change-password', requireAuth, async (request, response) => {
  try {
    const { currentPassword, newPassword } = request.body || {};
    await changePassword(request.userId, currentPassword, newPassword);
    const { token, expiresAt } = createSession(request.userId);
    response.json({ ok: true, token, expiresAt });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

// Reset password (offline recovery by username — no auth required). Rate
// limited since this is the more sensitive of the two: it needs no proof of
// identity beyond a username, so throttling attempts matters even more here.
authRouter.post('/reset-password', authLimiter, async (request, response) => {
  try {
    const { username, newPassword } = request.body || {};
    await resetPassword(username, newPassword);
    response.json({ ok: true });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

// Update profile settings
authRouter.patch('/profile', requireAuth, async (request, response, next) => {
  try {
    const { displayName, email, department, role } = request.body;
    const user = await updateUserProfile(request.userId, { displayName, email, department, role });
    response.json({ user });
  } catch (error) {
    next(error);
  }
});
