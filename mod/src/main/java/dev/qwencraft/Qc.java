package dev.qwencraft;

import com.google.gson.JsonObject;
import dev.mcpfabric.McpFabric;
import dev.mcpfabric.bridge.RpcHandler;
import dev.mcpfabric.bridge.RpcException;
import dev.mcpfabric.bridge.ThrowingSupplier;
import dev.mcpfabric.client.ClientMc;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Shared helpers for every qwencraft feature: RPC registration, event emission, main-thread calls. */
public final class Qc {
	public static final Logger LOG = LoggerFactory.getLogger("qwencraft");

	private Qc() {}

	/** Registers a {@code qc.*} RPC on MCPFabric's bridge router. Handlers run on an HTTP worker thread. */
	public static void register(String method, RpcHandler handler) {
		McpFabric.router().register(method, handler);
	}

	/** Emits a {@code qc.*} event into MCPFabric's event bus (SSE {@code /events} + {@code events.getRecent}). */
	public static void emit(String type, JsonObject data) {
		McpFabric.events().emit(type, data);
	}

	/**
	 * Runs {@code body} on the Minecraft client thread and waits for the result (MCPFabric's timeout applies).
	 * Already on the client thread → runs inline (scheduling and waiting would deadlock).
	 */
	public static <T> T onMain(ThrowingSupplier<T> body) throws RpcException {
		if (ClientMc.mc().isSameThread()) return body.get();
		return ClientMc.call(body);
	}

	public static JsonObject obj() {
		return new JsonObject();
	}
}
