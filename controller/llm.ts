import { toolsForLlm } from './tools.ts';
import type { ChatMessage, Config, LlmReply, LlmToolCall, ToolDef } from './types.ts';

function cleanContent(content: string): string {
  return content.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
}

export function createLlm(c: Config): {complete(messages: ChatMessage[], tools: ToolDef[], opts: {thinking: boolean; signal?: AbortSignal; timeoutMs: number}): Promise<LlmReply>} {
  return {async complete(messages, tools, opts) {
    const replay = messages.map(message => {
      if (message.role === 'assistant') return {role: message.role, content: message.content === null ? null : cleanContent(message.content), ...(message.tool_calls ? {tool_calls: message.tool_calls} : {})};
      if (message.role === 'tool') return {role: message.role, content: message.content, tool_call_id: message.tool_call_id};
      return {role: message.role, content: message.content};
    });
    const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)]) : AbortSignal.timeout(opts.timeoutMs);
    const response = await fetch(`${c.llm.baseUrl}/chat/completions`, {method: 'POST', headers: {'Content-Type': 'application/json'}, signal,
      // Thinking turns used up to ~2,400 tokens live; 8,192 leaves headroom (~4 min at ~32 tok/s) before truncation.
      body: JSON.stringify({model: c.llm.model, messages: replay, ...(tools.length ? {tools: toolsForLlm(tools), tool_choice: 'auto'} : {}), max_tokens: opts.thinking ? 8192 : 1024, chat_template_kwargs: {enable_thinking: opts.thinking, preserve_thinking: false}})});
    if (!response.ok) throw new Error(`LLM HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}`);
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || !('choices' in data) || !Array.isArray(data.choices) || data.choices.length !== 1) throw new Error('Invalid LLM choices');
    const choice: unknown = data.choices[0];
    if (!choice || typeof choice !== 'object' || !('message' in choice) || !choice.message || typeof choice.message !== 'object') throw new Error('Invalid LLM message');
    const message = choice.message;
    const content = 'content' in message && typeof message.content === 'string' ? cleanContent(message.content) : null;
    const calls = 'tool_calls' in message ? message.tool_calls : [];
    if (!Array.isArray(calls)) throw new Error('Invalid LLM tool calls');
    const ids = new Set<string>();
    const toolCalls: LlmToolCall[] = calls.map((call: unknown) => {
      if (!call || typeof call !== 'object' || !('id' in call) || typeof call.id !== 'string' || !call.id || ids.has(call.id) || !('type' in call) || call.type !== 'function' || !('function' in call) || !call.function || typeof call.function !== 'object' || !('name' in call.function) || typeof call.function.name !== 'string' || !('arguments' in call.function) || typeof call.function.arguments !== 'string') throw new Error('Invalid or ambiguous LLM tool call');
      ids.add(call.id);
      return {id: call.id, type: 'function', function: {name: call.function.name, arguments: call.function.arguments}};
    });
    if (!content && toolCalls.length === 0) throw new Error('Empty LLM output');
    const usage = 'usage' in data && data.usage && typeof data.usage === 'object' && !Array.isArray(data.usage) ? data.usage as Record<string, unknown> : {};
    // Hidden reasoning is deliberately discarded at ingress, not merely omitted from logging.
    return {content, reasoning: null, toolCalls, usage};
  }};
}
