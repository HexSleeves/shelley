import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";

export interface TestResult {
  passed: number;
  failed: number;
  failures: string[];
}

export function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export function setupDom(url = "http://localhost/"): () => void {
  const testGlobal = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousEventSource = globalThis.EventSource;
  const previousNotification = globalThis.Notification;
  const previousCustomEvent = globalThis.CustomEvent;
  const previousResizeObserver = globalThis.ResizeObserver;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const previousLocalStorage = globalThis.localStorage;
  const previousSessionStorage = globalThis.sessionStorage;
  const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT;
  const win = dom.window as unknown as Window & typeof globalThis;

  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: win });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: win.document,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: win.navigator,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    writable: true,
    value: win.HTMLElement,
  });
  Object.defineProperty(globalThis, "CustomEvent", {
    configurable: true,
    writable: true,
    value: win.CustomEvent,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: win.localStorage,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    writable: true,
    value: win.sessionStorage,
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    writable: true,
    value: () => {},
  });

  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as typeof ResizeObserver;
  }
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;

  return () => {
    dom.window.close();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: previousWindow,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      writable: true,
      value: previousDocument,
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: previousNavigator,
    });
    Object.defineProperty(globalThis, "HTMLElement", {
      configurable: true,
      writable: true,
      value: previousHTMLElement,
    });
    Object.defineProperty(globalThis, "EventSource", {
      configurable: true,
      writable: true,
      value: previousEventSource,
    });
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      writable: true,
      value: previousNotification,
    });
    Object.defineProperty(globalThis, "CustomEvent", {
      configurable: true,
      writable: true,
      value: previousCustomEvent,
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      writable: true,
      value: previousLocalStorage,
    });
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      writable: true,
      value: previousSessionStorage,
    });
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: previousResizeObserver,
    });
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      writable: true,
      value: previousRequestAnimationFrame,
    });
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      configurable: true,
      writable: true,
      value: previousCancelAnimationFrame,
    });
    testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  };
}

export async function flushEffects(): Promise<void> {
  await runWithAct(() => Promise.resolve());
}

export async function runWithAct<T>(fn: () => Promise<T> | T): Promise<T> {
  let settled = false;
  let result!: T;
  await act(async () => {
    result = await fn();
    settled = true;
  });
  if (!settled) {
    throw new Error("Act callback did not settle");
  }
  return result;
}

export function renderHook<T, P extends object>(
  hook: (props: P) => T,
  initialProps: P,
): {
  getResult: () => T;
  rerender: (nextProps: P) => Promise<void>;
  unmount: () => void;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  let latestResult: T | undefined;

  function HookHarness(props: P) {
    latestResult = hook(props);
    return null;
  }

  act(() => {
    root.render(React.createElement(HookHarness, initialProps));
  });

  return {
    getResult() {
      if (latestResult === undefined) {
        throw new Error("Hook result is not ready");
      }
      return latestResult;
    },
    async rerender(nextProps: P) {
      await act(async () => {
        root.render(React.createElement(HookHarness, nextProps));
      });
    },
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}
