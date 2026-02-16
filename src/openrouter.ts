export type OpenRouterSettings = {
  apiKey: string;
  model: string;
  reasoning: boolean;
  preferredUrls: string;
  topicShiftSensitivity: number;
  persona: string;
  deepDiveCooldownSeconds: number;
  evaluationDelayMs: number;
  developerMode: boolean;
  devTranscriptDelayMs: number;
  narrativePrompt: string;
};

const DEFAULT_OPENROUTER_MODEL_FALLBACK = "anthropic/claude-sonnet-4.5";
const ENV_OPENROUTER_API_KEY = (
  import.meta.env.VITE_HEYJAMIE_OPENROUTER_API_KEY ?? ""
).trim();
const ENV_OPENROUTER_MODEL = (
  import.meta.env.VITE_HEYJAMIE_LLM_MODEL ?? ""
).trim();
export const DEFAULT_OPENROUTER_MODEL =
  ENV_OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL_FALLBACK;
export const DEFAULT_OPENROUTER_REASONING = true;
export const DEFAULT_TOPIC_SHIFT_SENSITIVITY = 3;
export const DEFAULT_DEEP_DIVE_COOLDOWN_SECONDS = 0;
export const DEFAULT_EVALUATION_DELAY_MS = 1200;
export const DEFAULT_DEVELOPER_MODE = false;
export const DEFAULT_DEV_TRANSCRIPT_DELAY_MS = 550;
export const DEFAULT_NARRATIVE_PROMPT = `You are the "Hey Jamie" intent planner. Your FIRST decision is choosing actionType.

## CRITICAL: Topic Shift Detection (Read This First!)
If a "latestSpeech" field is present in the context JSON, it contains ONLY the newest lines spoken since the last evaluation. Your actionType decision MUST be based on latestSpeech, NOT on the older fullTranscript. The fullTranscript is background context only.

When latestSpeech discusses a DIFFERENT subject than the fullTranscript, this is a TOPIC SHIFT. Examples:
- fullTranscript: discussing system architecture → latestSpeech: mentioning podcasts, news, or articles = BROWSER action
- fullTranscript: searching for articles → latestSpeech: describing a diagram or flowchart = EXCALIDRAW action

If latestSpeech mentions podcasts, videos, articles, news, people, shows, or any topic that would benefit from web search/browsing, set actionType to "browser" — even if the fullTranscript discussed diagrams or architecture.

If latestSpeech is not present, fall back to using the "*** Most recent messages below ***" separator in fullTranscript.

## Action Type Decision (REQUIRED — decide this first)
Base this decision on latestSpeech (if present) or the most recent transcript text:
- Set actionType to "excalidraw" when the latest speech describes systems, architectures, relationships, or processes that benefit from a visual diagram.
- Set actionType to "browser" when the latest speech involves web searches, looking up information, reading articles, podcasts, videos, news, or any task requiring a web browser.
- Default to "browser" when there is no clear diagram opportunity in the latest speech.

## When actionType is "excalidraw":
Synthesize a coherent diagram specification from the full transcript, even if the user described it incrementally or made corrections along the way. Later corrections supersede earlier statements.
If the transcript describes sections, subgraphs, or stages, capture that structure in the excalidrawPrompt — list each section with its nodes and connections.
Set excalidrawPrompt to a detailed description of the diagram to create: what boxes/nodes to draw, what arrows/connections to add, what labels to use, and how to arrange them spatially.
Set excalidrawSystemPrompt to: "You are a diagram creation agent. Use the Excalidraw MCP tools to create a clear, well-organized diagram."
Set query to a short topic summary. The browserosPrompt, browserosSystemPrompt, and startUrl fields can be empty strings.

## When actionType is "browser":
Priority 1: if directCommand is present, create a plan that safely and precisely fulfills that direct command.
Priority 2: otherwise, propose the most valuable next browsing/search action for the ongoing conversation.
For non-direct requests, convert transcript language into a clean search query phrase.
Do not copy imperative words into query (for example prioritize, focus, start with, first batch, open, click).
Use query as plain search terms only; put ranking or execution instructions into browserosPrompt.
Keep browserosPrompt concise and action-oriented; do not add extra deliverables like screenshots unless the user explicitly asks.
Do not invent extra constraints (for example fixed counts like top 5) unless the transcript explicitly asks for them.
When choosing between PDF and HTML versions of a document, always prefer the HTML link over the PDF.
The browser automation uses Chrome DevTools MCP tools: use take_snapshot to observe the page (returns an a11y tree with uid identifiers), click with uid to interact with elements, navigate_page for URL navigation, fill for typing into inputs, and press_key for keyboard actions.
When the direct command mentions a specific URL (e.g. 'go to arxiv.org/list/cs.AI/recent'), set startUrl to that exact URL (with https:// prefix). Do NOT set startUrl to a Google search.
When the direct command references content on the current page by position (e.g., 'open the third link', 'click the first result', 'scroll down', 'go back'), set startUrl to lastBrowserOSPageUrl. The user is referring to elements on the currently loaded page, NOT asking for a new search.
When the user asks to find or open a specific paper by title, set startUrl to a Google search with site:arxiv.org filter. Example: https://www.google.com/search?q=site:arxiv.org+PAPER_TITLE+html Write browserosPrompt like: 'Find the arxiv.org result for PAPER_TITLE and click the link that leads to the HTML version of the paper.' IMPORTANT: do NOT use arXiv's own search — use Google with site:arxiv.org filter.`;

