package dev.qwencraft.control;

import baritone.api.BaritoneAPI;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import dev.mcpfabric.bridge.RpcException;
import dev.mcpfabric.client.BotController;
import dev.qwencraft.Qc;
import dev.qwencraft.QcState;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keymapping.v1.KeyMappingHelper;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElementRegistry;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.resources.Identifier;
import org.lwjgl.sdl.SDLMouse;

/** All fields and gameplay mutations are confined to the Minecraft client thread. */
public final class ControlFeature {
	private static KeyMapping toggle;
	private static KeyMapping[] manualKeys;
	private static KeyMapping[] controlledKeys;
	private static boolean toggleWasDown;
	private static boolean ownInput;
	private static long leaseRenewedAt;
	private static long leaseTtlMs = 3000;
	private static String goal = "", action = "", thought = "";

	private ControlFeature() {}

	public static void init() {
		toggle = KeyMappingHelper.registerKeyMapping(new KeyMapping("key.qwencraft.pause",
				InputConstants.KEY_F8, KeyMapping.Category.register(Identifier.fromNamespaceAndPath("qwencraft", "qwencraft"))));
		// Options do not exist yet while entrypoints run; capture the vanilla mappings once the client has started.
		ClientLifecycleEvents.CLIENT_STARTED.register(mc -> {
			manualKeys = new KeyMapping[] {mc.options.keyUp, mc.options.keyDown, mc.options.keyLeft, mc.options.keyRight,
					mc.options.keyJump, mc.options.keyShift, mc.options.keyAttack, mc.options.keyUse};
			controlledKeys = new KeyMapping[] {mc.options.keyUp, mc.options.keyDown, mc.options.keyLeft, mc.options.keyRight,
					mc.options.keyJump, mc.options.keyShift, mc.options.keySprint, mc.options.keyAttack, mc.options.keyUse};
		});
		leaseRenewedAt = System.nanoTime();
		QcState.onPause(() -> cleanup(true));
		ClientPlayConnectionEvents.DISCONNECT.register((handler, client) -> cleanup(false));
		ClientTickEvents.START_CLIENT_TICK.register(client -> {
			checkPhysicalInput(client);
			if (QcState.paused()) restorePhysicalKeys();
			Reflexes.applyMovement(client);
		});
		ClientTickEvents.END_CLIENT_TICK.register(client -> {
			checkPhysicalInput(client);
			if (!QcState.paused() && remainingLeaseMs() == 0) QcState.pause(QcState.PauseReason.LEASE_EXPIRED);
			if (QcState.paused()) restorePhysicalKeys();
			Reflexes.tick(client);
		});
		HudElementRegistry.addLast(Identifier.fromNamespaceAndPath("qwencraft", "control"), (graphics, delta) -> renderHud(graphics));

		Qc.register("qc.control.lease", ctx -> {
			double ttl = ctx.optDouble("ttlMs", 3000);
			if (!Double.isFinite(ttl) || ttl < 1 || ttl != Math.floor(ttl) || ttl >= Long.MAX_VALUE)
				throw RpcException.badRequest("ttlMs must be a positive integer number of milliseconds");
			return Qc.onMain(() -> {
				leaseTtlMs = (long) ttl;
				leaseRenewedAt = System.nanoTime();
				return pauseSnapshot(false);
			});
		});
		Qc.register("qc.control.pause", ctx -> {
			if (!"console".equals(ctx.getString("reason"))) throw RpcException.badRequest("reason must be console");
			return Qc.onMain(() -> {
				QcState.pause(QcState.PauseReason.CONSOLE);
				return pausedResult(true);
			});
		});
		Qc.register("qc.control.resume", ctx -> Qc.onMain(() -> {
			Reflexes.finish(Minecraft.getInstance(), true);
			QcState.resume();
			return pausedResult(false);
		}));
		Qc.register("qc.control.state", ctx -> Qc.onMain(() -> pauseSnapshot(true)));
		Qc.register("qc.hud.set", ctx -> {
			JsonObject p = ctx.params();
			String g = optionalString(p, "goal"), a = optionalString(p, "action"), t = optionalString(p, "thought");
			return Qc.onMain(() -> {
				setHud(g, a, t);
				JsonObject out = Qc.obj(); out.addProperty("ok", true); return out;
			});
		});
	}

	private static String optionalString(JsonObject p, String key) throws RpcException {
		if (!p.has(key)) return null;
		JsonElement v = p.get(key);
		if (!v.isJsonPrimitive() || !v.getAsJsonPrimitive().isString()) throw RpcException.badRequest(key + " must be a string");
		return v.getAsString();
	}

	/** Null means omitted, while an empty string explicitly clears a field. */
	public static void setHud(String newGoal, String newAction, String newThought) {
		if (newGoal != null) goal = newGoal.replace('\n', ' ').replace('\r', ' ');
		if (newAction != null) action = newAction.replace('\n', ' ').replace('\r', ' ');
		if (newThought != null) thought = newThought.replace('\n', ' ').replace('\r', ' ');
	}

	private static void renderHud(GuiGraphicsExtractor graphics) {
		Minecraft mc = Minecraft.getInstance();
		if (mc.player == null || mc.gui.hud.isHidden()) return;
		int width = Math.max(0, graphics.guiWidth() - 12);
		graphics.fill(3, 3, graphics.guiWidth() - 3, 49, 0x90000000);
		String status = QcState.paused() ? "PAUSED (" + QcState.pauseReason().wire + ")" : "Qwen active";
		graphics.text(mc.font, mc.font.plainSubstrByWidth(status, width), 6, 6, QcState.paused() ? 0xFFFF5555 : 0xFF55FF55);
		graphics.text(mc.font, mc.font.plainSubstrByWidth("Goal: " + goal, width), 6, 16, 0xFFFFFFFF);
		graphics.text(mc.font, mc.font.plainSubstrByWidth("Action: " + action, width), 6, 26, 0xFFFFFFFF);
		graphics.text(mc.font, mc.font.plainSubstrByWidth("Thought: " + thought, width), 6, 36, 0xFFCCCCCC);
	}

