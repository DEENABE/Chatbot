// Keep BUBBLE_SIZE in sync with the rendered bubble in FloatingBubble.jsx
// (68px avatar + 12px bottom margin). A larger window than the visible bubble
// leaves a transparent dead zone that swallows clicks and flickers hover.
export const BUBBLE_SIZE = 80;
export const CHAT_WIDTH = 420;
export const CHAT_HEIGHT = 680;
// Hover mode has to fit, bottom to top: the bubble (80), five quick actions
// (5x40 + gaps = 232), and the speech bubble Chanakya greets you with (~80).
// Oversizing this makes the invisible window area trigger stray mouse-leave
// events, so keep it just big enough.
export const TOOLBAR_HEIGHT = 400;
// The greeting needs room to read; the bubble window itself is only 80 wide.
// The window widens symmetrically on hover so the avatar does not visibly move.
export const HOVER_WIDTH = 300;
export const BACKEND_PORT = 3001;
export const HEALTH_CHECK_URL = `http://127.0.0.1:${BACKEND_PORT}/api/health`;
