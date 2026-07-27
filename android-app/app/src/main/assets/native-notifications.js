(() => {
  "use strict";

  if (window.__agentNativeNotificationInstalled || !window.AgentAndroid) return;

  const notifications = new Map();
  const permissionResolvers = new Map();
  let nextPermissionRequest = 1;

  const nativePermission = () => {
    try {
      const value = window.AgentAndroid.getNotificationPermission();
      return value === "granted" || value === "denied" ? value : "default";
    } catch {
      return "denied";
    }
  };

  class NativeNotification {
    constructor(title, options = {}) {
      this.title = String(title || "Agent");
      this.body = String(options.body || "");
      this.tag = String(
        options.tag || `agent-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      );
      this.onclick = null;
      this.closed = false;
      notifications.set(this.tag, this);
      try {
        window.AgentAndroid.showNotification(this.title, this.body, this.tag);
      } catch {
        notifications.delete(this.tag);
      }
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      notifications.delete(this.tag);
      try {
        window.AgentAndroid.closeNotification(this.tag);
      } catch {
        // The Android host may already have been torn down.
      }
    }

    static get permission() {
      return nativePermission();
    }

    static requestPermission() {
      const current = nativePermission();
      if (current !== "default") return Promise.resolve(current);

      const requestId = `permission-${nextPermissionRequest++}`;
      return new Promise((resolve) => {
        permissionResolvers.set(requestId, resolve);
        try {
          window.AgentAndroid.requestNotificationPermission(requestId);
        } catch {
          permissionResolvers.delete(requestId);
          resolve("denied");
          return;
        }

        window.setTimeout(() => {
          const pending = permissionResolvers.get(requestId);
          if (!pending) return;
          permissionResolvers.delete(requestId);
          pending(nativePermission());
        }, 30000);
      });
    }

    __open() {
      if (this.closed) return;
      try {
        if (typeof this.onclick === "function") {
          this.onclick({ type: "click", target: this });
        }
      } finally {
        this.close();
      }
    }
  }

  window.__agentNativeDispatchPermission = (requestId, result) => {
    const resolve = permissionResolvers.get(String(requestId));
    if (!resolve) return;
    permissionResolvers.delete(String(requestId));
    resolve(result === "granted" ? "granted" : result === "default" ? "default" : "denied");
  };

  window.__agentNativeOpenNotification = (tag) => {
    const key = String(tag || "");
    const notification = notifications.get(key);
    if (notification) {
      notification.__open();
      return;
    }
    window.dispatchEvent(
      new CustomEvent("agent-native-notification-click", { detail: { tag: key } }),
    );
  };

  try {
    Object.defineProperty(window, "Notification", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: NativeNotification,
    });
    window.__agentNativeNotificationInstalled = true;
  } catch {
    // A WebView implementation may expose a non-configurable Notification API.
  }

  const isLightBackground = (element) => {
    let current = element;
    while (current) {
      const match = getComputedStyle(current).backgroundColor.match(
        /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)/,
      );
      if (match && (match[4] === undefined || Number(match[4]) >= 0.15)) {
        const red = Number(match[1]);
        const green = Number(match[2]);
        const blue = Number(match[3]);
        return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255 >= 0.58;
      }
      current = current.parentElement;
    }
    return false;
  };

  const elementAt = (y) =>
    document.elementFromPoint(Math.max(1, window.innerWidth / 2), y)
    || document.body
    || document.documentElement;

  let systemBarFrame = 0;
  const syncSystemBars = () => {
    if (systemBarFrame) cancelAnimationFrame(systemBarFrame);
    systemBarFrame = requestAnimationFrame(() => {
      systemBarFrame = 0;
      try {
        window.AgentAndroid.setSystemBarAppearance(
          isLightBackground(elementAt(1)),
          isLightBackground(elementAt(Math.max(1, window.innerHeight - 1))),
        );
      } catch {
        // System-bar styling is cosmetic; never affect the WebUI itself.
      }
    });
  };

  syncSystemBars();
  window.setTimeout(syncSystemBars, 250);
  window.addEventListener("resize", syncSystemBars, { passive: true });
  window.addEventListener("focus", syncSystemBars, { passive: true });
  new MutationObserver(syncSystemBars).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme"],
  });
  if (document.body) {
    new MutationObserver(syncSystemBars).observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
  }
})();
