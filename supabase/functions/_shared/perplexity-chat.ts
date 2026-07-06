// Shared Perplexity Chat Completions client — the conversational counterpart
// to _shared/perplexity-agent.ts.
//
// The Agent client (perplexity-agent.ts) drives Atlas's structured URL/JSON
// resolution via the managed /v1/agent preset. Memo (the consumer concierge)
// instead needs a NATURAL-LANGUAGE, web-grounded answer with citations and
// follow-up questions, so it hits the OpenAI-compatible Chat Completions
// endpoint with the Sonar search models.
//
// Product choice: `sonar-pro` — Perplexity's advanced search model, ideal for
// "complex queries and follow-ups" with web grounding + inline citations.
// That's exactly a flexible dining/nightlife concierge. `sonar` (cheaper,
// lighter) is available via the `model` opt for high-volume/cost-sensitive
// calls. Docs: https://docs.perplexity.ai/getting-started/models
//
// Best-effort: any non-2xx / network / parse failure returns null so the
// caller degrades gracefully (Memo still ships place cards without prose).

const PERPLEXITY_CHAT_URL = "https://api.perplexity.ai/chat/completions";
const DEFAULT_MODEL = "sonar-pro";

export type PplxMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type PplxChatResult = {
  text: string;
  citations: string[];
  related: string[];
};

export type PplxChatOpts = {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  // Bias search to recent results — handy for "open now / this weekend" asks.
  recency?: "hour" | "day" | "week" | "month" | "year";
  // Restrict/boost specific domains (e.g. review sites). Empty = no filter.
  searchDomainFilter?: string[];
  returnRelated?: boolean;
  // Force structured output, e.g. { type: "json_schema", json_schema: { schema } }.
  // When set, the model returns strict JSON in message.content (parse it yourself).
  responseFormat?: unknown;
};

// Call Perplexity Chat Completions once. Returns the assistant prose plus the
// web sources it cited and any suggested follow-up questions. null on failure.
export async function callPerplexityChat(
  key: string,
  messages: PplxMessage[],
  opts: PplxChatOpts = {},
): Promise<PplxChatResult | null> {
  try {
    const r = await fetch(PERPLEXITY_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model ?? DEFAULT_MODEL,
        messages,
        max_tokens: opts.maxTokens ?? 700,
        temperature: opts.temperature ?? 0.3,
        return_related_questions: opts.returnRelated ?? true,
        ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}),
        ...(opts.recency ? { search_recency_filter: opts.recency } : {}),
        ...(opts.searchDomainFilter && opts.searchDomainFilter.length > 0
          ? { search_domain_filter: opts.searchDomainFilter }
          : {}),
      }),
    });
    if (!r.ok) {
      console.error(
        "[perplexity-chat] non-2xx:",
        r.status,
        (await r.text()).slice(0, 300),
      );
      return null;
    }
    const d = (await r.json()) as {
      choices?: { message?: { content?: string } }[];
      citations?: unknown;
      search_results?: { url?: unknown }[];
      related_questions?: unknown;
    };

    const text = d.choices?.[0]?.message?.content?.trim() ?? "";

    // Citations arrive as a bare URL array on `citations`; newer responses
    // also carry richer `search_results[]`. Prefer the former, fall back.
    let citations: string[] = [];
    if (Array.isArray(d.citations)) {
      citations = d.citations.filter((c): c is string => typeof c === "string");
    } else if (Array.isArray(d.search_results)) {
      citations = d.search_results
        .map((s) => s?.url)
        .filter((u): u is string => typeof u === "string");
    }

    const related = Array.isArray(d.related_questions)
      ? d.related_questions.filter((q): q is string => typeof q === "string")
      : [];

    return { text, citations, related };
  } catch (e) {
    console.error("[perplexity-chat] threw:", (e as Error).message);
    return null;
  }
}
