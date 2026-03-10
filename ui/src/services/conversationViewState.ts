interface NumberStore {
  load(): number | null;
  save(value: number): void;
}

const SELECTED_MODEL_KEY = "shelley_selected_model";
const SELECTED_CWD_KEY = "shelley_selected_cwd";
const MESSAGE_COUNT_PREFIX = "shelley_msg_count_";
const SCROLL_PREFIX = "shelley_scroll_";

function loadStoredString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveStoredString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore localStorage failures.
  }
}

function createNumberStore(prefix: string, conversationId: string | null): NumberStore {
  const key = conversationId ? `${prefix}${conversationId}` : null;

  return {
    load() {
      if (!key) return null;
      try {
        const value = localStorage.getItem(key);
        if (value == null) return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    save(value: number) {
      if (!key) return;
      try {
        localStorage.setItem(key, String(value));
      } catch {
        // Ignore localStorage failures.
      }
    },
  };
}

export function loadSelectedModel(): string | null {
  return loadStoredString(SELECTED_MODEL_KEY);
}

export function saveSelectedModel(model: string): void {
  saveStoredString(SELECTED_MODEL_KEY, model);
}

export function loadSelectedCwd(): string | null {
  return loadStoredString(SELECTED_CWD_KEY);
}

export function saveSelectedCwd(cwd: string): void {
  saveStoredString(SELECTED_CWD_KEY, cwd);
}

export function createConversationMessageCountStore(conversationId: string | null): NumberStore {
  return createNumberStore(MESSAGE_COUNT_PREFIX, conversationId);
}

export function createConversationScrollStore(conversationId: string | null): NumberStore {
  return createNumberStore(SCROLL_PREFIX, conversationId);
}
