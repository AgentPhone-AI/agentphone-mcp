/**
 * AgentPhone API client.
 *
 * Minimal typed HTTP client for the AgentPhone REST API.
 * Used by the MCP server to proxy tool calls to the backend.
 */

export class AgentPhoneAPI {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
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
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
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
          const json = JSON.parse(text);
          detail = json.detail ?? json.message ?? text;
        } catch {
          // use raw text
        }
        throw new ApiError(res.status, method, path, detail);
      }

      if (res.status === 204) return {} as T;
      return res.json() as Promise<T>;
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw new ApiError(0, method, path, `Request timed out after ${timeout}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
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

  async getMessages(numberId: string, limit = 50) {
    return this.request<{
      data: Array<{
        id: string;
        from: string;
        to: string;
        body: string;
        receivedAt: string;
      }>;
      hasMore: boolean;
    }>("GET", `/v1/numbers/${encodeURIComponent(numberId)}/messages?limit=${limit}`);
  }

  async sendMessage(params: {
    agentId: string;
    toNumber: string;
    body: string;
    mediaUrl?: string;
    numberId?: string;
  }) {
    return this.request<{
      id: string;
      from: string;
      to: string;
      body: string;
      direction: string;
      status: string;
      channel: string | null;
      sentAt: string;
    }>("POST", "/v1/messages", {
      agent_id: params.agentId,
      to_number: params.toNumber,
      body: params.body,
      media_url: params.mediaUrl,
      number_id: params.numberId,
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
        createdAt: string;
        numbers?: Array<{
          id: string;
          phoneNumber: string;
          status: string;
        }>;
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
      createdAt: string;
      numbers: Array<{ id: string; phoneNumber: string; status: string }>;
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
      createdAt: string;
      numbers?: Array<{ id: string; phoneNumber: string; status: string }>;
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
      createdAt: string;
      numbers?: Array<{
        id: string;
        phoneNumber: string;
        status: string;
      }>;
    }>("GET", `/v1/agents/${encodeURIComponent(agentId)}`);
  }

  async attachNumber(agentId: string, numberId: string) {
    return this.request<{
      agentId: string;
      number: { id: string; phoneNumber: string; status: string };
    }>("POST", `/v1/agents/${encodeURIComponent(agentId)}/numbers`, { numberId });
  }

  async detachNumber(agentId: string, numberId: string) {
    return this.request<{ success: boolean }>(
      "DELETE",
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
        phoneNumberId: string;
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
    return this.request<{ success: boolean }>(
      "DELETE",
      `/v1/agents/${encodeURIComponent(agentId)}/webhook`
    );
  }

  async testAgentWebhook(agentId: string) {
    return this.request<{
      success: boolean;
      statusCode: number | null;
      responseMs: number | null;
      error: string | null;
    }>("POST", `/v1/agents/${encodeURIComponent(agentId)}/webhook/test`);
  }

  async listAgentWebhookDeliveries(agentId: string, limit = 20, hours?: number) {
    let path = `/v1/agents/${encodeURIComponent(agentId)}/webhook/deliveries?limit=${limit}`;
    if (hours !== undefined) path += `&hours=${hours}`;
    return this.request<{
      data: Array<{
        id: string;
        event: string;
        statusCode: number | null;
        success: boolean;
        deliveredAt: string;
        responseMs: number | null;
      }>;
      hasMore: boolean;
      total: number;
    }>("GET", path);
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
        phoneNumberId: string;
      }>;
      hasMore: boolean;
      total: number;
    }>("GET", path);
  }

  async getCall(callId: string, opts?: { wait?: boolean; timeout?: number }) {
    let path = `/v1/calls/${encodeURIComponent(callId)}`;
    const params: string[] = [];
    if (opts?.wait) params.push("wait=true");
    if (opts?.timeout) params.push(`timeout=${opts.timeout}`);
    if (params.length) path += `?${params.join("&")}`;

    const fetchTimeout = opts?.wait ? 300_000 : undefined;

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
    }>("GET", path, undefined, fetchTimeout);
  }

  async makeCall(
    agentId: string,
    toNumber: string,
    initialGreeting?: string,
    fromNumberId?: string,
    voice?: string,
  ) {
    const body: Record<string, unknown> = { agentId, toNumber };
    if (initialGreeting !== undefined) body.initialGreeting = initialGreeting;
    if (fromNumberId !== undefined) body.fromNumberId = fromNumberId;
    if (voice !== undefined) body.voice = voice;

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

  async makeConversationCall(
    agentId: string,
    toNumber: string,
    systemPrompt: string,
    initialGreeting?: string,
    waitForCompletion?: boolean,
    maxWaitSeconds?: number,
    fromNumberId?: string,
    voice?: string
  ) {
    const body: Record<string, unknown> = { agentId, toNumber, systemPrompt };
    if (initialGreeting !== undefined) body.initialGreeting = initialGreeting;
    if (waitForCompletion !== undefined) body.waitForCompletion = waitForCompletion;
    if (maxWaitSeconds !== undefined) body.maxWaitSeconds = maxWaitSeconds;
    if (fromNumberId !== undefined) body.fromNumberId = fromNumberId;
    if (voice !== undefined) body.voice = voice;

    const fetchTimeout = waitForCompletion ? 600_000 : undefined;

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
    }>("POST", "/v1/calls", body, fetchTimeout);
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
        phoneNumberId: string;
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
    return this.request<{ success: boolean }>("DELETE", "/v1/webhooks");
  }

  async testWebhook() {
    return this.request<{
      success: boolean;
      statusCode: number | null;
      responseMs: number | null;
      error: string | null;
    }>("POST", "/v1/webhooks/test");
  }

  async listWebhookDeliveries(limit = 20, hours?: number) {
    let path = `/v1/webhooks/deliveries?limit=${limit}`;
    if (hours !== undefined) path += `&hours=${hours}`;
    return this.request<{
      data: Array<{
        id: string;
        event: string;
        statusCode: number | null;
        success: boolean;
        deliveredAt: string;
        responseMs: number | null;
      }>;
      hasMore: boolean;
      total: number;
    }>("GET", path);
  }

  // --- Usage ---

  async getUsage() {
    return this.request<{
      plan: {
        name: string;
        limits: {
          numbers: number;
          messagesPerMonth: number;
          voiceMinutesPerMonth: number;
          maxCallDurationMinutes: number;
          concurrentCalls: number;
        };
      };
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
        voiceMinutes: number;
      }>;
    }>("GET", `/v1/usage/daily?days=${days}`);
  }

  async getMonthlyUsage(months = 12) {
    return this.request<{
      data: Array<{
        month: string;
        messages: number;
        calls: number;
        voiceMinutes: number;
      }>;
    }>("GET", `/v1/usage/monthly?months=${months}`);
  }
}

// --- Error class ---

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly detail: string
  ) {
    super(`AgentPhone API ${method} ${path} failed (${status}): ${detail}`);
    this.name = "ApiError";
  }
}
