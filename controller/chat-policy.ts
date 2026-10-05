import { setTimeout as delay } from "node:timers/promises";
import { redact } from "./selfinfo.ts";
import type { Bridge, ChatEvent, ChatPolicy, Config, Ctx, HeuristicsHost, ToolResult } from "./types.ts";

export function createChatPolicy(c: Config, b: Bridge, h: HeuristicsHost, ctx: () => Ctx): ChatPolicy {
  let queue: Promise<unknown> = Promise.resolve();
  let lastAttempt = -Infinity;
  const echoes: string[] = [];
  const recipients = new Map<string, "player" | "whisper">();

  function split(text: string, available: number): string[] {
    const clean = text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "").replace(/\s+/g, " ").trim();
    const lines: string[] = [];
    let rest = clean;
    while (rest && lines.length < c.chat.maxLinesPerReply && available > 0) {
      let end = Math.min(available, rest.length);
      // JS length uses UTF-16 code units, matching Java String.length(). Never cut a surrogate pair.
      if (end < rest.length && /[\uD800-\uDBFF]/.test(rest[end - 1] ?? "")) end--;
      if (end <= 0) break;
      if (end < rest.length) {
        const space = rest.lastIndexOf(" ", end);
        if (space > available / 2) end = space;
      }
      lines.push(rest.slice(0, end).trim());
      rest = rest.slice(end).trimStart();
    }
    if (rest && lines.length) {
      const last = lines.length - 1;
      let cut = lines[last]!.slice(0, Math.max(0, available - 1));
      if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
      lines[last] = cut + "…";
    }
    return lines;
  }

  function send(text: string, prefix: string): Promise<ToolResult> {
    const created = Date.now();
    const job = queue.then(async (): Promise<ToolResult> => {
      if (/^[\s]*[/#]/.test(text)) return { ok: false, summary: "command_not_allowed" };
      if (redact(prefix) !== prefix) return { ok: false, summary: "recipient ambiguous" };
      const lines = split(redact(text), c.chat.maxLen - prefix.length);
      if (!lines.length) return { ok: false, summary: prefix.length >= c.chat.maxLen ? "too_long" : "empty reply" };
      const submitted: string[] = [];
      const intervalMs = c.chat.minIntervalMs + 250;
      for (const line of lines) {
        while (Date.now() - lastAttempt < intervalMs) {
          await delay(intervalMs - (Date.now() - lastAttempt));
        }
        if (Date.now() - created > 15_000) return { ok: false, summary: "stale reply dropped", observedDelta: { submitted } };
        const formatted = prefix + line;
        // Never turn a split continuation into a public command.
        if (!prefix && /^[/#]/.test(line)) return { ok: false, summary: "command_not_allowed", observedDelta: { submitted } };
        let response: Record<string, unknown> = {};
        for (let attempt = 0; attempt < 2; attempt++) {
          lastAttempt = Date.now();
          let result: unknown;
          try {
            result = await b.rpc("qc.chat.send", { text: formatted });
          } catch (error) {
            return { ok: false, summary: `chat submission unverified: ${error instanceof Error ? error.message : String(error)}`, observedDelta: { submitted } };
          }
          response = typeof result === "object" && result !== null ? result as Record<string, unknown> : {};
          if (response.sent === true || response.rejected !== "rate_limited" || attempt === 1) break;
          await delay(intervalMs);
          if (Date.now() - created > 15_000) return { ok: false, summary: "stale reply dropped", observedDelta: { submitted } };
        }
        if (response.sent !== true) return { ok: false, summary: typeof response.rejected === "string" ? response.rejected : "chat submission unverified", observedDelta: { submitted } };
        submitted.push(formatted);
        echoes.push(line);
        if (echoes.length > 8) echoes.shift();
      }
      return { ok: true, summary: `submitted ${submitted.length} chat message(s); remote receipt unverified`, observedDelta: { submitted } };
    });
    queue = job.catch(() => undefined);
    return job;
  }

  return {
    route(e: ChatEvent) {
      const decision = h.onChat(e, ctx());
      const ownName = c.chat.nicknames[0]?.toLowerCase();
      const namedSelf = e.senderUuid === null && ownName !== undefined && e.senderName?.toLowerCase() === ownName;
      const renderedSelf = e.senderUuid === null && ownName !== undefined && e.kind === "system" && (e.text.toLowerCase().startsWith(`<${ownName}> `) || e.text.toLowerCase().startsWith(`${ownName}: `)) && echoes.some(text => e.text.endsWith(text));
      if (e.self || namedSelf || renderedSelf) return { kind: "ignore" };
      if (e.kind === "system") return { kind: "model", mustConsider: false };
      if (e.senderName !== null && /^[A-Za-z0-9_]{1,16}$/.test(e.senderName)) recipients.set(e.senderName.toLowerCase(), e.kind);
      const lower = e.text.toLowerCase();
      const mentioned = c.chat.nicknames.some(name => lower.includes(name.toLowerCase())) || c.chat.wholeWords.some(word => new RegExp(`(?<![\\p{Alphabetic}\\p{Nd}\\p{M}\\p{Pc}\\u200C\\u200D])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{Alphabetic}\\p{Nd}\\p{M}\\p{Pc}\\u200C\\u200D])`, "iu").test(e.text));
      const mustConsider = e.mentionsMe || mentioned || e.kind === "whisper";
      if (mustConsider && decision && "reply" in decision) return { kind: "reply", text: decision.reply };
      if (decision && "ignore" in decision) return { kind: "ignore" };
      return { kind: "model", mustConsider };
    },
    say(text) { return send(text, ""); },
    reply(to, text, privately) {
      const kind = recipients.get(to.toLowerCase());
      if (!/^[A-Za-z0-9_]{1,16}$/.test(to) || kind === undefined) return Promise.resolve({ ok: false, summary: "recipient ambiguous" });
      const privateSend = kind === "whisper";
      if (privateSend && (!privately || !c.commands.allowlist.includes("/msg"))) return Promise.resolve({ ok: false, summary: "command_not_allowed" });
      return send(text, privateSend ? `/msg ${to} ` : `${to}: `);
    },
  };
}
