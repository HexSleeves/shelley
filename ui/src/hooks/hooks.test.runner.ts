import { runTests as runCoalescedMessagesTests } from "./useCoalescedMessages.test";
import { runTests as runComposerPreferencesTests } from "./useComposerPreferences.test";
import { runTests as runConversationActionsTests } from "./useConversationActions.test";
import { runTests as runConversationSessionTests } from "./useConversationSession.test";
import { runTests as runConversationSnapshotTests } from "./useConversationSnapshot.test";
import { runTests as runConversationStreamTests } from "./useConversationStream.test";
import { setupDom } from "../test/hookTestUtils";

async function main() {
  const cleanup = setupDom();
  try {
    const suites = [
      ["useCoalescedMessages", runCoalescedMessagesTests()],
      ["useComposerPreferences", await runComposerPreferencesTests()],
      ["useConversationActions", await runConversationActionsTests()],
      ["useConversationSnapshot", await runConversationSnapshotTests()],
      ["useConversationStream", await runConversationStreamTests()],
      ["useConversationSession", await runConversationSessionTests()],
    ] as const;

    let failed = false;
    for (const [name, result] of suites) {
      console.log(`\n${name} Tests: ${result.passed} passed, ${result.failed} failed\n`);
      if (result.failures.length > 0) {
        failed = true;
        for (const failure of result.failures) {
          console.log(failure);
        }
      }
    }

    if (failed) {
      process.exit(1);
    }
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
