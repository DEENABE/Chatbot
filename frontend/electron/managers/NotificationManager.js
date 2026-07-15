import { Notification } from 'electron';

export function showNotification(title, body) {
  try {
    new Notification({ title, body }).show();
  } catch (err) {
    console.error('Failed to show system notification:', err);
  }
}
