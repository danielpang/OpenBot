import { packageName } from '@openbots/shared';

export const PACKAGE_NAME = packageName('computer-agent');

export { createApp, type AppDeps } from './app.js';
export { loadConfig, AGENT_ENV_VARS, type AgentConfig } from './config.js';
export { ScreenManager, screenInfo, profileDir, DISPLAY_BASE } from './screens.js';
export { BrowserPool } from './browser.js';
export { Wallpaper, wallpaperColors, wallpaperLuminance } from './wallpaper.js';
export { attachWebSockets } from './ws.js';
export * from './protocol.js';
