import { desktopCapturer } from 'electron';
import { logger } from '../utils/logger.js';

export async function captureScreen() {
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 1280, height: 720 }
    });

    const screenSource = sources.find(src => src.id.startsWith("screen:")) || sources[0];
    const screenshot = screenSource ? screenSource.thumbnail.toDataURL() : null;

    const windows = sources
      .filter(src => src.id.startsWith("window:"))
      .map(src => src.name)
      .filter(name => name && name !== "Chanakya AI" && name !== "Entire Screen" && name !== "Screen 1");

    return { image: screenshot, windows };
  } catch (err) {
    logger.error("Screen capture failed:", err);
    throw err;
  }
}

export async function getScreenSources() {
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 150, height: 100 }
    });
    return sources.map(src => ({
      id: src.id,
      name: src.name,
      thumbnail: src.thumbnail.toDataURL()
    }));
  } catch (err) {
    logger.error("Get screen sources failed:", err);
    throw err;
  }
}
