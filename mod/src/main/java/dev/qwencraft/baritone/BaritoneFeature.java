package dev.qwencraft.baritone;

import baritone.api.BaritoneAPI;
import baritone.api.IBaritone;
import baritone.api.Settings;
import baritone.api.event.events.PathEvent;
import baritone.api.event.listener.AbstractGameEventListener;
import baritone.api.pathing.goals.Goal;
import baritone.api.pathing.goals.GoalBlock;
import baritone.api.pathing.goals.GoalNear;
import baritone.api.pathing.goals.GoalXZ;
import baritone.api.process.IBaritoneProcess;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import dev.mcpfabric.bridge.RpcException;
import dev.mcpfabric.client.ClientMc;
import dev.qwencraft.Qc;
import dev.qwencraft.QcState;
import dev.qwencraft.baritone.mixin.DeathScreenAccessor;
import dev.qwencraft.baritone.mixin.DisconnectedScreenAccessor;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.DeathScreen;
import net.minecraft.client.gui.screens.DisconnectedScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.DisconnectionDetails;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.world.level.block.Block;

import java.net.InetSocketAddress;
import java.util.AbstractList;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** One owned Baritone process; events are diagnostics, never completion verdicts. */
public final class BaritoneFeature {
	private static IBaritone baritone;
	private static long counter;
	private static Task task;
	private static boolean deathReported;
	private static boolean disconnectReported;
	private static Screen lastDisconnectScreen;
	private static String requestedHost = "";
	private static int requestedPort;

	private static final class Task {
		final String id;
		final String kind;
		final IBaritoneProcess process;
		Runnable start;
		String lastPathEvent;
		boolean sawControl;
		boolean signaled;
		boolean lostControl;
		boolean canceled;

		Task(String kind, IBaritoneProcess process, Runnable start) {
			this.id = "t" + ++counter;
			this.kind = kind;
			this.process = process;
			this.start = start;
		}
	}

	private static final class BlockLookupList extends AbstractList<Block> {
		private final Block[] blocks;
		private final Set<Block> lookup;

		BlockLookupList(List<Block> blocks) {
			this.blocks = blocks.toArray(Block[]::new);
			this.lookup = new HashSet<>(blocks);
		}

		@Override
		public Block get(int index) {
			return blocks[index];
		}

		@Override
		public int size() {
			return blocks.length;
		}

		@Override
		public boolean contains(Object block) {
			return lookup.contains(block);
		}
	}

	private BaritoneFeature() {}

