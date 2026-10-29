/**
 * AgentPhone API client.
 *
 * Minimal typed HTTP client for the AgentPhone REST API.
 * Used by the MCP server to proxy tool calls to the backend.
 */

type WebhookDelivery = {
  id: string;
  eventType: string | null;
  status: string;
  httpStatus: number | null;
  lastAttemptAt: string | null;
  createdAt: string;
};

type WebhookTestResult = {
  success: boolean;
  // The deployed endpoints return httpStatus/errorMessage; the older
  // statusCode/error are kept optional as a compatibility fallback.
  httpStatus?: number | null;
  errorMessage?: string | null;
  statusCode?: number | null;
  error?: string | null;
};

// Optional per-call controls accepted by POST /v1/calls (CreateOutboundCallRequest):
// recording choice, dynamic variables, a model-tier override, and call-screening.
export type CallControls = {
  disableRecording?: boolean;
  variables?: Record<string, string>;
  modelTier?: string;
  callScreeningIdentity?: string;
  callScreeningPurpose?: string;
};

// Forward only the controls the caller actually set, so an omitted field leaves
// the backend default untouched.
function applyCallControls(body: Record<string, unknown>, opts?: CallControls): void {
  if (!opts) return;
  if (opts.disableRecording !== undefined) body.disableRecording = opts.disableRecording;
  if (opts.variables !== undefined) body.variables = opts.variables;
  if (opts.modelTier !== undefined) body.modelTier = opts.modelTier;
  if (opts.callScreeningIdentity !== undefined) body.callScreeningIdentity = opts.callScreeningIdentity;
  if (opts.callScreeningPurpose !== undefined) body.callScreeningPurpose = opts.callScreeningPurpose;
}

export class AgentPhoneAPI {
  private baseUrl: string;
  // A static key, or a getter resolved per request (used when the credential
  // comes from the per-request OAuth token rather than a fixed env var).
  private apiKey: string | (() => string);

