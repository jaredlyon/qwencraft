package dev.qwencraft.guards;

import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.mojang.authlib.GameProfile;
import dev.mcpfabric.bridge.RpcException;
import dev.qwencraft.Qc;
import dev.qwencraft.QcState;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.ChatType;
import net.minecraft.network.chat.PlayerChatMessage;
import net.minecraft.resources.Identifier;
import net.minecraft.world.level.block.Block;

import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/** Chat ingestion and hard guards shared by the RPC and all client action paths. */
public final class GuardsFeature {
	private record Protection(Set<Block> naturalBlocks, List<QcState.Zone> zones) {}
	private static volatile Protection protection = new Protection(Set.of(), List.of());
	private static volatile List<Pattern> mentions = List.of();
	private static final ArrayDeque<ChatRules.Sent> recentSent = new ArrayDeque<>(8);
	private static final ThreadLocal<CheckedSend> checkedSend = new ThreadLocal<>();
	private static boolean hasSent;
	private static long lastSendNanos;

	private static final class CheckedSend {
		final String text;
		final boolean command;
		boolean consumed;
		boolean sent;

		CheckedSend(String text, boolean command) {
			this.text = text;
			this.command = command;
		}
	}

	private GuardsFeature() {}

	public static void init() {
		applyConfig();
		QcState.onConfig(GuardsFeature::applyConfig);
		ClientReceiveMessageEvents.CHAT.register((message, signedMessage, sender, type, timestamp) ->
				receive(message.getString(), sender, signedMessage, type));
		ClientReceiveMessageEvents.GAME.register((message, overlay) -> receive(message.getString(), null, null, null));
		ClientPlayConnectionEvents.DISCONNECT.register((connection, client) -> recentSent.clear());
		Qc.register("qc.chat.send", ctx -> {
			JsonObject params = ctx.params();
			if (params == null || !params.has("text") || !params.get("text").isJsonPrimitive()
					|| !params.getAsJsonPrimitive("text").isString()) throw RpcException.badRequest("text must be a string");
			String text = params.get("text").getAsString();
			return Qc.onMain(() -> send(text));
		});
	}

	private static void applyConfig() {
		QcState.ProtectConfig config = QcState.protect;
		Set<Block> natural = new HashSet<>();
		for (String name : config.naturalBlocks()) {
			Identifier id = Identifier.tryParse(name);
			if (id != null && BuiltInRegistries.BLOCK.containsKey(id)) {
				BuiltInRegistries.BLOCK.getOptional(id).ifPresent(natural::add);
			}
		}
		protection = new Protection(Set.copyOf(natural), config.zones());
		QcState.Nicknames names = QcState.nicknames;
		mentions = ChatRules.mentions(names.names(), names.wholeWords());
	}

	public static boolean humanHasControls() {
		QcState.PauseReason reason = QcState.pauseReason();
		return reason != null && reason.humanHasControls();
	}

	/** Called before start, continuation, and direct client-side destruction. No config means deny. */
	public static boolean mayBreak(BlockPos pos) {
		if (humanHasControls()) return true;
		Minecraft client = Minecraft.getInstance();
		if (client.level == null || client.player == null) return false;
		Protection config = protection;
		for (QcState.Zone zone : config.zones()) {
			if (zone.contains(pos.getX(), pos.getY(), pos.getZ())) return true;
		}
		return config.naturalBlocks().contains(client.level.getBlockState(pos).getBlock());
	}

	/** One reservation shared by public chat, commands, RPCs and raw MCPFabric sends. Main thread only. */
	private static String reserve(String text) {
		QcState.ChatLimits limits = QcState.chat;
		String rejected = ChatRules.rejection(text, limits.maxLen(), QcState.commandAllowlist);
		if (rejected != null) return rejected;
		long now = System.nanoTime();
		if (hasSent && TimeUnit.NANOSECONDS.toMillis(now - lastSendNanos) < Math.max(3000, limits.minIntervalMs())) return "rate_limited";
		hasSent = true;
		lastSendNanos = now;
		return null;
	}

