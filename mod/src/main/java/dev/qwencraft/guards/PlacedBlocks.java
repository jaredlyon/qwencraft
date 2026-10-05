package dev.qwencraft.guards;

import com.google.gson.JsonObject;
import dev.mcpfabric.bridge.RpcException;
import dev.qwencraft.Qc;
import dev.qwencraft.guards.PlacedIndex.Entry;
import dev.qwencraft.guards.PlacedIndex.Location;
import dev.qwencraft.guards.PlacedIndex.Nearby;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;

import java.io.IOException;
import java.io.Reader;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;

/** Agent placement ownership, scoped to the joined server and dimension. Client thread only. */
public final class PlacedBlocks {
	private static final Map<Location, String> blocks = new HashMap<>();
	private static String server;
	private static Path file;
	private static boolean writable;

	private PlacedBlocks() {}

	public static void joined(ClientPacketListener handler) {
		server = null;
		ServerData data = handler.getServerData();
		if (data != null) {
			ServerAddress address = ServerAddress.parseString(data.ip);
			server = address.toString();
		} else if (handler.getConnection().getRemoteAddress() instanceof InetSocketAddress address) {
			server = new ServerAddress(address.getHostString(), address.getPort()).toString();
		}
		file = Minecraft.getInstance().gameDirectory.toPath().resolve("config/qwencraft-placed.json");
		blocks.clear();
		writable = false;
		try {
			if (Files.exists(file)) {
				try (Reader reader = Files.newBufferedReader(file)) {
					Entry[] entries = PlacedIndex.decode(reader);
					for (Entry entry : entries) {
						if (entry == null || entry.server() == null || entry.server().isBlank()
								|| entry.dimension() == null || Identifier.tryParse(entry.dimension()) == null
								|| entry.id() == null || Identifier.tryParse(entry.id()) == null) {
							throw new IllegalArgumentException("Invalid placed-block entry");
						}
						blocks.put(entry.location(), entry.id());
					}
				}
			}
			writable = true;
		} catch (IOException | RuntimeException e) {
			blocks.clear();
			// Fail closed and preserve an unreadable file rather than overwriting ownership evidence.
			Qc.LOG.error("Cannot load qwencraft placed blocks from {}", file, e);
		}
	}

	public static void disconnected() {
		server = null;
		blocks.clear();
	}

	private static Location location(BlockPos pos) {
		Minecraft client = Minecraft.getInstance();
		if (server == null || client.level == null) return null;
		return new Location(server, client.level.dimension().identifier().toString(), pos.getX(), pos.getY(), pos.getZ());
	}

	public static void placed(BlockPos pos) {
		Location location = location(pos);
		if (location == null) return;
		var state = Minecraft.getInstance().level.getBlockState(pos);
		if (state.isAir()) return;
		String id = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
		if (!id.equals(blocks.put(location, id))) save();
	}

	/** Mismatched IDs lose ownership; unloaded chunks are not evidence of removal. */
	public static boolean contains(BlockPos pos) {
		Location location = location(pos);
		if (location == null) return false;
		String id = blocks.get(location);
		if (id == null || !Minecraft.getInstance().level.hasChunkAt(pos)) return false;
		if (!PlacedIndex.stale(id, BuiltInRegistries.BLOCK.getKey(Minecraft.getInstance().level.getBlockState(pos).getBlock()).toString())) return true;
		blocks.remove(location);
		save();
		return false;
	}

	public static void broken(BlockPos pos) {
		Location location = location(pos);
		if (location != null && blocks.remove(location) != null) save();
	}

	public static JsonObject near(JsonObject params) throws RpcException {
		Minecraft client = Minecraft.getInstance();
		if (client.level == null || client.player == null) throw RpcException.unavailable("not connected to a world");
		double x = number(params, "x"), y = number(params, "y"), z = number(params, "z");
		double radius = Math.clamp(number(params, "radius"), 0.0, 16.0);
		double radiusSquared = radius * radius;
		String dimension = client.level.dimension().identifier().toString();
		ArrayList<Nearby> nearby = new ArrayList<>();
		boolean changed = false;
		for (var iterator = blocks.entrySet().iterator(); iterator.hasNext();) {
			var entry = iterator.next();
			Location location = entry.getKey();
			if (!location.server().equals(server) || !location.dimension().equals(dimension)) continue;
			double dx = location.x() - x, dy = location.y() - y, dz = location.z() - z;
			double distanceSquared = dx * dx + dy * dy + dz * dz;
			if (distanceSquared > radiusSquared) continue;
			BlockPos pos = new BlockPos(location.x(), location.y(), location.z());
			if (!client.level.hasChunkAt(pos)) continue;
			String currentId = BuiltInRegistries.BLOCK.getKey(client.level.getBlockState(pos).getBlock()).toString();
			if (PlacedIndex.stale(entry.getValue(), currentId)) {
				iterator.remove();
				changed = true;
			} else nearby.add(new Nearby(location, currentId, distanceSquared));
		}
		if (changed) save();
		JsonObject result = Qc.obj();
		result.add("blocks", PlacedIndex.nearest(nearby));
		return result;
	}


	private static double number(JsonObject params, String name) throws RpcException {
		if (params == null || !params.has(name) || !params.get(name).isJsonPrimitive()
				|| !params.getAsJsonPrimitive(name).isNumber()) throw RpcException.badRequest(name + " must be a finite number");
		double value = params.get(name).getAsDouble();
		if (!Double.isFinite(value)) throw RpcException.badRequest(name + " must be a finite number");
		return value;
	}

	private static void save() {
		if (!writable) return;
		Path temporary = null;
		try {
			Files.createDirectories(file.getParent());
			temporary = Files.createTempFile(file.getParent(), "qwencraft-placed-", ".tmp");
			Files.writeString(temporary, PlacedIndex.encode(blocks));
			Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
		} catch (IOException e) {
			Qc.LOG.error("Cannot save qwencraft placed blocks to {}", file, e);
		} finally {
			if (temporary != null) {
				try { Files.deleteIfExists(temporary); }
				catch (IOException e) { Qc.LOG.warn("Cannot remove placed-block temporary file {}", temporary, e); }
			}
		}
	}

}