	private static long remainingLeaseMs() {
		return ControlRules.remainingLeaseMs(leaseTtlMs, System.nanoTime() - leaseRenewedAt);
	}

	private static JsonObject pauseSnapshot(boolean withLease) {
		JsonObject out = pausedResult(QcState.paused());
		if (QcState.pauseReason() == null) out.add("reason", JsonNull.INSTANCE);
		else out.addProperty("reason", QcState.pauseReason().wire);
		if (withLease) out.addProperty("leaseExpiresInMs", remainingLeaseMs());
		return out;
	}

	private static JsonObject pausedResult(boolean paused) {
		JsonObject out = Qc.obj(); out.addProperty("paused", paused); return out;
	}

	private static void checkPhysicalInput(Minecraft mc) {
		boolean pressed = mc.isWindowActive() && physicallyDown(toggle);
		if (pressed && !toggleWasDown) {
			if (QcState.paused()) {
				Reflexes.finish(mc, true);
				QcState.resume();
			} else QcState.pause(QcState.PauseReason.HOTKEY);
		}
		toggleWasDown = pressed;
		while (toggle.consumeClick()) { /* Physical edges, including screens, are authoritative. */ }
		if (manualKeys == null || mc.player == null || !mc.isWindowActive() || mc.gui.screen() != null || humanPaused()) return;
		for (KeyMapping mapping : manualKeys) {
			if (physicallyDown(mapping)) {
				QcState.pause(QcState.PauseReason.MANUAL_INPUT);
				return;
			}
		}
	}

	public static void onPhysicalMouseMove() {
		Minecraft mc = Minecraft.getInstance();
		if (mc.player != null && mc.isWindowActive() && mc.gui.screen() == null && !humanPaused())
			QcState.pause(QcState.PauseReason.MANUAL_INPUT);
	}

	static boolean humanPaused() {
		return QcState.paused() && QcState.pauseReason().humanHasControls();
	}

	static boolean physicallyDown(KeyMapping mapping) {
		if (mapping == null || mapping.isUnbound()) return false;
		InputConstants.Key key = KeyMappingHelper.getBoundKeyOf(mapping);
		if (key.getType() == InputConstants.Type.KEYBOARD) return InputConstants.isKeyDown(key.getValue());
		int button = key.getValue();
		return button > 0 && button <= 32 && (SDLMouse.SDL_GetMouseState(null, null) & (1 << (button - 1))) != 0;
	}

	/** Called by the KeyMapping mixin: never leave synthetic inputs held through a pause. */
	public static boolean filterKeyState(KeyMapping mapping, boolean requested) {
		if (!ownInput && controlledKeys != null && (QcState.paused() || Reflexes.active())) {
			for (KeyMapping key : controlledKeys) if (mapping == key)
				return Minecraft.getInstance().isWindowActive() && physicallyDown(mapping);
		}
		return requested;
	}

	/** Denies stale MCP work during pause, and prevents it competing with a reflex. */
	public static boolean agentWorkBlocked() {
		return ControlRules.ordinaryWorkBlocked(ownInput, QcState.paused(), Reflexes.active());
	}

	/** Client action-path gate; human control remains vanilla, reflex calls are scoped. */
	public static boolean gameplayBlocked() {
		return ControlRules.gameplayBlocked(ownInput, QcState.paused(), humanPaused(), Reflexes.active());
	}

	static void input(Runnable mutation) {
		boolean previous = ownInput;
		ownInput = true;
		try { mutation.run(); } finally { ownInput = previous; }
	}

	private static void restorePhysicalKeys() {
		if (controlledKeys == null) return;
		for (KeyMapping mapping : controlledKeys) mapping.setDown(Minecraft.getInstance().isWindowActive() && physicallyDown(mapping));
	}

	static void cancelBaritone() {
		var baritone = BaritoneAPI.getProvider().getPrimaryBaritone();
		if (!baritone.getPathingBehavior().cancelEverything()) baritone.getPathingBehavior().forceCancel();
		baritone.getInputOverrideHandler().clearAllKeys();
	}

	static void stopOrdinaryWork(String reason) {
		cancelBaritone();
		BotController.get().stopAllMovement();
		BotController.get().stopMining();
		BotController.get().stopNavigation(reason);
		Minecraft mc = Minecraft.getInstance();
		if (mc.gameMode != null && mc.player != null) {
			mc.gameMode.stopDestroyBlock();
			if (mc.player.isUsingItem()) mc.gameMode.releaseUsingItem(mc.player);
		}
		releaseKeys();
	}

	static void releaseKeys() {
		restorePhysicalKeys();
		if (controlledKeys == null) return;
		for (KeyMapping key : controlledKeys) while (key.consumeClick()) { /* Discard synthetic pending clicks. */ }
	}

	private static void cleanup(boolean connected) {
		Minecraft mc = Minecraft.getInstance();
		Reflexes.finish(mc, connected);
		BotController.get().stopAllMovement();
		BotController.get().stopMining();
		BotController.get().stopNavigation("paused");
		if (mc.player != null) {
			if (connected && mc.gameMode != null) {
				mc.gameMode.stopDestroyBlock();
				mc.gameMode.releaseUsingItem(mc.player);
			} else mc.player.stopUsingItem();
		}
		releaseKeys();
	}
}
