import say from "say";

let speaking = false;
let knownVoices = null;

/**
 * The installed SAPI voice names, cached after the first lookup.
 *
 * @returns {Promise<string[]>}
 */
export async function getVoices() {

    if (knownVoices)
        return knownVoices;

    knownVoices = await new Promise((resolve) => {

        say.getInstalledVoices((err, voices) => {

            resolve(err || !Array.isArray(voices) ? [] : voices);

        });

    });

    return knownVoices;

}

/**
 * Only allow a voice the machine actually has.
 *
 * `say` interpolates the voice name straight into its PowerShell command
 * (`$speak.SelectVoice('<voice>')`), so an arbitrary string from the renderer
 * would be running as script. The text itself is safe — that goes over stdin.
 *
 * @param {string|null} voice
 * @returns {Promise<string|null>}
 */
async function resolveVoice(voice) {

    if (!voice)
        return null;

    const installed = await getVoices();

    return installed.includes(voice) ? voice : null;

}

/**
 * Speak text using Windows SAPI.
 *
 * @param {string} text
 * @param {Object} options
 * @param {string|null} options.voice - Must match an installed voice.
 * @param {number} options.speed - Multiplier, 1.0 is normal.
 * @returns {Promise<boolean>} True once the line has been spoken.
 */
export async function speak(
    text,
    {
        voice = null,
        speed = 1.0
    } = {}
) {

    const line = String(text ?? "").trim();

    if (!line)
        return false;

    // Stop current speech
    if (speaking)
        await stop();

    const safeVoice = await resolveVoice(voice);

    return new Promise((resolve) => {

        speaking = true;

        say.speak(
            line,
            safeVoice,
            speed,
            (err) => {

                speaking = false;

                // A cut-off line reports an error too. Report it as "did not
                // finish" rather than rejecting: callers only want to know
                // whether sound came out, and an unobserved rejection here
                // would surface as an unhandled rejection in the main process.
                resolve(!err);

            }
        );

    });

}

/**
 * Stop speaking.
 */
export async function stop() {

    return new Promise((resolve) => {

        say.stop(() => {

            speaking = false;

            resolve(true);

        });

    });

}

/**
 * Check speech state.
 */
export function isSpeaking() {

    return speaking;

}
