import { Router } from 'express';
import { registerUser, loginUser, getUserById, updateUserProfile, changePassword, resetPassword } from '../services/authService.js';

export const authRouter = Router();

// Register user
authRouter.post('/register', async (request, response) => {
  try {
    const { username, displayName, password } = request.body || {};
    const user = await registerUser(username, displayName, password);
    response.status(201).json({ user });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

// Login user
authRouter.post('/login', async (request, response) => {
  try {
    const { username, password } = request.body || {};
    const user = await loginUser(username, password);
    response.json({ user });
  } catch (error) {
    response.status(401).json({ error: error.message });
  }
});

// Get current user profile
authRouter.get('/me', async (request, response, next) => {
  try {
    const userId = request.headers['x-user-id'];
    if (!userId) {
      return response.status(401).json({ error: 'Not authenticated.' });
    }
    const user = await getUserById(userId);
    if (!user) {
      return response.status(401).json({ error: 'User not found.' });
    }
    response.json({ user });
  } catch (error) {
    next(error);
  }
});

// Change password (authenticated — requires current password)
authRouter.post('/change-password', async (request, response) => {
  try {
    const userId = request.headers['x-user-id'];
    const { currentPassword, newPassword } = request.body || {};
    if (!userId) {
      return response.status(401).json({ error: 'Not authenticated.' });
    }
    await changePassword(userId, currentPassword, newPassword);
    response.json({ ok: true });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

// Reset password (offline recovery by username — no auth required)
authRouter.post('/reset-password', async (request, response) => {
  try {
    const { username, newPassword } = request.body || {};
    await resetPassword(username, newPassword);
    response.json({ ok: true });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

// Update profile settings
authRouter.patch('/profile', async (request, response, next) => {
  try {
    const userId = request.headers['x-user-id'];
    const { displayName, email, department, role } = request.body;
    if (!userId) {
      return response.status(401).json({ error: 'Not authenticated.' });
    }
    const user = await updateUserProfile(userId, { displayName, email, department, role });
    response.json({ user });
  } catch (error) {
    next(error);
  }
});
