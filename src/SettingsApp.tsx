import * as React from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import type { OpenRouterSettings } from "./openrouter";
import {
  DEFAULT_DEEP_DIVE_COOLDOWN_SECONDS,
  DEFAULT_DEV_TRANSCRIPT_DELAY_MS,
  DEFAULT_DEVELOPER_MODE,
  DEFAULT_EVALUATION_DELAY_MS,
  DEFAULT_NARRATIVE_PROMPT,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_OPENROUTER_REASONING,
  DEFAULT_TOPIC_SHIFT_SENSITIVITY,
  clearOpenRouterKey,
  hasOpenRouterKey,
  loadOpenRouterSettings,
  saveOpenRouterSettings,
} from "./openrouter";
import {
  EVALUATION_DELAY_LEVELS,
  TOPIC_SHIFT_SENSITIVITY_LEVELS,
  describeEvaluationDelay,
  describeTopicShiftSensitivity,
} from "./browserAutomationOptions";
import type { OpenRouterModelCatalogItem } from "./openrouterModels";
import {
  fetchOpenRouterModels,
  loadOpenRouterModelCatalogCache,
  saveOpenRouterModelCatalogCache,
} from "./openrouterModels";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Textarea } from "./components/ui/textarea";
import { Checkbox } from "./components/ui/checkbox";
import { cn } from "./lib/utils";
import { PERSONAS, NO_PERSONA_ID } from "./personas";
import type { UserNote } from "./userNotes";
import {
  loadUserNotes,
  addUserNote,
  removeUserNote,
  updateUserNote,
} from "./userNotes";

const DEFAULT_PROMPT = "How many r's are in the word strawberry?";
const DEEP_DIVE_COOLDOWN_LEVELS = [
  { value: 0, label: "No cooldown", description: "Allow back-to-back automatic deep dives." },
  { value: 30, label: "30 seconds", description: "Wait at least 30s after each deep dive." },
  { value: 60, label: "1 minute", description: "Wait at least 1 minute between deep dives." },
  { value: 120, label: "2 minutes", description: "Wait at least 2 minutes between deep dives." },
  { value: 300, label: "5 minutes", description: "Wait at least 5 minutes between deep dives." },
] as const;
const MAX_VISIBLE_MODEL_OPTIONS = 40;
const MODEL_DROPDOWN_ID = "openrouter-model-options";

