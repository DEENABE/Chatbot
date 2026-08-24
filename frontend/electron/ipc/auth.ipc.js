import { ipcMain } from "electron";

import * as SessionStore from "../services/SessionStore.js";
import { isTrustedSender } from "../utils/ipcTrust.js";

export function registerAuthIPCHandlers() {

    /**
     * Get Session Token
     */
    ipcMain.handle("auth:get-token", async (event) => {

        // The single most sensitive read in the app — this IS the live
        // session credential. Refusing an untrusted sender here matters
        // more than on any other channel.
        if (!isTrustedSender(event)) return null;

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
    ipcMain.handle("auth:set-token", async (event, payload = {}) => {

        if (!isTrustedSender(event)) return false;

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
    ipcMain.handle("auth:clear-token", async (event) => {

        if (!isTrustedSender(event)) return false;

        try {

            SessionStore.clearToken();

            return true;

        } catch (err) {

            console.error(err);

            return false;

        }

    });

}
