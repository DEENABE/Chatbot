import { ipcMain } from "electron";

import * as SessionStore from "../services/SessionStore.js";

export function registerAuthIPCHandlers() {

    /**
     * Get Session Token
     */
    ipcMain.handle("auth:get-token", async () => {

        try {

            return SessionStore.getToken();

        } catch (err) {

            console.error(err);

            return null;

        }

    });


    /**
     * Set Session Token
     */
    ipcMain.handle("auth:set-token", async (_, payload = {}) => {

        try {

            const { token = null } = payload;

            SessionStore.setToken(token);

            return true;

        } catch (err) {

            console.error(err);

            return false;

        }

    });


    /**
     * Clear Session Token
     */
    ipcMain.handle("auth:clear-token", async () => {

        try {

            SessionStore.clearToken();

            return true;

        } catch (err) {

            console.error(err);

            return false;

        }

    });

}
