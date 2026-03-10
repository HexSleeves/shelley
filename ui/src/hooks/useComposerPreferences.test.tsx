import { api } from "../services/api";
import { useComposerPreferences } from "./useComposerPreferences";
import { assert, flushEffects, renderHook, setupDom, TestResult } from "../test/hookTestUtils";

interface TestCase {
  name: string;
  fn: () => Promise<void> | void;
}

export async function runTests(): Promise<TestResult> {
  const tests: TestCase[] = [];
  const results: TestResult = { passed: 0, failed: 0, failures: [] };

  function test(name: string, fn: () => Promise<void> | void) {
    tests.push({ name, fn });
  }

  const originalGetModels = api.getModels.bind(api);

  test("prefers stored ready model and stored cwd", async () => {
    localStorage.setItem("shelley_selected_model", "stored-model");
    localStorage.setItem("shelley_selected_cwd", "/stored");
    window.__SHELLEY_INIT__ = {
      models: [
        { id: "stored-model", ready: true },
        { id: "fallback", ready: true },
      ],
      default_model: "fallback",
      default_cwd: "/default",
    };

    const hook = renderHook(useComposerPreferences, {
      conversationId: null,
      currentConversation: undefined,
      mostRecentCwd: "/recent",
      modelsRefreshTrigger: undefined,
    });
    await flushEffects();
    const result = hook.getResult();
    assert(result.selectedModel === "stored-model", "should use stored ready model");
    assert(result.selectedCwd === "/stored", "should use stored cwd");
    hook.unmount();
  });

  test("falls back to most recent cwd when no stored cwd exists", async () => {
    localStorage.removeItem("shelley_selected_cwd");
    window.__SHELLEY_INIT__ = {
      models: [{ id: "model-a", ready: true }],
      default_model: "model-a",
      default_cwd: "/default",
    };

    const hook = renderHook(useComposerPreferences, {
      conversationId: null,
      currentConversation: undefined,
      mostRecentCwd: "/recent",
      modelsRefreshTrigger: undefined,
    });
    await flushEffects();
    assert(hook.getResult().selectedCwd === "/recent", "should use most recent cwd");
    hook.unmount();
  });

  test("refresh picks the first ready model when current selection becomes unavailable", async () => {
    window.__SHELLEY_INIT__ = {
      models: [{ id: "old-model", ready: true }],
      default_model: "old-model",
      default_cwd: "/default",
    };
    localStorage.setItem("shelley_selected_model", "old-model");
    api.getModels = async () => [
      { id: "old-model", ready: false },
      { id: "new-model", ready: true },
    ];

    const hook = renderHook(useComposerPreferences, {
      conversationId: null,
      currentConversation: undefined,
      mostRecentCwd: null,
      modelsRefreshTrigger: 1,
    });
    await flushEffects();
    await flushEffects();
    assert(hook.getResult().selectedModel === "new-model", "should switch to first ready model");
    hook.unmount();
  });

  for (const { name, fn } of tests) {
    try {
      localStorage.clear();
      await fn();
      results.passed += 1;
    } catch (err) {
      results.failed += 1;
      results.failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      api.getModels = originalGetModels;
      window.__SHELLEY_INIT__ = undefined;
    }
  }

  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cleanup = setupDom();
  runTests()
    .then((results) => {
      console.log(`\nuseComposerPreferences Tests: ${results.passed} passed, ${results.failed} failed\n`);
      if (results.failures.length > 0) {
        for (const failure of results.failures) {
          console.log(failure);
        }
        process.exitCode = 1;
      }
    })
    .finally(() => cleanup());
}