  constructor(baseUrl: string, apiKey: string | (() => string)) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const token = typeof this.apiKey === "function" ? this.apiKey() : this.apiKey;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const timeout = timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        let detail = text;
        try {
          detail = formatApiErrorDetail(JSON.parse(text)) ?? text;
        } catch {
          // non-JSON body: keep the raw text
        }
        detail = redactSecrets(detail) || `HTTP ${res.status}`;
        const retryAfter = res.headers.get("retry-after");
        throw new ApiError(res.status, method, path, detail, retryAfter);
      }

      // Treat any empty body as {} — not just 204. A 200 with no content (which
      // some DELETE endpoints return) would otherwise throw from res.json().
      const text = await res.text();
      if (!text) return {} as T;
      return JSON.parse(text) as T;
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw new ApiError(0, method, path, `Request timed out after ${timeout}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // DELETE endpoints may answer 204 with no body, for which request() returns
  // {}. request() rejects on any non-2xx, so a value here means the delete
  // succeeded — normalize to an explicit { success: true } that callers and the
  // tools' output schemas rely on (otherwise a 204 yields {} and fails
  // structuredContent validation).
  private async deleteExpectingSuccess(path: string): Promise<{ success: boolean }> {
    await this.request("DELETE", path);
    return { success: true };
  }

  // --- Numbers ---

  async listNumbers(limit = 20, offset = 0) {
    return this.request<{
      data: Array<{
        id: string;
        phoneNumber: string;
        country: string;
        status: string;
        agentId: string | null;
        createdAt: string;
      }>;
      hasMore: boolean;
      total: number;
    }>("GET", `/v1/numbers?limit=${limit}&offset=${offset}`);
  }

  async buyNumber(country = "US", agentId?: string, areaCode?: string) {
    return this.request<{
      id: string;
      phoneNumber: string;
      country: string;
      status: string;
      agentId: string | null;
      createdAt: string;
    }>("POST", "/v1/numbers", { country, agentId, areaCode });
  }

  async releaseNumber(numberId: string) {
    return this.request<{
      success: boolean;
      phoneNumber: string;
      status: string;
    }>("DELETE", `/v1/numbers/${encodeURIComponent(numberId)}`);
  }

  // --- SMS / Messages ---

  async getMessages(
    numberId: string,
    limit = 50,
    opts?: { before?: string; after?: string; cursor?: string }
  ) {
    const query = new URLSearchParams({ limit: String(limit) });
    // The backend treats `cursor` as the primary continuation token and ignores
    // before/after when it is present; before/after remain time filters.
    if (opts?.cursor !== undefined) query.set("cursor", opts.cursor);
    if (opts?.before !== undefined) query.set("before", opts.before);
    if (opts?.after !== undefined) query.set("after", opts.after);
    const res = await this.request<{
      data: Array<{
        id: string;
        from?: string | null;
        // The deployed MessageResponse exposes the sender as `from_`.
        from_?: string | null;
        to: string;
        body: string;
        receivedAt: string;
      }>;
      hasMore: boolean;
      nextCursor?: string | null;
    }>("GET", `/v1/numbers/${encodeURIComponent(numberId)}/messages?${query}`);
    // Normalize the sender to `from` so the formatter and output schema have a
    // single, explicit field (the API returns `from_`; keep `from` as a fallback
    // for any older shape).
    return {
      ...res,
      data: res.data.map(({ from_, ...m }) => ({ ...m, from: from_ ?? m.from ?? null })),
    };
  }

  async sendMessage(params: {
    agentId?: string;
    toNumber?: string;
    recipients?: string[];
    channel?: string;
    body: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    numberId?: string;
    fromNumber?: string;
    replyToMessageId?: string;
    sendStyle?: string;
    buttons?: string[];
    list?: Record<string, unknown>;
    cta?: Record<string, unknown>;
    template?: Record<string, unknown>;
  }) {
    return this.request<{
      id: string;
      status: string;
      channel: string | null;
      from_number: string;
      to_number: string;
      media_urls: string[];
      reply_to_message_id: string | null;
      reply_parent_unresolved: boolean | null;
    }>("POST", "/v1/messages", {
      agent_id: params.agentId,
      to_number: params.toNumber,
      // Empty arrays would otherwise reach the wire as a (rejected) destination;
      // treat them as absent so to_number can send alone.
      recipients: params.recipients?.length ? params.recipients : undefined,
      channel: params.channel,
      body: params.body,
      media_url: params.mediaUrl,
      media_urls: params.mediaUrls,
      number_id: params.numberId,
      from_number: params.fromNumber,
      reply_to_message_id: params.replyToMessageId,
      send_style: params.sendStyle,
      buttons: params.buttons?.length ? params.buttons : undefined,
      list: params.list,
      cta: params.cta,
      template: params.template,
    });
  }

  // Which messaging channels a phone number can receive (imessage / sms / rcs).
  async getContactCapabilities(phoneNumber: string) {
    return this.request<{
      phoneNumber: string;
      capabilities: { imessage?: boolean | null; sms?: boolean | null; rcs?: boolean | null };
      checkedAt: string;
    }>("GET", `/v1/contacts/capabilities?phone_number=${encodeURIComponent(phoneNumber)}`);
  }

  async sendReaction(messageId: string, reaction: string) {
    return this.request<{
      id: string;
      reaction_type: string;
      message_id: string;
      channel: string;
    }>("POST", `/v1/messages/${encodeURIComponent(messageId)}/reactions`, {
      reaction,
    });
  }

  // --- Agents ---

  async listVoices() {
    return this.request<{
      data: Array<{
        voice_id: string;
        voice_name: string;
        provider: string;
        gender: string;
        accent: string;
        preview_audio_url: string | null;
      }>;
    }>("GET", "/v1/agents/voices");
  }

  async listAgents(limit = 20, offset = 0) {
    return this.request<{
      data: Array<{
        id: string;
        name: string;
        description: string | null;
        voiceMode: string;
        systemPrompt: string | null;
        beginMessage: string | null;
        voice: string;
        modelTier: string;
        transferNumber: string | null;
        voicemailMessage: string | null;
        sttMode: string;
        ambientSound: string;
        denoisingMode: string;
        maxSilenceMs: number;
        enableMessaging: boolean;
        enableBackchannel: boolean;
        interruptionSensitivity: number;
        voiceSpeed: number;
        language: string;
        createdAt: string;
        numbers?: Array<{
          id: string;
          phoneNumber: string;
          status: string;
        }> | null;
      }>;
      total: number;
    }>("GET", `/v1/agents?limit=${limit}&offset=${offset}`);
  }

  async createAgent(params: {
    name: string;
    description?: string;
    voiceMode?: string;
    systemPrompt?: string;
    beginMessage?: string;
    voice?: string;
    modelTier?: string;
    transferNumber?: string;
    voicemailMessage?: string;
    sttMode?: string;
    ambientSound?: string;
    denoisingMode?: string;
    maxSilenceMs?: number;
    enableMessaging?: boolean;
    enableBackchannel?: boolean;
    interruptionSensitivity?: number;
    voiceSpeed?: number;
    language?: string;
  }) {
    return this.request<{
      id: string;
      name: string;
      description: string | null;
      voiceMode: string;
      systemPrompt: string | null;
      beginMessage: string | null;
      voice: string;
      modelTier: string;
      transferNumber: string | null;
      voicemailMessage: string | null;
      sttMode: string;
      ambientSound: string;
      denoisingMode: string;
      maxSilenceMs: number;
      enableMessaging: boolean;
      enableBackchannel: boolean;
      interruptionSensitivity: number;
      voiceSpeed: number;
      language: string;
      createdAt: string;
      numbers?: Array<{ id: string; phoneNumber: string; status: string }> | null;
    }>("POST", "/v1/agents", params);
  }

  async updateAgent(
    agentId: string,
    params: {
      name?: string;
      description?: string;
      voiceMode?: string;
      systemPrompt?: string;
      beginMessage?: string;
      voice?: string;
      modelTier?: string;
      transferNumber?: string;
      voicemailMessage?: string;
      sttMode?: string;
      ambientSound?: string;
      denoisingMode?: string;
      maxSilenceMs?: number;
      enableMessaging?: boolean;
      enableBackchannel?: boolean;
      interruptionSensitivity?: number;
      voiceSpeed?: number;
      language?: string;
    }
  ) {
    return this.request<{
      id: string;
      name: string;
      description: string | null;
      voiceMode: string;
      systemPrompt: string | null;
      beginMessage: string | null;
      voice: string;
      modelTier: string;
      transferNumber: string | null;
      voicemailMessage: string | null;
      sttMode: string;
      ambientSound: string;
      denoisingMode: string;
      maxSilenceMs: number;
      enableMessaging: boolean;
      enableBackchannel: boolean;
      interruptionSensitivity: number;
      voiceSpeed: number;
      language: string;
      createdAt: string;
      numbers?: Array<{ id: string; phoneNumber: string; status: string }> | null;
    }>("PATCH", `/v1/agents/${encodeURIComponent(agentId)}`, params);
  }

  async deleteAgent(agentId: string) {
    return this.request<{
      success: boolean;
      id: string;
      name: string;
    }>("DELETE", `/v1/agents/${encodeURIComponent(agentId)}`);
  }

  async getAgent(agentId: string) {
    return this.request<{
      id: string;
      name: string;
      description: string | null;
      voiceMode: string;
      systemPrompt: string | null;
      beginMessage: string | null;
      voice: string;
      modelTier: string;
      transferNumber: string | null;
      voicemailMessage: string | null;
      sttMode: string;
      ambientSound: string;
      denoisingMode: string;
      maxSilenceMs: number;
      enableMessaging: boolean;
      enableBackchannel: boolean;
      interruptionSensitivity: number;
      voiceSpeed: number;
      language: string;
      createdAt: string;
      numbers?: Array<{
        id: string;
        phoneNumber: string;
        status: string;
      }> | null;
    }>("GET", `/v1/agents/${encodeURIComponent(agentId)}`);
  }

  async attachNumber(agentId: string, numberId: string) {
    return this.request<{
      agentId: string;
      number: { id: string; phoneNumber: string; status: string };
    }>("POST", `/v1/agents/${encodeURIComponent(agentId)}/numbers`, { numberId });
  }

  async detachNumber(agentId: string, numberId: string) {
    return this.deleteExpectingSuccess(
      `/v1/agents/${encodeURIComponent(agentId)}/numbers/${encodeURIComponent(numberId)}`
    );
  }

  // --- Agent-scoped queries ---

  async listAgentConversations(agentId: string, limit = 20, offset = 0) {
    return this.request<{
      data: Array<{
        id: string;
        agentId: string | null;
        phoneNumberId: string;
        phoneNumber: string;
        participant: string;
        lastMessageAt: string | null;
        lastMessagePreview: string;
        messageCount: number;
        createdAt: string;
      }>;
      hasMore: boolean;
      total: number;
    }>(
      "GET",
      `/v1/agents/${encodeURIComponent(agentId)}/conversations?limit=${limit}&offset=${offset}`
    );
  }

  async listAgentCalls(agentId: string, limit = 20, offset = 0) {
    return this.request<{
      data: Array<{
        id: string;
        fromNumber: string;
        toNumber: string;
        direction: string;
        status: string;
        startedAt: string;
        endedAt: string | null;
        agentId: string | null;
        phoneNumberId: string | null;
      }>;
      hasMore: boolean;
      total: number;
    }>(
      "GET",
      `/v1/agents/${encodeURIComponent(agentId)}/calls?limit=${limit}&offset=${offset}`
    );
  }

  // --- Agent Webhooks ---

  async getAgentWebhook(agentId: string) {
    return this.request<{
      id: string;
      url: string;
      secret: string;
      status: string;
      contextLimit: number;
      createdAt: string;
    } | null>("GET", `/v1/agents/${encodeURIComponent(agentId)}/webhook`);
  }

  async setAgentWebhook(
    agentId: string,
    url: string,
    contextLimit?: number,
    timeout?: number
  ) {
    const body: Record<string, unknown> = { url };
    if (contextLimit !== undefined) body.contextLimit = contextLimit;
    if (timeout !== undefined) body.timeout = timeout;

    return this.request<{
      id: string;
      url: string;
      secret: string;
      status: string;
      contextLimit: number;
      createdAt: string;
    }>("POST", `/v1/agents/${encodeURIComponent(agentId)}/webhook`, body);
  }

  async deleteAgentWebhook(agentId: string) {
    return this.deleteExpectingSuccess(`/v1/agents/${encodeURIComponent(agentId)}/webhook`);
  }

  async testAgentWebhook(agentId: string) {
    return this.request<WebhookTestResult>(
      "POST",
      `/v1/agents/${encodeURIComponent(agentId)}/webhook/test`
    );
  }

  async listAgentWebhookDeliveries(agentId: string, limit = 20) {
    const path = `/v1/agents/${encodeURIComponent(agentId)}/webhook/deliveries?limit=${limit}`;
    const rows = await this.request<WebhookDelivery[]>("GET", path);
    return { data: rows };
  }

  // --- Calls ---

  async listCalls(
    limit = 20,
    offset = 0,
    filters?: { status?: string; direction?: string; search?: string }
  ) {
    let path = `/v1/calls?limit=${limit}&offset=${offset}`;
    if (filters?.status) path += `&status=${encodeURIComponent(filters.status)}`;
    if (filters?.direction) path += `&direction=${encodeURIComponent(filters.direction)}`;
    if (filters?.search) path += `&search=${encodeURIComponent(filters.search)}`;

    return this.request<{
      data: Array<{
        id: string;
        fromNumber: string;
        toNumber: string;
        direction: string;
        status: string;
        startedAt: string;
        endedAt: string | null;
        agentId: string | null;
        phoneNumberId: string | null;
      }>;
      hasMore: boolean;
      total: number;
    }>("GET", path);
  }

  // Returns the call's current state and transcript immediately. The backend
  // does not long-poll for completion, so there is no wait/timeout parameter;
  // poll again with get_call to observe a call that is still in progress.
  async getCall(callId: string) {
    return this.request<{
      id: string;
      fromNumber: string;
      toNumber: string;
      direction: string;
      status: string;
      startedAt: string;
      endedAt: string | null;
      agentId: string | null;
      transcripts: Array<{
        id: string;
        transcript: string;
        response: string | null;
        createdAt: string;
      }>;
    }>("GET", `/v1/calls/${encodeURIComponent(callId)}`);
  }

  async makeCall(
    agentId: string,
    toNumber: string,
    initialGreeting?: string,
    fromNumberId?: string,
    voice?: string,
    opts?: CallControls,
  ) {
    const body: Record<string, unknown> = { agentId, toNumber };
    if (initialGreeting !== undefined) body.initialGreeting = initialGreeting;
    if (fromNumberId !== undefined) body.fromNumberId = fromNumberId;
    if (voice !== undefined) body.voice = voice;
    applyCallControls(body, opts);

    return this.request<{
      id: string;
      fromNumber: string;
      toNumber: string;
      direction: string;
      status: string;
      startedAt: string;
      retellCallId: string | null;
    }>("POST", "/v1/calls", body);
  }

  // Ends an in-progress call. The backend treats ending an already-ended call as
  // a no-op (idempotent in behavior), so retrying after a timeout is safe.
  async endCall(callId: string) {
    return this.request<{
      id?: string;
      status?: string;
      endedAt?: string | null;
      success?: boolean;
    }>("POST", `/v1/calls/${encodeURIComponent(callId)}/end`);
  }

  // Initiates the call and returns immediately with its ID and initial state.
  // The backend has no completion-wait, so get_call is used to retrieve the
  // transcript once the call has progressed.
  async makeConversationCall(
    agentId: string,
    toNumber: string,
    systemPrompt: string,
    initialGreeting?: string,
    fromNumberId?: string,
    voice?: string,
    opts?: CallControls,
  ) {
    const body: Record<string, unknown> = { agentId, toNumber, systemPrompt };
    if (initialGreeting !== undefined) body.initialGreeting = initialGreeting;
    if (fromNumberId !== undefined) body.fromNumberId = fromNumberId;
    if (voice !== undefined) body.voice = voice;
    applyCallControls(body, opts);

    return this.request<{
      id: string;
      fromNumber: string;
      toNumber: string;
      direction: string;
      status: string;
      startedAt: string;
      endedAt: string | null;
      retellCallId: string | null;
      transcripts?: Array<{
        id: string;
        transcript: string;
        response: string | null;
        createdAt: string;
      }>;
    }>("POST", "/v1/calls", body);
  }

  async listCallsForNumber(numberId: string, limit = 20, offset = 0) {
    return this.request<{
      data: Array<{
        id: string;
        fromNumber: string;
        toNumber: string;
        direction: string;
        status: string;
        startedAt: string;
        endedAt: string | null;
        agentId: string | null;
        phoneNumberId: string | null;
      }>;
      hasMore: boolean;
      total: number;
    }>("GET", `/v1/numbers/${encodeURIComponent(numberId)}/calls?limit=${limit}&offset=${offset}`);
  }

  // --- Conversations ---

  async listConversations(limit = 20, offset = 0) {
    return this.request<{
      data: Array<{
        id: string;
        agentId: string | null;
        phoneNumberId: string;
        phoneNumber: string;
        participant: string;
        lastMessageAt: string | null;
        lastMessagePreview: string;
        messageCount: number;
        createdAt: string;
      }>;
      hasMore: boolean;
      total: number;
    }>("GET", `/v1/conversations?limit=${limit}&offset=${offset}`);
  }

  async getConversation(conversationId: string, messageLimit = 50) {
    return this.request<{
      id: string;
      agentId: string | null;
      phoneNumberId: string;
      phoneNumber: string;
      participant: string;
      lastMessageAt: string | null;
      messageCount: number;
      metadata: Record<string, unknown> | null;
      createdAt: string;
      messages: Array<{
        id: string;
        body: string;
        fromNumber: string;
        toNumber: string;
        direction: string;
        receivedAt: string;
      }>;
    }>(
      "GET",
      `/v1/conversations/${encodeURIComponent(conversationId)}?message_limit=${messageLimit}`
    );
  }

  // Cursor-paged message history for a conversation. Unlike getConversation
  // (which returns the conversation detail with a bounded tail of messages),
  // this reaches arbitrarily far back by following nextCursor.
  async getConversationMessages(
    conversationId: string,
    limit = 50,
    opts?: { before?: string; after?: string; cursor?: string }
  ) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (opts?.cursor !== undefined) query.set("cursor", opts.cursor);
    if (opts?.before !== undefined) query.set("before", opts.before);
    if (opts?.after !== undefined) query.set("after", opts.after);
    return this.request<{
      data: Array<{
        id: string;
        body: string;
        fromNumber: string;
        toNumber: string;
        direction: string;
        receivedAt: string;
      }>;
      hasMore: boolean;
      nextCursor?: string | null;
    }>(
      "GET",
      `/v1/conversations/${encodeURIComponent(conversationId)}/messages?${query}`
    );
  }

  async updateConversation(conversationId: string, metadata: Record<string, unknown> | null) {
    return this.request<{
      id: string;
      agentId: string | null;
      phoneNumberId: string;
      phoneNumber: string;
      participant: string;
      lastMessageAt: string | null;
      messageCount: number;
      metadata: Record<string, unknown> | null;
      createdAt: string;
    }>("PATCH", `/v1/conversations/${encodeURIComponent(conversationId)}`, { metadata });
  }

  // --- Contacts ---

  async listContacts(limit = 50, offset = 0, search?: string) {
    let path = `/v1/contacts?limit=${limit}&offset=${offset}`;
    if (search) path += `&search=${encodeURIComponent(search)}`;
    return this.request<{
      data: Array<{
        id: string;
        phoneNumber: string;
        name: string;
        email: string | null;
        notes: string | null;
        createdAt: string;
        updatedAt: string;
      }>;
      hasMore: boolean;
      total: number;
    }>("GET", path);
  }

  async createContact(params: {
    phoneNumber: string;
    name: string;
    email?: string;
    notes?: string;
  }) {
    return this.request<{
      id: string;
      phoneNumber: string;
      name: string;
      email: string | null;
      notes: string | null;
      createdAt: string;
      updatedAt: string;
    }>("POST", "/v1/contacts", params);
  }

  async updateContact(
    contactId: string,
    params: { phoneNumber?: string; name?: string; email?: string; notes?: string }
  ) {
    return this.request<{
      id: string;
      phoneNumber: string;
      name: string;
      email: string | null;
      notes: string | null;
      createdAt: string;
      updatedAt: string;
    }>("PATCH", `/v1/contacts/${encodeURIComponent(contactId)}`, params);
  }

  async deleteContact(contactId: string) {
    return this.deleteExpectingSuccess(`/v1/contacts/${encodeURIComponent(contactId)}`);
  }

  // --- Webhooks ---

  async getWebhook() {
    return this.request<{
      id: string;
      url: string;
      secret: string;
      status: string;
      contextLimit: number;
      createdAt: string;
    } | null>("GET", "/v1/webhooks");
  }

  async setWebhook(url: string, contextLimit?: number, timeout?: number) {
    const body: Record<string, unknown> = { url };
    if (contextLimit !== undefined) body.contextLimit = contextLimit;
    if (timeout !== undefined) body.timeout = timeout;

    return this.request<{
      id: string;
      url: string;
      secret: string;
      status: string;
      contextLimit: number;
      createdAt: string;
    }>("POST", "/v1/webhooks", body);
  }

  async deleteWebhook() {
    return this.deleteExpectingSuccess("/v1/webhooks");
  }

  async testWebhook() {
    return this.request<WebhookTestResult>("POST", "/v1/webhooks/test");
  }

  async listWebhookDeliveries(limit = 20, hours?: number) {
    let path = `/v1/webhooks/deliveries?limit=${limit}`;
    if (hours !== undefined) path += `&hours=${hours}`;
    const page = await this.request<{ items: WebhookDelivery[]; total: number }>("GET", path);
    return { data: page.items, total: page.total };
  }

  // --- Usage ---

  async getUsage() {
    // NOTE: the legacy `plan` block (free/pro/scale + per-line limits) was
    // removed from GET /v1/usage (agent-phone tasks#141) — it advertised
    // limits nothing enforces. Messaging/voice bill per use from credits.
    return this.request<{
      numbers: {
        used: number;
        limit: number;
        remaining: number;
      };
      stats: {
        totalMessages: number;
        messagesLast24h: number;
        messagesLast7d: number;
        messagesLast30d: number;
        smsSegmentsLast30d: number;
        totalCalls: number;
        callsLast24h: number;
        callsLast7d: number;
        callsLast30d: number;
        totalWebhookDeliveries: number;
        successfulWebhookDeliveries: number;
        failedWebhookDeliveries: number;
      };
      periodStart: string;
      periodEnd: string;
    }>("GET", "/v1/usage");
  }

  async getDailyUsage(days = 30) {
    return this.request<{
      data: Array<{
        date: string;
        messages: number;
        calls: number;
        webhooks: number;
      }>;
      days: number;
    }>("GET", `/v1/usage/daily?days=${days}`);
  }

  async getMonthlyUsage(months = 12) {
    return this.request<{
      data: Array<{
        month: string;
        messages: number;
        calls: number;
        webhooks: number;
      }>;
      months: number;
    }>("GET", `/v1/usage/monthly?months=${months}`);
  }
}

// --- Error class ---

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly detail: string,
    // The server's Retry-After header (seconds or HTTP date), when present —
    // surfaced on 429 so callers back off for the advised time (see err()).
    public readonly retryAfter: string | null = null
  ) {
    super(`AgentPhone API ${method} ${path} failed (${status}): ${detail}`);
    this.name = "ApiError";
  }
}

// Strip anything that looks like a credential from error text before it reaches
// a tool result (which is logged and enters model context).
function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|rk)_[A-Za-z0-9_-]{6,}/g, "$1_***")
    // RFC 6750 bearer tokens allow A-Z a-z 0-9 - . _ ~ + / =, so match the full
    // set (not just word chars) or a token with these could be partly exposed.
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***");
}

// Turn the backend's error envelope into one actionable line. Handles the
// structured { detail, error: { code, details } } shape, FastAPI validation
// arrays ([{ loc, msg }]), and plain { detail } / { message } strings — rather
// than stringifying an object into "[object Object]" or dropping field details.
function formatApiErrorDetail(json: unknown): string | undefined {
  if (json == null || typeof json !== "object") return undefined;
  const j = json as Record<string, any>;

  const fieldLine = (loc: unknown, msg: unknown): string => {
    const field = Array.isArray(loc)
      ? loc.filter((p) => p !== "body" && p !== "query" && p !== "path").join(".")
      : loc != null
        ? String(loc)
        : "";
    return field ? `${field}: ${msg}` : String(msg);
  };

  // Structured envelope: { detail, error: { code, details } }
  const structured = j.error;
  if (structured && typeof structured === "object") {
    const parts: string[] = [];
    const base = typeof j.detail === "string" ? j.detail : undefined;
    if (base) parts.push(structured.code ? `${base} (${structured.code})` : base);
    else if (structured.code) parts.push(String(structured.code));
    const details = structured.details;
    if (Array.isArray(details)) {
      for (const d of details) {
        parts.push(d && typeof d === "object" ? fieldLine(d.field ?? d.loc, d.message ?? d.msg) : String(d));
      }
    } else if (typeof details === "string") {
      parts.push(details);
    }
    if (parts.length) return parts.join("; ");
  }

  // FastAPI validation array: detail = [{ loc, msg, type }]
  if (Array.isArray(j.detail)) {
    const lines = j.detail.map((d) =>
      d && typeof d === "object" ? fieldLine(d.loc, d.msg) : String(d)
    );
    if (lines.length) return lines.join("; ");
  }

  if (typeof j.detail === "string") return j.detail;
  if (typeof j.message === "string") return j.message;
  return undefined;
}
