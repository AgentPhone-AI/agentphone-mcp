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
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      let detail = text;
      try {
        const json = JSON.parse(text);
        detail = json.detail || json.message || text;
      } catch {
        // use raw text
      }
      throw new Error(`AgentPhone API ${method} ${path} failed (${res.status}): ${detail}`);
    }

    if (res.status === 204) return {} as T;
    return res.json() as Promise<T>;
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

  async buyNumber(country = "US", areaCode?: string, agentId?: string) {
    return this.request<{
      id: string;
      phoneNumber: string;
      country: string;
      status: string;
      agentId: string | null;
      createdAt: string;
    }>("POST", "/v1/numbers", { country, areaCode, agentId });
  }

  async releaseNumber(numberId: string) {
    return this.request<{
      success: boolean;
      phoneNumber: string;
      status: string;
    }>("DELETE", `/v1/numbers/${numberId}`);
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
    }>("GET", `/v1/numbers/${numberId}/messages?limit=${limit}`);
  }

  // --- Agents ---

  async listAgents(limit = 20, offset = 0) {
    return this.request<{
      data: Array<{
        id: string;
        name: string;
        description: string | null;
        createdAt: string;
        numbers?: Array<{
          id: string;
          phoneNumber: string;
          status: string;
        }>;
      }>;
      hasMore: boolean;
      total: number;
    }>("GET", `/v1/agents?limit=${limit}&offset=${offset}`);
  }

  async createAgent(name: string, description?: string) {
    return this.request<{
      id: string;
      name: string;
      description: string | null;
      createdAt: string;
    }>("POST", "/v1/agents", { name, description });
  }

  async getAgent(agentId: string) {
    return this.request<{
      id: string;
      name: string;
      description: string | null;
      createdAt: string;
      numbers?: Array<{
        id: string;
        phoneNumber: string;
        status: string;
      }>;
    }>("GET", `/v1/agents/${agentId}`);
  }

  async attachNumber(agentId: string, numberId: string) {
    return this.request<{
      agentId: string;
      number: { id: string; phoneNumber: string; status: string };
    }>("POST", `/v1/agents/${agentId}/numbers`, { numberId });
  }

  // --- Calls ---

  async listCalls(limit = 20, offset = 0) {
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
    }>("GET", `/v1/calls?limit=${limit}&offset=${offset}`);
  }

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
    }>("GET", `/v1/calls/${callId}`);
  }

  async makeCall(
    agentId: string,
    toNumber: string,
    initialGreeting?: string
  ) {
    return this.request<{
      id: string;
      fromNumber: string;
      toNumber: string;
      direction: string;
      status: string;
      startedAt: string;
      retellCallId: string | null;
    }>("POST", "/v1/calls", {
      agentId,
      toNumber,
      initialGreeting,
    });
  }

  async makeConversationCall(
    agentId: string,
    toNumber: string,
    systemPrompt: string,
    initialGreeting?: string,
    model?: string
  ) {
    return this.request<{
      id: string;
      fromNumber: string;
      toNumber: string;
      direction: string;
      status: string;
      startedAt: string;
      retellCallId: string | null;
    }>("POST", "/v1/calls", {
      agentId,
      toNumber,
      systemPrompt,
      initialGreeting,
      model,
    });
  }

  // --- Conversations ---

  async listConversations(limit = 20, offset = 0) {
    return this.request<{
      data: Array<{
        id: string;
        phoneNumber: string;
        contactNumber: string;
        channel: string;
        lastMessageAt: string | null;
        messageCount: number;
        agentId: string | null;
      }>;
      hasMore: boolean;
      total: number;
    }>("GET", `/v1/conversations?limit=${limit}&offset=${offset}`);
  }

  async getConversation(conversationId: string, messageLimit = 50) {
    return this.request<{
      id: string;
      phoneNumber: string;
      contactNumber: string;
      channel: string;
      lastMessageAt: string | null;
      messageCount: number;
      messages: Array<{
        id: string;
        from: string;
        to: string;
        body: string;
        receivedAt: string;
      }>;
    }>(
      "GET",
      `/v1/conversations/${conversationId}?message_limit=${messageLimit}`
    );
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

  async setWebhook(url: string, contextLimit?: number) {
    return this.request<{
      id: string;
      url: string;
      secret: string;
      status: string;
      contextLimit: number;
      createdAt: string;
    }>("POST", "/v1/webhooks", { url, contextLimit });
  }

  async deleteWebhook() {
    return this.request<{ success: boolean }>("DELETE", "/v1/webhooks");
  }
}
