import newHttpRequest from './httpRequest';

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

export default function makeBrowserPlatform(options) {
  const ret = {
    userAgentHeaderName: 'X-LaunchDarkly-User-Agent',
  };

  ret.synchronousFlush = false; // this will be set to true by index.js if the page is hidden

  // XMLHttpRequest may not exist if we're running in a server-side rendering context
  if (global.XMLHttpRequest) {
    const disableSyncFlush = options && options.disableSyncEventPost;
    ret.httpRequest = (method, url, headers, body) => {
      const syncFlush = ret.synchronousFlush & !disableSyncFlush;
      ret.synchronousFlush = false;
      return newHttpRequest(method, url, headers, body, syncFlush);
    }
  } else if (GLOBAL.fetch) {
    // fetch is supported in service workers and in node v18+
    ret.httpRequest = (method, url, headers, body) => {
      return GLOBAL.fetch(url, {
        method,
        headers,
        body
      }).then((res) => {
        res.text().then((text) => {
          return {
            status: res.status,
            header: (key) => res.headers.get(key),
            body: text,
          };
        });
      })
    };
  }

  let hasCors;
  ret.httpAllowsPost = () => {
    // We compute this lazily because calling XMLHttpRequest() at initialization time can disrupt tests
    if (hasCors === undefined) {
      if (GLOBAL.XMLHttpRequest) {
        hasCors = GLOBAL.XMLHttpRequest && ('withCredentials' in new GLOBAL.XMLHttpRequest());
      } else if (GLOBAL.fetch) {
        hasCors = true;
      }
      
    }
    return hasCors;
  };

  // Image-based mechanism for sending events if POST isn't available
  ret.httpFallbackPing = (url) => {
    // won't exist in a server-side rendering context or in a web worker
    if(GLOBAL.Image) {
      const img = new GLOBAL.Image();
      img.src = url;
    }
  };

  const eventUrlTransformer = options && options.eventUrlTransformer;
  ret.getCurrentUrl = () => (!!GLOBAL.location  ? (eventUrlTransformer ? eventUrlTransformer(GLOBAL.location.href) : GLOBAL.location.href): undefined);

  ret.isDoNotTrack = () => {
    let flag;
    if (GLOBAL.navigator && GLOBAL.navigator.doNotTrack !== undefined) {
      flag = GLOBAL.navigator.doNotTrack; // FF, Chrome
    } else if (GLOBAL.navigator && GLOBAL.navigator.msDoNotTrack !== undefined) {
      flag = GLOBAL.navigator.msDoNotTrack; // IE 9/10
    } else {
      flag = GLOBAL.doNotTrack; // IE 11+, Safari
    }
    return flag === 1 || flag === true || flag === '1' || flag === 'yes';
  };

  try {
    if (GLOBAL.localStorage) {
      ret.localStorage = {
        get: (key) =>
          new Promise((resolve) => {
            resolve(GLOBAL.localStorage.getItem(key));
          }),
        set: (key, value) =>
          new Promise((resolve) => {
            GLOBAL.localStorage.setItem(key, value);
            resolve();
          }),
        clear: (key) =>
          new Promise((resolve) => {
            GLOBAL.localStorage.removeItem(key);
            resolve();
          }),
      };
    }
  } catch (e) {
    // In some browsers (such as Chrome), even looking at GLOBAL.localStorage at all will cause a
    // security error if the feature is disabled.
    ret.localStorage = null;
  }

  // The browser built-in EventSource implementations do not support setting the method used for
  // the request. When useReport is true, we ensure sending the user in the body of a REPORT request
  // rather than in the URL path. If a polyfill for EventSource that supports setting the request
  // method is provided (currently, launchdarkly-eventsource is the only polyfill that both supports
  // it and gives us a way to *know* that it supports it), we use the polyfill to connect to a flag
  // stream that will provide evaluated flags for the specific user. Otherwise, when useReport is
  // true, we fall back to a generic  'ping' stream that informs the SDK to make a separate REPORT
  // request for the user's flag evaluations whenever the flag definitions have been updated.
  let eventSourceConstructor;
  const useReport = options && options.useReport;
  if (
    useReport &&
    typeof GLOBAL.EventSourcePolyfill === 'function' &&
    GLOBAL.EventSourcePolyfill.supportedOptions &&
    GLOBAL.EventSourcePolyfill.supportedOptions.method
  ) {
    ret.eventSourceAllowsReport = true;
    eventSourceConstructor = GLOBAL.EventSourcePolyfill;
  } else {
    ret.eventSourceAllowsReport = false;
    eventSourceConstructor = GLOBAL.EventSource;
  }

  // If EventSource does not exist, the absence of eventSourceFactory will make us not try to open streams
  if (GLOBAL.EventSource) {
    const timeoutMillis = 300000; // this is only used by polyfills - see below

    ret.eventSourceFactory = (url, options) => {
      // The standard EventSource constructor doesn't take any options, just a URL. However, some
      // EventSource polyfills allow us to specify a timeout interval, and in some cases they will
      // default to a too-short timeout if we don't specify one. So, here, we are setting the
      // timeout properties that are used by several popular polyfills.
      // Also, the skipDefaultHeaders property (if supported) tells the polyfill not to add the
      // Cache-Control header that can cause CORS problems in browsers.
      // See: https://github.com/launchdarkly/js-eventsource
      const defaultOptions = {
        heartbeatTimeout: timeoutMillis,
        silentTimeout: timeoutMillis,
        skipDefaultHeaders: true,
      };

      const esOptions = { ...defaultOptions, ...options };

      return new eventSourceConstructor(url, esOptions);
    };

    ret.eventSourceIsActive = (es) =>
      es.readyState === GLOBAL.EventSource.OPEN || es.readyState === GLOBAL.EventSource.CONNECTING;
  }

  ret.userAgent = 'JSClient';
  ret.version = VERSION;

  ret.diagnosticSdkData = {
    name: 'js-client-sdk',
    version: VERSION,
  };

  ret.diagnosticPlatformData = {
    name: 'JS',
  };

  ret.diagnosticUseCombinedEvent = true; // the browser SDK uses the "diagnostic-combined" event format

  return ret;
}