export function SettingsApp() {
  const [openRouterKey, setOpenRouterKey] = React.useState("");
  const [openRouterModel, setOpenRouterModel] = React.useState("");
  const [openRouterReasoning, setOpenRouterReasoning] = React.useState(false);
  const [modelSupportsReasoning, setModelSupportsReasoning] = React.useState(false);
  const [availableModels, setAvailableModels] = React.useState<
    OpenRouterModelCatalogItem[]
  >([]);
  const [isLoadingModelCatalog, setIsLoadingModelCatalog] = React.useState(false);
  const [modelCatalogStatus, setModelCatalogStatus] = React.useState("");
  const [hasLoadedModelCatalog, setHasLoadedModelCatalog] = React.useState(false);
  const [isModelDropdownOpen, setIsModelDropdownOpen] = React.useState(false);
  const [highlightedModelIndex, setHighlightedModelIndex] = React.useState(-1);
  const modelPickerRef = React.useRef<HTMLDivElement | null>(null);
  const modelFetchRequestIdRef = React.useRef(0);
  const [topicShiftSensitivity, setTopicShiftSensitivity] = React.useState(
    DEFAULT_TOPIC_SHIFT_SENSITIVITY
  );
  const [showKey, setShowKey] = React.useState(false);
  const [saveStatus, setSaveStatus] = React.useState("Nothing saved yet.");
  const [testPrompt, setTestPrompt] = React.useState(DEFAULT_PROMPT);
  const [testResult, setTestResult] = React.useState("");
  const [isTesting, setIsTesting] = React.useState(false);
  const [mcpConfigPath, setMcpConfigPath] = React.useState("");
  const [mcpConfigJson, setMcpConfigJson] = React.useState("");
  const [mcpConfigStatus, setMcpConfigStatus] = React.useState("");
  const [preferredUrls, setPreferredUrls] = React.useState("");
  const [preferredUrlStatus, setPreferredUrlStatus] = React.useState("");
  const [isDescribingPreferredUrls, setIsDescribingPreferredUrls] =
    React.useState(false);
  const [preferredUrlDropActive, setPreferredUrlDropActive] = React.useState(false);
  const preferredUrlFileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [persona, setPersona] = React.useState(NO_PERSONA_ID);
  const [deepDiveCooldownSeconds, setDeepDiveCooldownSeconds] = React.useState(
    DEFAULT_DEEP_DIVE_COOLDOWN_SECONDS
  );
  const [evaluationDelayMs, setEvaluationDelayMs] = React.useState(
    DEFAULT_EVALUATION_DELAY_MS
  );
  const [developerMode, setDeveloperMode] = React.useState(DEFAULT_DEVELOPER_MODE);
  const [devTranscriptDelayMs, setDevTranscriptDelayMs] = React.useState(
    DEFAULT_DEV_TRANSCRIPT_DELAY_MS
  );
  const [narrativePrompt, setNarrativePrompt] = React.useState(DEFAULT_NARRATIVE_PROMPT);
  const [userNotes, setUserNotes] = React.useState<UserNote[]>([]);
  const [newNoteText, setNewNoteText] = React.useState("");
  const [editingNoteId, setEditingNoteId] = React.useState<string | null>(null);
  const [editingNoteText, setEditingNoteText] = React.useState("");

  const selectedCatalogModel = React.useMemo(() => {
    const normalizedModel = openRouterModel.trim().toLowerCase();
    if (!normalizedModel) return null;
    return (
      availableModels.find((model) => model.id.toLowerCase() === normalizedModel) ??
      null
    );
  }, [availableModels, openRouterModel]);

  const filteredModelOptions = React.useMemo(() => {
    const query = openRouterModel.trim().toLowerCase();
    if (!query) {
      return availableModels.slice(0, MAX_VISIBLE_MODEL_OPTIONS);
    }

    type RankedModel = {
      model: OpenRouterModelCatalogItem;
      rank: number;
      index: number;
    };

    const ranked = availableModels
      .map((model, index): RankedModel | null => {
        const modelId = model.id.toLowerCase();
        const modelName = model.name.toLowerCase();
        if (modelId === query) {
          return { model, rank: 0, index };
        }
        if (modelId.startsWith(query) || modelName.startsWith(query)) {
          return { model, rank: 1, index };
        }
        if (
          modelId.includes(query) ||
          modelName.includes(query) ||
          model.searchText.includes(query)
        ) {
          return { model, rank: 2, index };
        }
        return null;
      })
      .filter((item): item is RankedModel => Boolean(item))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .slice(0, MAX_VISIBLE_MODEL_OPTIONS)
      .map((item) => item.model);

    return ranked;
  }, [availableModels, openRouterModel]);

  const formatCacheTimestamp = React.useCallback((value: number) => {
    const ts = new Date(value);
    if (!Number.isFinite(ts.getTime())) return "";
    return ts.toLocaleString();
  }, []);

  const formatErrorMessage = React.useCallback((error: unknown) => {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return String(error);
  }, []);

  const refreshModelCatalog = React.useCallback(async () => {
    const requestId = modelFetchRequestIdRef.current + 1;
    modelFetchRequestIdRef.current = requestId;
    setIsLoadingModelCatalog(true);
    setModelCatalogStatus("Refreshing model catalog...");

    try {
      const models = await fetchOpenRouterModels();
      if (modelFetchRequestIdRef.current !== requestId) return;
      setAvailableModels(models);
      saveOpenRouterModelCatalogCache(models);
      setHasLoadedModelCatalog(true);
      setModelCatalogStatus(`Loaded ${models.length} models from OpenRouter.`);
    } catch (error) {
      if (modelFetchRequestIdRef.current !== requestId) return;
      const cached = loadOpenRouterModelCatalogCache();
      if (cached?.models.length) {
        setAvailableModels(cached.models);
        setHasLoadedModelCatalog(true);
        setModelCatalogStatus(
          `Model refresh failed (${formatErrorMessage(error)}). Using ${cached.models.length} cached models.`
        );
      } else {
        setHasLoadedModelCatalog(true);
        setModelCatalogStatus(`Failed to load models: ${formatErrorMessage(error)}`);
      }
    } finally {
      if (modelFetchRequestIdRef.current === requestId) {
        setIsLoadingModelCatalog(false);
      }
    }
  }, [formatErrorMessage]);

  const applyModelSelection = React.useCallback((modelId: string) => {
    setOpenRouterModel(modelId);
    setIsModelDropdownOpen(false);
    setHighlightedModelIndex(-1);
  }, []);

  const parsePreferredUrlLine = React.useCallback((line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return null;
    const [urlPart, ...descriptionParts] = trimmed.split("|");
    const url = urlPart?.trim() ?? "";
    if (!/^https?:\/\//i.test(url)) return null;
    const description = descriptionParts.join("|").trim();
    return { url, description };
  }, []);

  const buildPreferredUrlLine = React.useCallback((url: string, description: string) => {
    const trimmedDescription = description.trim();
    return trimmedDescription ? `${url} | ${trimmedDescription}` : url;
  }, []);

  const fetchPreferredUrlDescription = React.useCallback(async (url: string) => {
    const html = await invoke<string>("fetch_url", { url });
    const doc = new DOMParser().parseFromString(html, "text/html");
    const description =
      doc.querySelector('meta[name="description"]')?.getAttribute("content") ||
      doc.querySelector('meta[property="og:description"]')?.getAttribute("content") ||
      doc.querySelector('meta[name="twitter:description"]')?.getAttribute("content") ||
      doc.querySelector("title")?.textContent ||
      "";
    const cleaned = description.replace(/\s+/g, " ").trim();
    if (cleaned) return cleaned.slice(0, 200);
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return `Website for ${hostname}.`;
  }, []);

  const hydrateForm = React.useCallback(() => {
    const settings = loadOpenRouterSettings();
    setOpenRouterKey(settings.apiKey);
    setOpenRouterModel(settings.model || DEFAULT_OPENROUTER_MODEL);
    setOpenRouterReasoning(
      typeof settings.reasoning === "boolean"
        ? settings.reasoning
        : DEFAULT_OPENROUTER_REASONING
    );
    setTopicShiftSensitivity(
      Number.isFinite(settings.topicShiftSensitivity)
        ? settings.topicShiftSensitivity
        : DEFAULT_TOPIC_SHIFT_SENSITIVITY
    );
    setPreferredUrls(settings.preferredUrls || "");
    setPersona(settings.persona || NO_PERSONA_ID);
    setDeepDiveCooldownSeconds(
      Number.isFinite(settings.deepDiveCooldownSeconds)
        ? settings.deepDiveCooldownSeconds
        : DEFAULT_DEEP_DIVE_COOLDOWN_SECONDS
    );
    setEvaluationDelayMs(
      Number.isFinite(settings.evaluationDelayMs)
        ? settings.evaluationDelayMs
        : DEFAULT_EVALUATION_DELAY_MS
    );
    setDeveloperMode(
      typeof settings.developerMode === "boolean"
        ? settings.developerMode
        : DEFAULT_DEVELOPER_MODE
    );
    setDevTranscriptDelayMs(
      Number.isFinite(settings.devTranscriptDelayMs)
        ? settings.devTranscriptDelayMs
        : DEFAULT_DEV_TRANSCRIPT_DELAY_MS
    );
    setNarrativePrompt(settings.narrativePrompt || DEFAULT_NARRATIVE_PROMPT);
  }, []);

  const hydrateMcpConfig = React.useCallback(async () => {
    try {
      const response = await invoke<{ path: string; content: string }>(
        "get_mcp_config"
      );
      setMcpConfigJson(response.content || "");
      setMcpConfigPath(`Config file location: ${response.path}`);
    } catch (error) {
      setMcpConfigStatus(`Failed to load MCP config: ${String(error)}`);
    }
  }, []);

  const saveMcpConfig = React.useCallback(async () => {
    try {
      const response = await invoke<{ path: string; content: string }>(
        "save_mcp_config",
        { content: mcpConfigJson }
      );
      setMcpConfigJson(response.content || mcpConfigJson);
      setMcpConfigPath(`Config file location: ${response.path}`);
      setMcpConfigStatus("MCP config saved.");
    } catch (error) {
      setMcpConfigStatus(`Failed to save MCP config: ${String(error)}`);
    }
  }, [mcpConfigJson]);

  const testMcpConfig = React.useCallback(async () => {
    setMcpConfigStatus("Testing MCP servers...");
    try {
      const result = await invoke<string>("test_mcp_config");
      setMcpConfigStatus(result);
    } catch (error) {
      setMcpConfigStatus(`MCP test failed: ${String(error)}`);
    }
  }, []);

  const handleSaveSettings = React.useCallback(() => {
    const settings: OpenRouterSettings = {
      apiKey: openRouterKey.trim(),
      model: openRouterModel.trim() || DEFAULT_OPENROUTER_MODEL,
      reasoning: openRouterReasoning,
      preferredUrls: preferredUrls.trim(),
      topicShiftSensitivity,
      persona,
      deepDiveCooldownSeconds,
      evaluationDelayMs,
      developerMode,
      devTranscriptDelayMs,
      narrativePrompt,
    };
    saveOpenRouterSettings(settings);
    setSaveStatus("Settings saved.");
  }, [
    openRouterKey,
    openRouterModel,
    openRouterReasoning,
    preferredUrls,
    topicShiftSensitivity,
    persona,
    deepDiveCooldownSeconds,
    evaluationDelayMs,
    developerMode,
    devTranscriptDelayMs,
    narrativePrompt,
  ]);

  const handleClearKey = React.useCallback(() => {
    setOpenRouterKey("");
    clearOpenRouterKey();
    setSaveStatus("API key cleared.");
  }, []);

  const runTestPrompt = React.useCallback(async () => {
    const settings: OpenRouterSettings = {
      apiKey: openRouterKey.trim(),
      model: openRouterModel.trim() || DEFAULT_OPENROUTER_MODEL,
      reasoning: openRouterReasoning,
      preferredUrls: preferredUrls.trim(),
      topicShiftSensitivity,
      persona,
      deepDiveCooldownSeconds,
      evaluationDelayMs,
      developerMode,
      devTranscriptDelayMs,
      narrativePrompt,
    };

    if (!hasOpenRouterKey(settings)) {
      setTestResult("Add an API key to run the test.");
      return;
    }

    if (!testPrompt.trim()) {
      setTestResult("Enter a prompt to test.");
      return;
    }

    setTestResult("Running...");
    setIsTesting(true);

    const body: Record<string, unknown> = {
      model: settings.model,
      messages: [{ role: "user", content: testPrompt.trim() }],
    };
    if (settings.reasoning) {
      body.reasoning = { enabled: true };
    }

    try {
      const response = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${settings.apiKey}`,
          },
          body: JSON.stringify(body),
        }
      );

      const text = await response.text();
      let data: any = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text };
        }
      }
      if (!response.ok) {
        const message = data?.error?.message || `OpenRouter error (${response.status})`;
        throw new Error(message);
      }

      const content =
        data?.choices?.[0]?.message?.content ||
        data?.choices?.[0]?.delta?.content;
      setTestResult(
        typeof content === "string" && content.trim()
          ? content.trim()
          : JSON.stringify(data, null, 2)
      );
    } catch (error) {
      setTestResult(`Error: ${String(error)}`);
    } finally {
      setIsTesting(false);
    }
  }, [
    deepDiveCooldownSeconds,
    developerMode,
    devTranscriptDelayMs,
    evaluationDelayMs,
    narrativePrompt,
    openRouterKey,
    openRouterModel,
    openRouterReasoning,
    persona,
    preferredUrls,
    testPrompt,
    topicShiftSensitivity,
  ]);

  const applyPreferredUrlsFile = React.useCallback(async (file: File) => {
    try {
      const content = await file.text();
      setPreferredUrls(content.trim());
      setSaveStatus(`Loaded ${file.name}. Save settings to apply.`);
    } catch (error) {
      setSaveStatus(`Failed to read file: ${String(error)}`);
    } finally {
      if (preferredUrlFileInputRef.current) {
        preferredUrlFileInputRef.current.value = "";
      }
    }
  }, []);

  const addPreferredUrlDescriptions = React.useCallback(async () => {
    const lines = preferredUrls.split(/\r?\n/);
    const entries = lines.map((line) => {
      const parsed = parsePreferredUrlLine(line);
      return parsed ? { ...parsed, originalLine: line } : null;
    });
    const targets = entries.filter(
      (entry): entry is NonNullable<typeof entry> => Boolean(entry && !entry.description)
    );
    if (targets.length === 0) {
      setPreferredUrlStatus("All preferred URLs already have descriptions.");
      return;
    }

    setIsDescribingPreferredUrls(true);
    setPreferredUrlStatus(`Adding descriptions for ${targets.length} URL(s)...`);

    const updatedLines = [...lines];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry || entry.description) continue;
      try {
        const description = await fetchPreferredUrlDescription(entry.url);
        updatedLines[index] = buildPreferredUrlLine(entry.url, description);
      } catch (error) {
        updatedLines[index] = buildPreferredUrlLine(
          entry.url,
          `Description unavailable (${String(error)})`
        );
      }
    }

    setPreferredUrls(updatedLines.join("\n"));
    setPreferredUrlStatus("Descriptions added. Save settings to apply.");
    setIsDescribingPreferredUrls(false);
  }, [
    buildPreferredUrlLine,
    fetchPreferredUrlDescription,
    parsePreferredUrlLine,
    preferredUrls,
  ]);

  React.useEffect(() => {
    hydrateForm();
    void hydrateMcpConfig();
    setUserNotes(loadUserNotes());

    const cachedModelCatalog = loadOpenRouterModelCatalogCache();
    if (cachedModelCatalog?.models.length) {
      setAvailableModels(cachedModelCatalog.models);
      setHasLoadedModelCatalog(true);
      const formattedTimestamp = formatCacheTimestamp(cachedModelCatalog.fetchedAt);
      setModelCatalogStatus(
        formattedTimestamp
          ? `Loaded ${cachedModelCatalog.models.length} cached models (${formattedTimestamp}).`
          : `Loaded ${cachedModelCatalog.models.length} cached models.`
      );
    } else {
      setModelCatalogStatus("Loading model catalog...");
    }
    void refreshModelCatalog();

    const handleStorage = () => {
      hydrateForm();
      setUserNotes(loadUserNotes());
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [formatCacheTimestamp, hydrateForm, hydrateMcpConfig, refreshModelCatalog]);

  React.useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (modelPickerRef.current?.contains(target)) return;
      setIsModelDropdownOpen(false);
      setHighlightedModelIndex(-1);
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  React.useEffect(() => {
    if (!isModelDropdownOpen) {
      setHighlightedModelIndex(-1);
      return;
    }
    if (!filteredModelOptions.length) {
      setHighlightedModelIndex(-1);
      return;
    }
    setHighlightedModelIndex((previous) =>
      previous >= 0 && previous < filteredModelOptions.length ? previous : 0
    );
  }, [filteredModelOptions, isModelDropdownOpen]);

  React.useEffect(() => {
    const modelId = openRouterModel.trim();
    if (!modelId || !hasLoadedModelCatalog) {
      setModelSupportsReasoning(false);
      return;
    }

    if (!selectedCatalogModel) {
      setModelSupportsReasoning(false);
      if (openRouterReasoning) {
        setOpenRouterReasoning(false);
      }
      return;
    }

    const supportsReasoning = selectedCatalogModel.supportsReasoning;
    setModelSupportsReasoning(supportsReasoning);
    if (!supportsReasoning && openRouterReasoning) {
      setOpenRouterReasoning(false);
    }
  }, [hasLoadedModelCatalog, openRouterModel, openRouterReasoning, selectedCatalogModel]);

  const highlightedModelOptionId =
    isModelDropdownOpen &&
    highlightedModelIndex >= 0 &&
    highlightedModelIndex < filteredModelOptions.length
      ? `openrouter-model-option-${highlightedModelIndex}`
      : undefined;

  return (
    <div className="h-dvh overflow-hidden bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-6 overflow-hidden px-6 py-6">
        <header className="flex flex-none flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">
              Settings
            </p>
            <h1 className="text-2xl font-semibold">OpenRouter</h1>
            <p className="text-sm text-muted-foreground">
              Add your API key to unlock LLM calls for fact checks and context.
            </p>
          </div>
          <Badge
            variant={hasOpenRouterKey({
              apiKey: openRouterKey,
              model: openRouterModel,
              reasoning: openRouterReasoning,
              preferredUrls,
              topicShiftSensitivity,
              persona,
              deepDiveCooldownSeconds,
              evaluationDelayMs,
              developerMode,
              devTranscriptDelayMs,
              narrativePrompt,
            }) ? "secondary" : "outline"}
            className="text-xs"
          >
            {hasOpenRouterKey({
              apiKey: openRouterKey,
              model: openRouterModel,
              reasoning: openRouterReasoning,
              preferredUrls,
              topicShiftSensitivity,
              persona,
              deepDiveCooldownSeconds,
              evaluationDelayMs,
              developerMode,
              devTranscriptDelayMs,
              narrativePrompt,
            })
              ? "Key saved"
              : "Key not set"}
          </Badge>
        </header>

        <div className="grid min-h-0 flex-1 gap-6 overflow-y-auto pr-1 scrollbar-hidden md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Credentials</CardTitle>
              <CardDescription>
                Store your API key locally and choose a default model.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="openrouter-key">API key</Label>
                <div className="flex gap-2">
                  <Input
                    id="openrouter-key"
                    type={showKey ? "text" : "password"}
                    value={openRouterKey}
                    onChange={(event) => setOpenRouterKey(event.target.value)}
                    placeholder="sk-or-..."
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowKey((prev) => !prev)}
                  >
                    {showKey ? "Hide" : "Show"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Saved locally on this machine. We'll never log or transmit it elsewhere.
                </p>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="openrouter-model">Default model</Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void refreshModelCatalog()}
                    disabled={isLoadingModelCatalog}
                  >
                    {isLoadingModelCatalog ? "Refreshing..." : "Refresh"}
                  </Button>
                </div>
                <div ref={modelPickerRef} className="relative">
                  <Input
                    id="openrouter-model"
                    value={openRouterModel}
                    onChange={(event) => {
                      setOpenRouterModel(event.target.value);
                      setIsModelDropdownOpen(true);
                    }}
                    onFocus={() => setIsModelDropdownOpen(true)}
                    onBlur={() => {
                      window.setTimeout(() => {
                        if (!modelPickerRef.current?.contains(document.activeElement)) {
                          setIsModelDropdownOpen(false);
                          setHighlightedModelIndex(-1);
                        }
                      }, 0);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        setIsModelDropdownOpen(true);
                        setHighlightedModelIndex((previous) => {
                          if (!filteredModelOptions.length) return -1;
                          if (previous < 0) return 0;
                          return Math.min(previous + 1, filteredModelOptions.length - 1);
                        });
                        return;
                      }
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        setIsModelDropdownOpen(true);
                        setHighlightedModelIndex((previous) => {
                          if (!filteredModelOptions.length) return -1;
                          if (previous < 0) return filteredModelOptions.length - 1;
                          return Math.max(previous - 1, 0);
                        });
                        return;
                      }
                      if (event.key === "Enter") {
                        if (
                          isModelDropdownOpen &&
                          highlightedModelIndex >= 0 &&
                          highlightedModelIndex < filteredModelOptions.length
                        ) {
                          event.preventDefault();
                          applyModelSelection(filteredModelOptions[highlightedModelIndex].id);
                        }
                        return;
                      }
                      if (event.key === "Escape") {
                        setIsModelDropdownOpen(false);
                        setHighlightedModelIndex(-1);
                      }
                    }}
                    placeholder="anthropic/claude-sonnet-4"
                    role="combobox"
                    aria-autocomplete="list"
                    aria-controls={MODEL_DROPDOWN_ID}
                    aria-expanded={isModelDropdownOpen}
                    aria-activedescendant={highlightedModelOptionId}
                    autoComplete="off"
                  />
                  {isModelDropdownOpen ? (
                    <div
                      id={MODEL_DROPDOWN_ID}
                      role="listbox"
                      className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-input bg-background shadow-md"
                    >
                      {filteredModelOptions.length ? (
                        filteredModelOptions.map((model, index) => {
                          const isHighlighted = index === highlightedModelIndex;
                          const isSelected =
                            model.id.toLowerCase() === openRouterModel.trim().toLowerCase();
                          return (
                            <button
                              key={model.id}
                              id={`openrouter-model-option-${index}`}
                              type="button"
                              role="option"
                              aria-selected={isSelected}
                              className={cn(
                                "flex w-full flex-col items-start gap-1 border-b border-border/50 px-3 py-2 text-left transition-colors last:border-b-0",
                                isHighlighted
                                  ? "bg-accent text-accent-foreground"
                                  : "hover:bg-muted/50"
                              )}
                              onMouseDown={(event) => event.preventDefault()}
                              onMouseEnter={() => setHighlightedModelIndex(index)}
                              onClick={() => applyModelSelection(model.id)}
                            >
                              <span className="w-full truncate text-sm font-medium">
                                {model.name}
                              </span>
                              <span className="w-full truncate text-xs text-muted-foreground">
                                {model.id}
                              </span>
                            </button>
                          );
                        })
                      ) : (
                        <p className="px-3 py-2 text-xs text-muted-foreground">
                          No matching models. Keep typing to use a custom model id.
                        </p>
                      )}
                    </div>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {isLoadingModelCatalog
                    ? "Refreshing model catalog..."
                    : modelCatalogStatus ||
                      "Model catalog unavailable. You can still type a custom model id."}
                </p>
              </div>
              {modelSupportsReasoning ? (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={openRouterReasoning}
                    onChange={(event) => setOpenRouterReasoning(event.target.checked)}
                  />
                  Include reasoning payload
                </label>
              ) : null}
              <div className="flex gap-2">
                <Button onClick={handleSaveSettings}>Save settings</Button>
                <Button variant="ghost" onClick={handleClearKey}>
                  Clear key
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{saveStatus}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Test Prompt</CardTitle>
              <CardDescription>Send a quick prompt to verify the connection.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="openrouter-test-prompt">Test prompt</Label>
                <Textarea
                  id="openrouter-test-prompt"
                  rows={4}
                  value={testPrompt}
                  onChange={(event) => setTestPrompt(event.target.value)}
                />
              </div>
              <Button onClick={runTestPrompt} disabled={isTesting}>
                {isTesting ? "Running..." : "Run test"}
              </Button>
              <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
                {testResult || "No test run yet."}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Browser Automation</CardTitle>
              <CardDescription>
                Browser deep dives are driven automatically from transcript topic shifts.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Deep dives launch directly based on conversation changes and direct
                "Hey Jamie" commands. Preferred URLs are evaluated first when planning each run.
              </p>
              <div className="space-y-2">
                <Label htmlFor="topic-shift-sensitivity">Topic shift sensitivity</Label>
                <select
                  id="topic-shift-sensitivity"
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  value={topicShiftSensitivity}
                  onChange={(event) =>
                    setTopicShiftSensitivity(Number(event.target.value))
                  }
                >
                  {TOPIC_SHIFT_SENSITIVITY_LEVELS.map((level) => (
                    <option key={level.value} value={level.value}>
                      {level.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  {describeTopicShiftSensitivity(topicShiftSensitivity)}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="deep-dive-cooldown">Deep dive cooldown</Label>
                <select
                  id="deep-dive-cooldown"
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  value={deepDiveCooldownSeconds}
                  onChange={(event) =>
                    setDeepDiveCooldownSeconds(Number(event.target.value))
                  }
                >
                  {DEEP_DIVE_COOLDOWN_LEVELS.map((level) => (
                    <option key={level.value} value={level.value}>
                      {level.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  {
                    DEEP_DIVE_COOLDOWN_LEVELS.find(
                      (level) => level.value === deepDiveCooldownSeconds
                    )?.description
                  }
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="evaluation-delay">Evaluation delay</Label>
                <select
                  id="evaluation-delay"
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  value={evaluationDelayMs}
                  onChange={(event) =>
                    setEvaluationDelayMs(Number(event.target.value))
                  }
                >
                  {EVALUATION_DELAY_LEVELS.map((level) => (
                    <option key={level.value} value={level.value}>
                      {level.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  {describeEvaluationDelay(evaluationDelayMs)}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="persona-select">Co-host persona</Label>
                <select
                  id="persona-select"
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  value={persona}
                  onChange={(event) => setPersona(event.target.value)}
                >
                  <option value={NO_PERSONA_ID}>None</option>
                  {PERSONAS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  {PERSONAS.find((p) => p.id === persona)?.description ??
                    "No persona active. Deep dives use default behavior."}
                </p>
                <button
                  type="button"
                  className="text-xs text-primary underline underline-offset-2 hover:text-primary/80"
                  onClick={async () => {
                    try {
                      const dir = await invoke<string>("get_personas_dir");
                      await revealItemInDir(dir);
                    } catch (error) {
                      console.error("Failed to reveal personas directory:", error);
                    }
                  }}
                >
                  Open personas folder
                </button>
              </div>
              <div className="space-y-2">
                <Label htmlFor="narrative-prompt">Planner instructions</Label>
                <Textarea
                  id="narrative-prompt"
                  rows={10}
                  value={narrativePrompt}
                  onChange={(event) => setNarrativePrompt(event.target.value)}
                  className="font-mono text-xs"
                />
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setNarrativePrompt(DEFAULT_NARRATIVE_PROMPT)}
                    disabled={narrativePrompt === DEFAULT_NARRATIVE_PROMPT}
                  >
                    Reset to default
                  </Button>
                  {narrativePrompt !== DEFAULT_NARRATIVE_PROMPT && (
                    <span className="text-xs text-muted-foreground">Custom prompt active</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Controls how HeyJamie's planner decides what to do next (search, browse, draw diagrams, etc.).
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="preferred-url-list">Preferred URLs (one per line)</Label>
                <Textarea
                  id="preferred-url-list"
                  rows={6}
                  value={preferredUrls}
                  onChange={(event) => setPreferredUrls(event.target.value)}
                  placeholder="https://example.com/source | What this site covers"
                />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={handleSaveSettings}>Save</Button>
                <Button
                  variant="outline"
                  onClick={addPreferredUrlDescriptions}
                  disabled={isDescribingPreferredUrls}
                >
                  {isDescribingPreferredUrls
                    ? "Describing links..."
                    : "Add missing link descriptions"}
                </Button>
                {preferredUrlStatus && (
                  <span className="text-xs text-muted-foreground">{preferredUrlStatus}</span>
                )}
              </div>
              <div
                className={cn(
                  "rounded-lg border border-dashed border-border/70 bg-muted/20 p-4 text-center text-sm text-muted-foreground transition-colors",
                  "cursor-pointer hover:border-primary/40 hover:bg-muted/40",
                  preferredUrlDropActive && "border-primary/60 bg-primary/10 text-foreground"
                )}
                role="button"
                tabIndex={0}
                onClick={() => preferredUrlFileInputRef.current?.click()}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    preferredUrlFileInputRef.current?.click();
                  }
                }}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setPreferredUrlDropActive(true);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  setPreferredUrlDropActive(true);
                }}
                onDragLeave={(event) => {
                  event.preventDefault();
                  setPreferredUrlDropActive(false);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setPreferredUrlDropActive(false);
                  const file = event.dataTransfer?.files?.[0];
                  if (file) {
                    void applyPreferredUrlsFile(file);
                  }
                }}
              >
                <p className="font-medium text-foreground">Drop a URL list file here</p>
                <p className="text-xs">or click to upload a plain text file</p>
                <input
                  ref={preferredUrlFileInputRef}
                  className="hidden"
                  type="file"
                  accept=".txt,.md,text/plain"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      void applyPreferredUrlsFile(file);
                    }
                  }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Keep this list focused on trusted domains. Relevant entries are opened before fresh searches.
              </p>
              <p className="text-sm text-muted-foreground">
                Ensure your MCP config includes a Chrome DevTools MCP server (for example
                <code className="ml-1 rounded bg-muted px-1 py-0.5 text-xs">{"\"chrome-devtools\": { \"command\": \"npx\", \"args\": [\"-y\", \"chrome-devtools-mcp@latest\", \"--ignore-default-chrome-arg=--enable-automation\"] }"}</code>).
                Chrome DevTools MCP will launch its own Chrome instance automatically.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>MCP Config</CardTitle>
              <CardDescription>Manage available MCP servers.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-xs text-muted-foreground">
                Optional per-server flag: set <code className="rounded bg-muted px-1 py-0.5 text-[11px]">"enabled": false</code> to disable a server without deleting its config.
              </p>
              <p className="text-xs text-muted-foreground">{mcpConfigPath}</p>
              <div className="space-y-2">
                <Label htmlFor="mcp-config-json">Config JSON</Label>
                <Textarea
                  id="mcp-config-json"
                  rows={8}
                  value={mcpConfigJson}
                  onChange={(event) => setMcpConfigJson(event.target.value)}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={saveMcpConfig}>Save MCP config</Button>
                <Button variant="outline" onClick={hydrateMcpConfig}>
                  Reload
                </Button>
                <Button variant="ghost" onClick={testMcpConfig}>
                  Test MCP servers
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{mcpConfigStatus}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>User Notes</CardTitle>
              <CardDescription>
                Preferences and instructions that are included in all LLM prompts.
                You can also add notes by saying "Hey Jamie, remember that..."
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {userNotes.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No notes yet. Add one below or say "Hey Jamie, remember that I prefer..." to save a note by voice.
                </p>
              ) : (
                <ul className="space-y-2">
                  {userNotes.map((note) => (
                    <li
                      key={note.id}
                      className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/20 p-2"
                    >
                      {editingNoteId === note.id ? (
                        <div className="flex-1 space-y-2">
                          <Textarea
                            rows={2}
                            value={editingNoteText}
                            onChange={(e) => setEditingNoteText(e.target.value)}
                            className="text-sm"
                          />
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              onClick={() => {
                                if (editingNoteText.trim()) {
                                  updateUserNote(note.id, editingNoteText);
                                  setUserNotes(loadUserNotes());
                                }
                                setEditingNoteId(null);
                                setEditingNoteText("");
                              }}
                            >
                              Save
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setEditingNoteId(null);
                                setEditingNoteText("");
                              }}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="flex-1 text-sm">{note.text}</p>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setEditingNoteId(note.id);
                              setEditingNoteText(note.text);
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              removeUserNote(note.id);
                              setUserNotes(loadUserNotes());
                            }}
                          >
                            Remove
                          </Button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex gap-2">
                <Input
                  placeholder="Add a new note..."
                  value={newNoteText}
                  onChange={(e) => setNewNoteText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newNoteText.trim()) {
                      addUserNote(newNoteText);
                      setUserNotes(loadUserNotes());
                      setNewNoteText("");
                    }
                  }}
                />
                <Button
                  onClick={() => {
                    if (newNoteText.trim()) {
                      addUserNote(newNoteText);
                      setUserNotes(loadUserNotes());
                      setNewNoteText("");
                    }
                  }}
                >
                  Add
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="col-span-full flex items-center gap-3 rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
            <Checkbox
              id="developer-mode"
              checked={developerMode}
              onChange={(event) => {
                const checked = event.target.checked;
                setDeveloperMode(checked);
                const current = loadOpenRouterSettings();
                saveOpenRouterSettings({ ...current, developerMode: checked });
                void invoke("set_dev_settings_menu_visible", { visible: checked });
              }}
            />
            <div>
              <Label htmlFor="developer-mode" className="cursor-pointer text-sm font-medium">
                Developer mode
              </Label>
              <p className="text-xs text-muted-foreground">
                Enable transcript playback controls for testing without a live microphone.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
