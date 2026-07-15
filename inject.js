// Runs in the page's MAIN world at document_start so it can wrap fetch/XHR
// before Upwork's SPA ever calls them. We only READ responses the page already
// requested -- we never originate a request of our own.

(() => {
  const EVENT = "UWR_FEED";

  // The feed lives under an unpredictable key (mostRecentRecommendationsFeed,
  // bestMatchesFeed, ...). Any data.<key>.results array is the job list.
  function extractResults(payload) {
    const data = payload && payload.data;
    if (!data || typeof data !== "object") return null;
    for (const key of Object.keys(data)) {
      const node = data[key];
      if (node && Array.isArray(node.results) && node.results.length) {
        return { feed: key, results: node.results };
      }
    }
    return null;
  }

  function publish(payload) {
    const found = extractResults(payload);
    if (!found) return;
    window.dispatchEvent(
      new CustomEvent(EVENT, {
        detail: { feed: found.feed, results: found.results, at: Date.now() },
      })
    );
  }

  function isGraphql(url) {
    return typeof url === "string" && url.includes("/api/graphql");
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const promise = originalFetch.apply(this, args);
    try {
      const input = args[0];
      const url = typeof input === "string" ? input : input && input.url;
      if (isGraphql(url)) {
        promise
          .then((res) => res.clone().json())
          .then(publish)
          .catch(() => {});
      }
    } catch (_) {}
    return promise;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__uwrUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (isGraphql(this.__uwrUrl)) {
      this.addEventListener("load", () => {
        try {
          publish(JSON.parse(this.responseText));
        } catch (_) {}
      });
    }
    return originalSend.apply(this, args);
  };
})();