const STORAGE_KEY = "heyjamie.openrouter";

function normalizeSettings(
  settings: Partial<OpenRouterSettings> | null | undefined
): OpenRouterSettings {
  const normalizedApiKey = settings?.apiKey?.trim() || ENV_OPENROUTER_API_KEY || "";
  const normalizedModel =
    ENV_OPENROUTER_MODEL || settings?.model?.trim() || DEFAULT_OPENROUTER_MODEL;
  const rawSensitivity = Number(settings?.topicShiftSensitivity);
  const normalizedSensitivity = Number.isFinite(rawSensitivity)
    ? Math.min(5, Math.max(1, Math.round(rawSensitivity)))
    : DEFAULT_TOPIC_SHIFT_SENSITIVITY;
  const rawCooldown = Number(settings?.deepDiveCooldownSeconds);
  const normalizedCooldown =
    Number.isFinite(rawCooldown) && rawCooldown >= 0
      ? Math.round(rawCooldown)
      : DEFAULT_DEEP_DIVE_COOLDOWN_SECONDS;
  const rawDelay = Number(settings?.evaluationDelayMs);
  const normalizedDelay =
    Number.isFinite(rawDelay) && rawDelay >= 200
      ? Math.round(rawDelay)
      : DEFAULT_EVALUATION_DELAY_MS;
  const rawDevDelay = Number(settings?.devTranscriptDelayMs);
  const normalizedDevDelay =
    Number.isFinite(rawDevDelay) && rawDevDelay >= 50
      ? Math.round(rawDevDelay)
      : DEFAULT_DEV_TRANSCRIPT_DELAY_MS;
  return {
    apiKey: normalizedApiKey,
    model: normalizedModel,
    reasoning:
      typeof settings?.reasoning === "boolean"
        ? settings.reasoning
        : DEFAULT_OPENROUTER_REASONING,
    preferredUrls: settings?.preferredUrls?.trim() ?? "",
    topicShiftSensitivity: normalizedSensitivity,
    persona: typeof settings?.persona === "string" ? settings.persona.trim() : "",
    deepDiveCooldownSeconds: normalizedCooldown,
    evaluationDelayMs: normalizedDelay,
    developerMode:
      typeof settings?.developerMode === "boolean"
        ? settings.developerMode
        : DEFAULT_DEVELOPER_MODE,
    devTranscriptDelayMs: normalizedDevDelay,
    narrativePrompt:
      typeof settings?.narrativePrompt === "string" && settings.narrativePrompt.trim()
        ? settings.narrativePrompt
        : DEFAULT_NARRATIVE_PROMPT,
  };
}

export function loadOpenRouterSettings(): OpenRouterSettings {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return normalizeSettings({});
  }
  try {
    const parsed = JSON.parse(raw) as Partial<OpenRouterSettings>;
    return normalizeSettings(parsed);
  } catch {
    return normalizeSettings({});
  }
}

export function saveOpenRouterSettings(settings: OpenRouterSettings): void {
  const normalized = normalizeSettings(settings);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
}

export function clearOpenRouterKey(): void {
  const current = loadOpenRouterSettings();
  saveOpenRouterSettings({ ...current, apiKey: "" });
}

export function hasOpenRouterKey(settings: OpenRouterSettings): boolean {
  return Boolean(settings.apiKey.trim());
}