	public static void init() {
		// Entrypoints run on the render thread before the client loop starts; scheduling onto it would deadlock.
		baritone = BaritoneAPI.getProvider().getPrimaryBaritone();
		baritone.getGameEventHandler().registerEventListener(new AbstractGameEventListener() {
			@Override
			public void onPathEvent(PathEvent event) {
				BaritoneFeature.onMain(() -> pathEvent(event));
			}
		});
		applySettingsNow(true);
		QcState.onConfig(BaritoneFeature::applySettings);
		QcState.onPause(() -> onMain(BaritoneFeature::cancelEverything));

		Qc.register("qc.baritone.goto", ctx -> Qc.onMain(() -> {
			requireWork();
			int x = coordinate(ctx.getDouble("x"), "x");
			int z = coordinate(ctx.getDouble("z"), "z");
			Goal goal;
			if (!ctx.has("y")) {
				goal = new GoalXZ(x, z);
			} else {
				int y = coordinate(ctx.getDouble("y"), "y");
				if (ctx.has("range")) {
					double range = ctx.getDouble("range");
					if (!Double.isFinite(range) || range < 0 || Math.floor(range) > 46340) {
						throw RpcException.badRequest("range must be finite and between 0 and 46340 (Baritone squares an int)");
					}
					goal = new GoalNear(new BlockPos(x, y, z), (int)Math.floor(range));
				} else {
					goal = new GoalBlock(x, y, z);
				}
			}
			return start("goto", baritone.getCustomGoalProcess(),
					() -> baritone.getCustomGoalProcess().setGoalAndPath(goal));
		}));
		Qc.register("qc.baritone.mine", ctx -> Qc.onMain(() -> {
			requireWork();
			List<String> blocks = ctx.getStringList("blocks");
			if (blocks.isEmpty()) throw RpcException.badRequest("blocks must not be empty");
			double count = ctx.getDouble("targetCount");
			if (!Double.isFinite(count) || count <= 0 || count > Integer.MAX_VALUE || count != Math.floor(count)) {
				throw RpcException.badRequest("targetCount must be a positive integer");
			}
			String[] ids = new String[blocks.size()];
			boolean allOres = true;
			for (int i = 0; i < ids.length; i++) {
				Identifier id = Identifier.tryParse(blocks.get(i));
				if (id == null || !BuiltInRegistries.BLOCK.containsKey(id)) {
					throw RpcException.badRequest("unknown block: " + blocks.get(i));
				}
				ids[i] = id.toString();
				if (!id.getPath().endsWith("_ore") && !ids[i].equals("minecraft:ancient_debris")) allOres = false;
			}
			boolean legitMine = allOres;
			// The controller owns the per-ore height table and digs down first; it passes that height as `y`.
			int branchY = ctx.optInt("y", Minecraft.getInstance().player.getBlockY());
			return start("mine", baritone.getMineProcess(), () -> {
				Settings settings = BaritoneAPI.getSettings();
				settings.legitMine.value = legitMine;
				if (legitMine) settings.legitMineYLevel.value = branchY;
				baritone.getMineProcess().mineByName((int)count, ids);
			});
		}));
		Qc.register("qc.baritone.follow", ctx -> Qc.onMain(() -> {
			requireWork();
			String name = ctx.getString("player");
			var player = ClientMc.level().players().stream()
					.filter(p -> p.getGameProfile().name().equalsIgnoreCase(name)).findFirst()
					.orElseThrow(() -> new RpcException("player_not_loaded", "Player is not loaded: " + name));
			return start("follow", baritone.getFollowProcess(),
					() -> baritone.getFollowProcess().follow(entity -> entity == player));
		}));
		Qc.register("qc.baritone.explore", ctx -> Qc.onMain(() -> {
			requireWork();
			int x = coordinate(ctx.getDouble("x"), "x");
			int z = coordinate(ctx.getDouble("z"), "z");
			return start("explore", baritone.getExploreProcess(), () -> baritone.getExploreProcess().explore(x, z));
		}));
		Qc.register("qc.baritone.stop", ctx -> Qc.onMain(() -> {
			cancelEverything();
			return flag("stopped", true);
		}));
		Qc.register("qc.baritone.status", ctx -> Qc.onMain(() -> {
			JsonObject out = Qc.obj();
			out.addProperty("active", task != null && !task.canceled && !task.lostControl
					&& (task.start != null || task.process.isActive()));
			nullable(out, "taskId", task == null ? null : task.id);
			nullable(out, "kind", task == null ? null : task.kind);
			nullable(out, "lastPathEvent", task == null ? null : task.lastPathEvent);
			return out;
		}));
		Qc.register("qc.world.state", ctx -> Qc.onMain(() -> {
			ClientLevel level = Minecraft.getInstance().level;
			if (level == null) throw RpcException.unavailable("No client world is loaded");
			JsonObject out = Qc.obj();
			out.addProperty("dimension", level.dimension().identifier().toString());
			// 26.3 replaced dayTime with world clocks; this is the vanilla legacy-day accessor.
			out.addProperty("dayTime", level.getOverworldClockTime());
			out.addProperty("gameTime", level.getGameTime());
			out.addProperty("raining", level.isRaining());
			out.addProperty("thundering", level.isThundering());
			return out;
		}));
		Qc.register("qc.session.respawn", ctx -> Qc.onMain(() -> {
			LocalPlayer player = Minecraft.getInstance().player;
			if (player == null || !player.isDeadOrDying()) return flag("ok", false);
			player.respawn();
			return flag("ok", true);
		}));
		Qc.register("qc.session.connect", ctx -> Qc.onMain(() -> {
			Minecraft client = Minecraft.getInstance();
			String host = ctx.getString("host").trim();
			double portNumber = ctx.getDouble("port");
			if (host.isEmpty() || !ServerAddress.isValidAddress(host)
					|| !Double.isFinite(portNumber) || portNumber != Math.floor(portNumber)
					|| portNumber < 1 || portNumber > 65535) {
				throw RpcException.badRequest("host must be a valid server host and port must be an integer from 1 to 65535");
			}
			if (client.level != null || client.gui.screen() instanceof ConnectScreen) return flag("started", false);
			int port = (int)portNumber;
			ServerAddress address;
			try {
				address = new ServerAddress(host, port);
			} catch (IllegalArgumentException e) {
				throw RpcException.badRequest("host must not include a port; use the separate port parameter");
			}
			ServerData server = new ServerData("Qwencraft", address.toString(), ServerData.Type.OTHER);
			Screen parent = client.gui.screen();
			requestedHost = address.getHost();
			requestedPort = port;
			disconnectReported = false;
			lastDisconnectScreen = null;
			ConnectScreen.startConnecting(parent == null ? new TitleScreen() : parent, client, address, server, false, null);
			return flag("started", true);
		}));

		ClientTickEvents.END_CLIENT_TICK.register(client -> onMain(() -> tick(client)));
		ClientPlayConnectionEvents.JOIN.register((handler, sender, client) -> onMain(() -> joined(handler)));
		ClientPlayConnectionEvents.DISCONNECT.register((handler, client) -> onMain(() -> {
			cancelEverything();
			deathReported = false;
			DisconnectionDetails details = handler.getConnection().getDisconnectionDetails();
			disconnected(details == null ? ClientLevel.DEFAULT_QUIT_MESSAGE.getString() : details.reason().getString());
		}));
	}

