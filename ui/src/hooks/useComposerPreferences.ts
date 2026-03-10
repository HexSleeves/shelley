import { type Dispatch, type SetStateAction, useCallback, useEffect, useState } from "react";
import { api } from "../services/api";
import {
  loadSelectedCwd,
  loadSelectedModel,
  saveSelectedCwd,
  saveSelectedModel,
} from "../services/conversationViewState";
import { Conversation, Model } from "../types";

interface UseComposerPreferencesArgs {
  conversationId: string | null;
  currentConversation?: Conversation;
  mostRecentCwd?: string | null;
  modelsRefreshTrigger?: number;
}

interface UseComposerPreferencesResult {
  models: Model[];
  selectedModel: string;
  setSelectedModel: (model: string) => void;
  selectedCwd: string;
  setSelectedCwd: (cwd: string) => void;
  cwdError: string | null;
  setCwdError: Dispatch<SetStateAction<string | null>>;
}

export function useComposerPreferences({
  conversationId,
  currentConversation,
  mostRecentCwd,
  modelsRefreshTrigger,
}: UseComposerPreferencesArgs): UseComposerPreferencesResult {
  const [models, setModels] = useState<Model[]>(window.__SHELLEY_INIT__?.models || []);
  const [selectedModelState, setSelectedModelState] = useState<string>(() => {
    const storedModel = loadSelectedModel();
    const initModels = window.__SHELLEY_INIT__?.models || [];

    if (storedModel) {
      const modelInfo = initModels.find((model) => model.id === storedModel);
      if (modelInfo?.ready) {
        return storedModel;
      }
    }

    const defaultModel = window.__SHELLEY_INIT__?.default_model;
    if (defaultModel) {
      return defaultModel;
    }

    const firstReady = initModels.find((model) => model.ready);
    return firstReady?.id || "";
  });
  const [selectedCwdState, setSelectedCwdState] = useState("");
  const [cwdInitialized, setCwdInitialized] = useState(false);
  const [cwdError, setCwdError] = useState<string | null>(null);

  const setSelectedModel = useCallback((model: string) => {
    setSelectedModelState(model);
    saveSelectedModel(model);
  }, []);

  const setSelectedCwd = useCallback((cwd: string) => {
    setSelectedCwdState(cwd);
    saveSelectedCwd(cwd);
  }, []);

  useEffect(() => {
    if (currentConversation?.model) {
      setSelectedModel(currentConversation.model);
    }
  }, [currentConversation?.conversation_id, currentConversation?.model, setSelectedModel]);

  useEffect(() => {
    if (conversationId === null) {
      setCwdInitialized(false);
    }
  }, [conversationId]);

  useEffect(() => {
    if (cwdInitialized) return;

    const storedCwd = loadSelectedCwd();
    if (storedCwd) {
      setSelectedCwdState(storedCwd);
      setCwdInitialized(true);
      return;
    }

    if (mostRecentCwd) {
      setSelectedCwdState(mostRecentCwd);
      setCwdInitialized(true);
      return;
    }

    const defaultCwd = window.__SHELLEY_INIT__?.default_cwd || "";
    if (defaultCwd) {
      setSelectedCwdState(defaultCwd);
      setCwdInitialized(true);
    }
  }, [cwdInitialized, mostRecentCwd]);

  useEffect(() => {
    if (modelsRefreshTrigger === undefined) return;
    if (modelsRefreshTrigger === 0 && conversationId !== null) return;

    api
      .getModels()
      .then((nextModels) => {
        setModels(nextModels);
        if (window.__SHELLEY_INIT__) {
          window.__SHELLEY_INIT__.models = nextModels;
        }

        const currentModelInfo = nextModels.find((model) => model.id === selectedModelState);
        if (!currentModelInfo?.ready) {
          const firstReady = nextModels.find((model) => model.ready);
          if (firstReady) {
            setSelectedModel(firstReady.id);
          }
        }
      })
      .catch((err) => {
        console.error("Failed to refresh models:", err);
      });
  }, [conversationId, modelsRefreshTrigger, selectedModelState, setSelectedModel]);

  return {
    models,
    selectedModel: selectedModelState,
    setSelectedModel,
    selectedCwd: selectedCwdState,
    setSelectedCwd,
    cwdError,
    setCwdError,
  };
}
