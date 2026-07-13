import { getOpenAIConnectionSettings } from '@line-crm/db';

export interface OpenAIEnvSettings {
  OPENAI_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
}

export interface EffectiveOpenAISettings {
  baseUrl: string | null;
  apiKey: string | null;
  model: string | null;
  /** Per-variable: true when the server env var is set and therefore wins over the admin-saved value. */
  envOverride: {
    baseUrl: boolean;
    apiKey: boolean;
    model: boolean;
  };
}

const GLOBAL_ACCOUNT_ID = '__global__';

function trimOrNull(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Resolve the effective OpenAI connection settings.
 *
 * Precedence (per variable, not all-or-nothing): server env var wins over the
 * admin-saved (DB) value; the DB value applies only when the env var is unset
 * or blank. The `envOverride` flags let callers (the settings GET endpoint)
 * surface which fields the env is overriding so admin edits are never
 * silently ignored.
 */
export async function getEffectiveOpenAISettings(
  db: D1Database,
  env: OpenAIEnvSettings,
): Promise<EffectiveOpenAISettings> {
  const persisted = await getOpenAIConnectionSettings(db, GLOBAL_ACCOUNT_ID);
  const envBaseUrl = trimOrNull(env.OPENAI_BASE_URL);
  const envApiKey = trimOrNull(env.OPENAI_API_KEY);
  const envModel = trimOrNull(env.OPENAI_MODEL);
  return {
    baseUrl: envBaseUrl ?? trimOrNull(persisted.baseUrl),
    apiKey: envApiKey ?? trimOrNull(persisted.apiKey),
    model: envModel ?? trimOrNull(persisted.model),
    envOverride: {
      baseUrl: envBaseUrl !== null,
      apiKey: envApiKey !== null,
      model: envModel !== null,
    },
  };
}