	public static void applySettings() {
		onMain(() -> applySettingsNow(false));
	}

	private static void applySettingsNow(boolean initialize) {
		Settings settings = BaritoneAPI.getSettings();
		settings.allowBreak.value = true;
		settings.allowPlace.value = true;
		settings.allowSprint.value = true;
		settings.allowParkour.value = true;
		if (initialize) {
			settings.legitMine.value = true;
			settings.legitMineYLevel.value = 16;
		}
		settings.chatControl.value = false;
		settings.prefixControl.value = false;
		// Baritone prints status/failure lines into the local chat HUD; send them to the game log instead.
		settings.logger.value = message -> Qc.LOG.info("[Baritone] {}", message.getString());
		Set<String> allowed = new HashSet<>(QcState.protect.naturalBlocks());
		List<Block> disallowed = new ArrayList<>();
		for (Block block : BuiltInRegistries.BLOCK) {
			if (!allowed.contains(BuiltInRegistries.BLOCK.getKey(block).toString())) disallowed.add(block);
		}
		settings.blocksToDisallowBreaking.value = new BlockLookupList(disallowed);
	}

	private static void requireWork() throws RpcException {
		if (QcState.paused()) throw new RpcException("paused", "Agent is paused");
		ClientMc.player();
		ClientMc.level();
		if (Minecraft.getInstance().player.isDeadOrDying()) throw RpcException.unavailable("Local player is dead");
	}

	private static JsonObject start(String kind, IBaritoneProcess process, Runnable action) {
		cancelEverything();
		// Drain the old process's queued path events before starting its replacement at END_CLIENT_TICK.
		task = new Task(kind, process, action);
		JsonObject out = flag("started", true);
		out.addProperty("taskId", task.id);
		return out;
	}

	private static void cancelEverything() {
		if (task != null) {
			task.start = null;
			if (!task.canceled && !task.lostControl) signal(task, "canceled", "explicit cancellation");
			task.canceled = true;
		}
		if (!baritone.getPathingBehavior().cancelEverything()) baritone.getPathingBehavior().forceCancel();
		baritone.getInputOverrideHandler().clearAllKeys();
	}

	private static void pathEvent(PathEvent event) {
		Task current = task;
		if (current == null || current.start != null || current.canceled || current.lostControl) return;
		current.lastPathEvent = event.name();
		String state = pathState(event);
		if (state != null) signal(current, state, null);
	}

	static String pathState(PathEvent event) {
		return switch (event) {
			case AT_GOAL -> "at_goal";
			case CALC_FAILED, NEXT_CALC_FAILED -> "calc_failed";
			case CANCELED -> "canceled";
			default -> null;
		};
	}

	private static void signal(Task current, String state, String detail) {
		current.signaled = true;
		JsonObject out = Qc.obj();
		out.addProperty("taskId", current.id);
		out.addProperty("kind", current.kind);
		out.addProperty("state", state);
		if (detail != null) out.addProperty("detail", detail);
		Qc.emit("qc.task", out);
	}

