(function () {
  if (typeof document.startViewTransition !== "function") {
    return;
  }

  if ("scrollRestoration" in history) {
    history.scrollRestoration = "manual";
  }

  const domParser = new DOMParser();
  let inFlight = null;
  let scrollStateScheduled = false;

  function getHistoryState() {
    return history.state && typeof history.state === "object" ? history.state : {};
  }

  function replaceHistoryState(nextState) {
    history.replaceState(nextState, "", window.location.href);
  }

  function scheduleScrollStateUpdate() {
    if (scrollStateScheduled) return;
    scrollStateScheduled = true;
    requestAnimationFrame(() => {
      scrollStateScheduled = false;
      const state = getHistoryState();
      if (state.scrollY === window.scrollY && state.href === window.location.href) {
        return;
      }
      replaceHistoryState({
        ...state,
        href: window.location.href,
        scrollY: window.scrollY,
      });
    });
  }

  window.addEventListener(
    "scroll",
    () => {
      scheduleScrollStateUpdate();
    },
    { passive: true },
  );

  // Ensure the initial entry has scroll state.
  scheduleScrollStateUpdate();

  function shouldInterceptLink(anchor, event) {
    if (event.defaultPrevented) return false;
    if (event.button !== 0) return false;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
    if (anchor.target && anchor.target.toLowerCase() !== "_self") return false;
    if (anchor.hasAttribute("download")) return false;

    const href = anchor.getAttribute("href");
    if (!href) return false;
    if (href.startsWith("#")) return false;
    if (href.startsWith("mailto:") || href.startsWith("tel:")) return false;

    let url;
    try {
      url = new URL(href, window.location.href);
    } catch {
      return false;
    }

    if (url.origin !== window.location.origin) return false;
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.pathname.startsWith("/static/")) return false;
    if (!(url.pathname === "/" || url.pathname.endsWith("/"))) return false;

    // Let the browser handle in-page fragment navigation.
    if (
      url.pathname === window.location.pathname &&
      url.search === window.location.search &&
      url.hash
    ) {
      return false;
    }

    return true;
  }

  async function fetchDocument(url, signal) {
    const response = await fetch(url.href, {
      signal,
      headers: { Accept: "text/html" },
      credentials: "same-origin",
    });

    if (!response.ok) {
      throw new Error(`Failed to load ${url.pathname} (${response.status})`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      throw new Error(`Unexpected content-type: ${contentType}`);
    }

    const html = await response.text();
    return domParser.parseFromString(html, "text/html");
  }

  function syncHead(newDoc) {
    if (newDoc.title) {
      document.title = newDoc.title;
    }

    const currentCanonical = document.head.querySelector('link[rel="canonical"]');
    const nextCanonical = newDoc.head.querySelector('link[rel="canonical"]');
    if (nextCanonical) {
      if (currentCanonical) {
        currentCanonical.setAttribute("href", nextCanonical.getAttribute("href") || "");
      } else {
        document.head.appendChild(nextCanonical.cloneNode(true));
      }
    } else if (currentCanonical) {
      currentCanonical.remove();
    }

    const managedMetaSelector = "meta[name], meta[property]";
    document.head.querySelectorAll(managedMetaSelector).forEach((el) => el.remove());
    newDoc.head
      .querySelectorAll(managedMetaSelector)
      .forEach((el) => document.head.appendChild(el.cloneNode(true)));

    document.head
      .querySelectorAll('script[type="application/ld+json"]')
      .forEach((el) => el.remove());
    newDoc.head
      .querySelectorAll('script[type="application/ld+json"]')
      .forEach((el) => document.head.appendChild(el.cloneNode(true)));
  }

  function syncBody(newDoc) {
    const currentBody = document.querySelector("div.body");
    const nextBody = newDoc.querySelector("div.body");
    if (!currentBody || !nextBody) {
      throw new Error("Could not find body container");
    }
    currentBody.innerHTML = nextBody.innerHTML;
  }

  function scrollToLocation(url, fallbackScrollY) {
    if (url.hash) {
      const id = decodeURIComponent(url.hash.slice(1));
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView();
        return;
      }
    }
    window.scrollTo(0, fallbackScrollY);
  }

  async function navigate(url, { historyAction, fallbackScrollY }) {
    if (inFlight) {
      inFlight.abort();
    }

    const controller = new AbortController();
    inFlight = controller;

    let newDoc;
    try {
      newDoc = await fetchDocument(url, controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) {
        window.location.assign(url.href);
      }
      return;
    } finally {
      if (inFlight === controller) {
        inFlight = null;
      }
    }

    function update() {
      document.dispatchEvent(new Event("dark:content-will-update"));

      if (historyAction === "push") {
        const state = getHistoryState();
        replaceHistoryState({
          ...state,
          href: window.location.href,
          scrollY: window.scrollY,
        });
        history.pushState({ href: url.href, scrollY: 0 }, "", url.href);
      } else if (historyAction === "replace") {
        history.replaceState({ href: url.href, scrollY: fallbackScrollY }, "", url.href);
      }

      syncHead(newDoc);
      syncBody(newDoc);
      scrollToLocation(url, fallbackScrollY);
    }

    const transition = document.startViewTransition(update);

    const onReady = transition.ready || transition.updateCallbackDone || Promise.resolve();
    onReady.then(() => {
      document.dispatchEvent(new Event("dark:content-updated"));
    });
  }

  document.addEventListener(
    "click",
    (event) => {
      const anchor = event.target.closest ? event.target.closest("a") : null;
      if (!anchor) return;
      if (!shouldInterceptLink(anchor, event)) return;

      event.preventDefault();

      let url;
      try {
        url = new URL(anchor.getAttribute("href"), window.location.href);
      } catch {
        window.location.assign(anchor.href);
        return;
      }

      navigate(url, { historyAction: "push", fallbackScrollY: 0 });
    },
    true,
  );

  window.addEventListener("popstate", () => {
    const state = getHistoryState();
    const fallbackScrollY = typeof state.scrollY === "number" ? state.scrollY : 0;
    navigate(new URL(window.location.href), {
      historyAction: "replace",
      fallbackScrollY,
    });
  });
})();
