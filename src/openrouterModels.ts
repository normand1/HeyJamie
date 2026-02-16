export type OpenRouterModelCatalogItem = {
  id: string;
  name: string;
  supportsReasoning: boolean;
  searchText: string;
};

export type OpenRouterModelCatalogCache = {
  fetchedAt: number;
  models: OpenRouterModelCatalogItem[];
};

const MODEL_CATALOG_CACHE_KEY = "heyjamie.openrouter.models.cache.v1";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

type OpenRouterModelApiItem = {
  id?: unknown;
  name?: unknown;
  supported_parameters?: unknown;
};

function normalizeModelItem(item: OpenRouterModelApiItem): OpenRouterModelCatalogItem | null {
  const id = typeof item.id === "string" ? item.id.trim() : "";
  const name = typeof item.name === "string" ? item.name.trim() : "";
  if (!id || !name) return null;

  const supportsReasoning =
    Array.isArray(item.supported_parameters) &&
    item.supported_parameters.includes("reasoning");

  return {
    id,
    name,
    supportsReasoning,
    searchText: `${id} ${name}`.toLowerCase(),
  };
}

function sortModels(models: OpenRouterModelCatalogItem[]): OpenRouterModelCatalogItem[] {
  return [...models].sort((a, b) => {
    const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id, undefined, { sensitivity: "base" });
  });
}

function sanitizeModels(rawModels: unknown): OpenRouterModelCatalogItem[] {
  if (!Array.isArray(rawModels)) return [];
  const seen = new Set<string>();
  const parsed: OpenRouterModelCatalogItem[] = [];

  for (const entry of rawModels) {
    const normalized = normalizeModelItem((entry ?? {}) as OpenRouterModelApiItem);
    if (!normalized) continue;
    const key = normalized.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push(normalized);
  }

  return sortModels(parsed);
}

export async function fetchOpenRouterModels(
  signal?: AbortSignal
): Promise<OpenRouterModelCatalogItem[]> {
  const response = await fetch(OPENROUTER_MODELS_URL, { signal });
  if (!response.ok) {
    throw new Error(`OpenRouter model catalog request failed (${response.status}).`);
  }

  const payload = (await response.json()) as { data?: unknown };
  const models = sanitizeModels(payload?.data);
  if (models.length === 0) {
    throw new Error("OpenRouter model catalog returned no usable models.");
  }
  return models;
}

export function loadOpenRouterModelCatalogCache(): OpenRouterModelCatalogCache | null {
  const raw = localStorage.getItem(MODEL_CATALOG_CACHE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as {
      fetchedAt?: unknown;
      models?: unknown;
    };
    const fetchedAt = Number(parsed.fetchedAt);
    if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) {
      return null;
    }
    const models = sanitizeModels(parsed.models);
    if (!models.length) {
      return null;
    }
    return { fetchedAt, models };
  } catch {
    return null;
  }
}

export function saveOpenRouterModelCatalogCache(models: OpenRouterModelCatalogItem[]): void {
  const sanitized = sanitizeModels(models);
  if (!sanitized.length) return;

  const payload: OpenRouterModelCatalogCache = {
    fetchedAt: Date.now(),
    models: sanitized,
  };
  localStorage.setItem(MODEL_CATALOG_CACHE_KEY, JSON.stringify(payload));
}
