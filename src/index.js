import * as common from 'launchdarkly-js-sdk-common';
import * as importBasicLogger from './basicLogger';
import browserPlatform from './browserPlatform';
import GoalManager from './GoalManager';

const goalsEvent = 'goalsReady';
const extraOptionDefs = {
  fetchGoals: { default: true },
  hash: { type: 'string' },
  eventProcessor: { type: 'object' }, // used only in tests
  eventUrlTransformer: { type: 'function' },
  disableSyncEventPost: { default: false },
};
// window is not defined in node.js or in a web worker
// self is defined in a service worker
// global is defined in node.js
// see https://github.com/tc39/proposal-global#rationale
const GLOBAL = (function () {
	// the only reliable means to get the global object is
	// `Function('return this')()`
	// However, this causes CSP violations in Chrome apps.
	if (typeof self !== 'undefined') { return self; }
	if (typeof window !== 'undefined') { return window; }
	if (typeof global !== 'undefined') { return global; }
	throw new Error('unable to locate global object');
})();

const hasDOM = typeof window !== 'undefined' && typeof document !== 'undefined';

// Pass our platform object to the common code to create the browser version of the client
export function initialize(env, user, options = {}) {
  const platform = browserPlatform(options);
  const clientVars = common.initialize(env, user, options, platform, extraOptionDefs);

  const client = clientVars.client;
  const validatedOptions = clientVars.options;
  const emitter = clientVars.emitter;

  const goalsPromise = new Promise((resolve) => {
    const onGoals = emitter.on(goalsEvent, () => {
      emitter.off(goalsEvent, onGoals);
      resolve();
    });
  });
  client.waitUntilGoalsReady = () => goalsPromise;

  if (hasDOM && validatedOptions.fetchGoals) {
    GoalManager(clientVars, () => emitter.emit(goalsEvent));
    // Don't need to save a reference to the GoalManager - its constructor takes care of setting
    // up the necessary event wiring
  } else {
    emitter.emit(goalsEvent);
  }

  if (hasDOM && document.readyState !== 'complete') {
    GLOBAL.addEventListener('load', clientVars.start);
  } else {
    clientVars.start();
  }

  const syncFlush = () => {
    // Synchronous events are not available in all browsers, but where they
    // are we should attempt to use them. This increases the chance of the events
    // being delivered.
    platform.synchronousFlush = true;
    client.flush().catch(() => {});
    platform.synchronousFlush = false;
  };

  // When the visibility of the page changes to hidden we want to flush any pending events.
  //
  // This is handled with visibility, instead of beforeunload/unload
  // because those events are not compatible with the bfcache and are unlikely
  // to be called in many situations. For more information see: https://developer.chrome.com/blog/page-lifecycle-api/
  //
  // Redundancy is included by using both the visibilitychange handler as well as
  // pagehide, because different browsers, and versions have different bugs with each.
  // This also may provide more opportunity for the events to get flushed.
  //
  const handleVisibilityChange = () => {
    // only called in environments with a DOM
    if (document.visibilityState === 'hidden') {
      syncFlush();
    }
  };
  if(hasDOM) {
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', syncFlush);
  }

  return client;
}

export const basicLogger = importBasicLogger.basicLogger;

export const createConsoleLogger = common.createConsoleLogger;

export const version = VERSION;

function deprecatedInitialize(env, user, options = {}) {
  console && console.warn && console.warn(common.messages.deprecated('default export', 'named LDClient export')); // eslint-disable-line no-console
  return initialize(env, user, options);
}

export default { initialize: deprecatedInitialize, version };
