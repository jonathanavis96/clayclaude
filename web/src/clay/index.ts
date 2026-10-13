/** Public entry of the clay renderer. Importable in node: three.js loads lazily. */
export { CLAY_STATES, clayStateFor, type ClayStateId } from './states.js';
export { DEFAULT_CLAY_PREFS, readClayPrefs, writeClayPrefs, type AnimMode, type ClayPrefs } from './prefs.js';
export { createClayController, type ClayController, type ClayStatus } from './controller.js';
export { RENDERER_VERSION } from './version.js';
