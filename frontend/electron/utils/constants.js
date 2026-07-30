// Keep BUBBLE_SIZE in sync with the rendered bubble in FloatingBubble.jsx
// (68px avatar + 12px bottom margin). A larger window than the visible bubble
// leaves a transparent dead zone that swallows clicks and flickers hover.
export const BUBBLE_SIZE = 80;
export const CHAT_WIDTH = 420;
export const CHAT_HEIGHT = 680;
// 5 quick actions (40px + 8px gap) + the bubble itself. Oversizing this makes
// the invisible window area trigger stray mouse-leave events.
export const TOOLBAR_HEIGHT = 320;
export const BACKEND_PORT = 3001;
export const HEALTH_CHECK_URL = `http://127.0.0.1:${BACKEND_PORT}/api/health`;
