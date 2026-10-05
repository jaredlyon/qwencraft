package dev.qwencraft;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.mcpfabric.bridge.RpcException;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Process-wide harness state shared by all features: config pushed by {@code qc.config.apply} and the pause latch.
 * Config fields are replaced wholesale (immutable records behind volatile references).
 */
public final class QcState {
	public enum PauseReason {
		HOTKEY("hotkey"), MANUAL_INPUT("manual_input"), LEASE_EXPIRED("lease_expired"), CONSOLE("console");

		public final String wire;

		PauseReason(String wire) {
			this.wire = wire;
		}

		/** Reflexes are disabled only while the human has the controls. */
		public boolean humanHasControls() {
			return this == HOTKEY || this == MANUAL_INPUT;
		}
	}

	public record ReflexConfig(boolean enabled, int eatAtFood) {}
	public record Zone(String name, int minX, int minY, int minZ, int maxX, int maxY, int maxZ) {
		public boolean contains(int x, int y, int z) {
			return x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ;
		}
	}
	public record ProtectConfig(List<String> naturalBlocks, List<Zone> zones) {}
	public record ChatLimits(long minIntervalMs, int maxLen) {}
	public record Nicknames(List<String> names, List<String> wholeWords) {}

	// Safe defaults until the controller pushes config: reflexes on, nothing breakable, strict chat limits, no commands.
	public static volatile ReflexConfig reflex = new ReflexConfig(true, 14);
	public static volatile ProtectConfig protect = new ProtectConfig(List.of(), List.of());
	public static volatile ChatLimits chat = new ChatLimits(3000, 256);
	public static volatile List<String> commandAllowlist = List.of();
	public static volatile Nicknames nicknames = new Nicknames(List.of(), List.of());

	private static final List<Runnable> PAUSE_LISTENERS = new CopyOnWriteArrayList<>();
	private static final List<Runnable> CONFIG_LISTENERS = new CopyOnWriteArrayList<>();
	private static volatile PauseReason pauseReason = null;

	private QcState() {}

	public static boolean paused() {
		return pauseReason != null;
	}

	public static PauseReason pauseReason() {
		return pauseReason;
	}

	/** Called on pause; must release every synthetic control it owns. Runs on the thread that paused. */
	public static void onPause(Runnable cleanup) {
		PAUSE_LISTENERS.add(cleanup);
	}

	/** Called after {@code qc.config.apply} replaced the config. */
	public static void onConfig(Runnable listener) {
		CONFIG_LISTENERS.add(listener);
	}

	/**
	 * Latches a pause and runs every cleanup, emitting {@code qc.pause} when the state changes. The first reason wins,
	 * except that a human-controls reason (hotkey/manual_input) upgrades a console/lease pause so reflexes switch off.
	 */
	public static synchronized void pause(PauseReason reason) {
		PauseReason prev = pauseReason;
		boolean upgrade = prev != null && reason.humanHasControls() && !prev.humanHasControls();
		if (prev == null || upgrade) pauseReason = reason;
		for (Runnable r : PAUSE_LISTENERS) {
			try {
				r.run();
			} catch (RuntimeException e) {
				Qc.LOG.error("pause cleanup failed", e);
			}
		}
		if (prev == null || upgrade) emitPause();
	}

	public static synchronized void resume() {
		if (pauseReason == null) return;
		pauseReason = null;
		emitPause();
	}

	private static void emitPause() {
		JsonObject d = Qc.obj();
		d.addProperty("paused", pauseReason != null);
		if (pauseReason == null) d.add("reason", com.google.gson.JsonNull.INSTANCE);
		else d.addProperty("reason", pauseReason.wire);
		Qc.emit("qc.pause", d);
	}

	static void registerRpcs() {
		Qc.register("qc.config.apply", ctx -> {
			JsonObject p = ctx.params();
			JsonObject r = req(p, "reflex");
			JsonObject pr = req(p, "protect");
			JsonObject c = req(p, "chat");
			JsonObject n = req(p, "nicknames");
			List<Zone> zones = new ArrayList<>();
			for (JsonElement z : arr(pr, "zones")) {
				JsonObject zo = z.getAsJsonObject();
				int[] a = vec(zo, "min"), b = vec(zo, "max");
				zones.add(new Zone(zo.get("name").getAsString(),
						Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]),
						Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])));
			}
			reflex = new ReflexConfig(r.get("enabled").getAsBoolean(), r.get("eatAtFood").getAsInt());
			protect = new ProtectConfig(strings(arr(pr, "naturalBlocks")), List.copyOf(zones));
			chat = new ChatLimits(c.get("minIntervalMs").getAsLong(), c.get("maxLen").getAsInt());
			commandAllowlist = strings(arr(p, "commandAllowlist"));
			nicknames = new Nicknames(strings(arr(n, "names")), strings(arr(n, "wholeWords")));
			for (Runnable l : CONFIG_LISTENERS) l.run();
			JsonObject out = Qc.obj();
			out.addProperty("ok", true);
			return out;
		});
	}

	private static JsonObject req(JsonObject p, String key) throws RpcException {
		if (p == null || !p.has(key) || !p.get(key).isJsonObject()) throw RpcException.badRequest("missing object: " + key);
		return p.getAsJsonObject(key);
	}

	private static JsonArray arr(JsonObject p, String key) throws RpcException {
		if (!p.has(key) || !p.get(key).isJsonArray()) throw RpcException.badRequest("missing array: " + key);
		return p.getAsJsonArray(key);
	}

	private static int[] vec(JsonObject o, String key) throws RpcException {
		JsonArray a = arr(o, key);
		if (a.size() != 3) throw RpcException.badRequest(key + " must be [x,y,z]");
		return new int[] {a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt()};
	}

	private static List<String> strings(JsonArray a) {
		List<String> out = new ArrayList<>(a.size());
		for (JsonElement e : a) out.add(e.getAsString());
		return List.copyOf(out);
	}
}