	private static void tick(Minecraft client) {
		Task current = task;
		if (current != null && !current.canceled && !current.lostControl) {
			if (current.start != null) {
				if (QcState.paused() || client.level == null || client.player == null || client.player.isDeadOrDying()) {
					cancelEverything();
				} else {
					Runnable action = current.start;
					current.start = null;
					try {
						action.run();
					} catch (RuntimeException e) {
						cancelEverything();
						Qc.LOG.error("Unable to start Baritone task {}", current.id, e);
					}
				}
			} else {
				IBaritoneProcess owner = baritone.getPathingControlManager().mostRecentInControl().orElse(null);
				if (owner == current.process) current.sawControl = true;
				if (!current.signaled && (!current.process.isActive()
						|| (current.sawControl && owner != current.process))) {
					current.lostControl = true;
					signal(current, "lost_control", "owned process became inactive or relinquished control");
				}
			}
		}
		LocalPlayer player = client.player;
		Screen screen = client.gui.screen();
		if (player != null) {
			if (screen instanceof DeathScreen) {
				Component cause = ((DeathScreenAccessor)screen).qwencraft$causeOfDeath();
				death(player, cause == null ? "" : cause.getString());
			} else if (player.isDeadOrDying()) {
				death(player, "");
			} else {
				deathReported = false;
			}
		}
		if (screen instanceof ConnectScreen && lastDisconnectScreen != null) {
			// Manual connection attempts use the same once-per-attempt reporting as RPC attempts.
			lastDisconnectScreen = null;
			disconnectReported = false;
		}
		if (screen instanceof DisconnectedScreen && screen != lastDisconnectScreen) {
			lastDisconnectScreen = screen;
			DisconnectionDetails details = ((DisconnectedScreenAccessor)screen).qwencraft$details();
			cancelEverything();
			disconnected(details.reason().getString());
		}
	}

	/** Called after vanilla has marshalled and processed the combat-kill packet. */
	public static void deathPacket(int playerId, Component message) {
		onMain(() -> {
			LocalPlayer player = Minecraft.getInstance().player;
			if (player != null && player.getId() == playerId) death(player, message.getString());
		});
	}

	private static void death(LocalPlayer player, String message) {
		if (deathReported) return;
		deathReported = true;
		cancelEverything();
		JsonObject out = Qc.obj();
		out.addProperty("x", player.getX());
		out.addProperty("y", player.getY());
		out.addProperty("z", player.getZ());
		out.addProperty("message", message);
		Qc.emit("qc.death", out);
	}

	private static void joined(ClientPacketListener handler) {
		deathReported = false;
		disconnectReported = false;
		lastDisconnectScreen = null;
		String host = "";
		int port = 0;
		ServerData server = handler.getServerData();
		if (server != null) {
			ServerAddress address = ServerAddress.parseString(server.ip);
			host = address.getHost();
			port = address.getPort();
		} else if (handler.getConnection().getRemoteAddress() instanceof InetSocketAddress address) {
			host = address.getHostString();
			port = address.getPort();
		} else if (!handler.getConnection().isMemoryConnection()) {
			host = requestedHost;
			port = requestedPort;
		}
		JsonObject out = Qc.obj();
		out.addProperty("host", host);
		out.addProperty("port", port);
		Qc.emit("qc.join", out);
	}

	private static void disconnected(String reason) {
		if (disconnectReported) return;
		disconnectReported = true;
		JsonObject out = Qc.obj();
		out.addProperty("reason", reason);
		Qc.emit("qc.disconnect", out);
	}

	static int coordinate(double value, String name) throws RpcException {
		double floored = Math.floor(value);
		if (!Double.isFinite(value) || floored < Integer.MIN_VALUE || floored > Integer.MAX_VALUE) {
			throw RpcException.badRequest(name + " must be a finite integer-sized coordinate");
		}
		return (int)floored;
	}

	private static JsonObject flag(String name, boolean value) {
		JsonObject out = Qc.obj();
		out.addProperty(name, value);
		return out;
	}

	private static void nullable(JsonObject out, String name, String value) {
		if (value == null) out.add(name, JsonNull.INSTANCE);
		else out.addProperty(name, value);
	}

	private static void onMain(Runnable action) {
		try {
			Qc.onMain(() -> {
				action.run();
				return null;
			});
		} catch (RpcException e) {
			throw new IllegalStateException("Cannot run qwencraft Baritone callback on the client thread", e);
		}
	}
}