	/** Client listener HEAD hook: consume only the exact, one-shot already-checked RPC send. */
	public static boolean allowOutgoing(String text, boolean command) {
		CheckedSend checked = checkedSend.get();
		if (checked != null && !checked.consumed && checked.command == command && checked.text.equals(text)) {
			checked.consumed = true;
			return true;
		}
		return humanHasControls() || reserve(command ? "/" + text : text) == null;
	}

	/** Called only after vanilla handed a chat/command packet to its connection, not on cancellation. */
	public static void outgoingSent(String text, boolean command) {
		hasSent = true;
		lastSendNanos = System.nanoTime();
		CheckedSend checked = checkedSend.get();
		if (checked != null && checked.consumed && checked.command == command) checked.sent = true;
		if (recentSent.size() == 8) recentSent.removeFirst();
		recentSent.addLast(ChatRules.Sent.of(command ? "/" + text : text));
	}

	private static JsonObject send(String text) throws RpcException {
		boolean command = text.startsWith("/");
		Minecraft client = Minecraft.getInstance();
		if (client.player == null || !client.player.connection.getConnection().isConnected()) throw RpcException.unavailable("not connected to a world");
		String rejected = reserve(text);
		if (rejected != null) return result(false, command, rejected);
		CheckedSend checked = new CheckedSend(command ? text.substring(1) : text, command);
		checkedSend.set(checked);
		try {
			if (command) client.player.connection.sendCommand(checked.text);
			else client.player.connection.sendChat(checked.text);
			return result(checked.sent, command, null);
		} finally {
			checkedSend.remove();
		}
	}

	private static JsonObject result(boolean sent, boolean command, String rejected) {
		JsonObject result = Qc.obj();
		result.addProperty("sent", sent);
		result.addProperty("asCommand", command);
		if (rejected != null) result.addProperty("rejected", rejected);
		return result;
	}

	private static void receive(String text, GameProfile profile, PlayerChatMessage message, ChatType.Bound type) {
		String senderName = profile == null ? null : profile.name();
		String senderUuid = profile == null ? null : profile.id().toString();
		String kind = type == null ? "system" : "player";
		boolean outgoingWhisper = type != null && type.chatType().is(ChatType.MSG_COMMAND_OUTGOING);
		if (type != null && (outgoingWhisper || type.chatType().is(ChatType.MSG_COMMAND_INCOMING))) {
			kind = "whisper";
			if (senderName == null) senderName = ChatRules.username(type.name().getString());
		} else if (type == null) {
			String parsedName = ChatRules.whisperSender(text);
			if (parsedName != null) {
				kind = "whisper";
				senderName = parsedName;
			}
		}
		Minecraft client = Minecraft.getInstance();
		boolean self = outgoingWhisper;
		if (client.player != null) {
			if (profile != null) self |= profile.id().equals(client.player.getUUID());
			else if (!self) {
				String localName = client.player.getGameProfile().name();
				for (ChatRules.Sent sent : recentSent) {
					if (sent.echoes(text, localName)) {
						self = true;
						break;
					}
				}
			}
		}
		JsonObject event = Qc.obj();
		event.addProperty("kind", kind);
		if (senderUuid == null) event.add("senderUuid", JsonNull.INSTANCE);
		else event.addProperty("senderUuid", senderUuid);
		if (senderName == null) event.add("senderName", JsonNull.INSTANCE);
		else event.addProperty("senderName", senderName);
		event.addProperty("text", text);
		// Presence/provenance only: this is not a validity or authorization assertion.
		event.addProperty("signed", profile != null && message != null && message.hasSignatureFrom(profile.id()));
		event.addProperty("mentionsMe", kind.equals("whisper") || ChatRules.mentions(text, mentions));
		event.addProperty("self", self);
		Qc.emit("qc.chat", event);
	}
}
