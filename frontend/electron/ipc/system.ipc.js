import { ipcMain } from "electron";

import * as NotificationManager from "../managers/NotificationManager.js";
import * as FileService from "../services/FileService.js";
import * as WindowManager from "../managers/WindowManager.js";
import * as TextToSpeech from "../services/TextToSpeech.js";

export function registerSystemIPCHandlers() {

    /**
     * Desktop Notification
     */
    ipcMain.handle("show-notification", async (_, payload = {}) => {

        const {
            title = "",
            body = ""
        } = payload;

        return NotificationManager.showNotification(title, body);

    });


    /**
     * Speak Text
     */
    ipcMain.handle("tts:speak", async (_, payload = {}) => {

        try {

            // speed, not rate/volume: say's Windows backend takes a speed
            // multiplier and offers no volume control, so anything else was
            // being accepted and silently dropped.
            const {
                text = "",
                speed = 1,
                voice = null
            } = payload;

            return await TextToSpeech.speak(text, {
                speed,
                voice
            });

        } catch (err) {

            console.error("TTS Error:", err);

            return false;

        }

    });


    /**
     * Stop Speaking
     */
    ipcMain.handle("tts:stop", async () => {

        try {

            await TextToSpeech.stop();

            return true;

        } catch (err) {

            console.error(err);

            return false;

        }

    });


    /**
     * Get Installed Voices
     */
    ipcMain.handle("tts:voices", async () => {

        try {

            return await TextToSpeech.getVoices();

        } catch {

            return [];

        }

    });


    /**
     * Save File
     */
    ipcMain.handle("save-file", async (_, payload = {}) => {

        try {

            const {
                name,
                base64
            } = payload;

            const win = WindowManager.getMainWindow();

            return await FileService.saveBase64File(
                win,
                name,
                base64
            );

        } catch (err) {

            console.error(err);

            return null;

        }

    });

}