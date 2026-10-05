package dev.qwencraft.guards;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.io.Reader;
import java.io.StringReader;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Map;

/** Pure placement keys, persistence shape and bounded nearest-result logic. */
final class PlacedIndex {
	record Location(String server, String dimension, int x, int y, int z) {}
	record Entry(String server, String dimension, int x, int y, int z, String id) {
		Location location() { return new Location(server, dimension, x, y, z); }
	}
	record Nearby(Location location, String id, double distanceSquared) {}
	private static final Gson GSON = new Gson();

	private PlacedIndex() {}

	static Entry[] decode(Reader reader) {
		Entry[] entries = GSON.fromJson(reader, Entry[].class);
		if (entries == null) throw new IllegalArgumentException("Expected a placed-block array");
		return entries;
	}

	static String encode(Map<Location, String> blocks) {
		ArrayList<Entry> entries = new ArrayList<>(blocks.size());
		blocks.forEach((location, id) -> entries.add(new Entry(location.server(), location.dimension(), location.x(), location.y(), location.z(), id)));
		return GSON.toJson(entries);
	}

	static boolean stale(String recordedId, String currentId) {
		return recordedId != null && !recordedId.equals(currentId);
	}

	static JsonArray nearest(ArrayList<Nearby> nearby) {
		nearby.sort(Comparator.comparingDouble(Nearby::distanceSquared));
		JsonArray result = new JsonArray();
		for (int i = 0; i < Math.min(64, nearby.size()); i++) {
			Nearby entry = nearby.get(i);
			JsonObject block = new JsonObject();
			block.addProperty("x", entry.location().x());
			block.addProperty("y", entry.location().y());
			block.addProperty("z", entry.location().z());
			block.addProperty("id", entry.id());
			result.add(block);
		}
		return result;
	}

	/** Run with -ea after compilation; requires only Gson, never Fabric or Minecraft. */
	public static void main(String[] args) {
		Entry entry = new Entry("example.test:25565", "minecraft:overworld", 1, 64, 2, "minecraft:cobblestone");
		Map<Location, String> owned = new HashMap<>();
		owned.put(entry.location(), entry.id());
		Entry restored = decode(new StringReader(encode(owned)))[0];
		assert restored.equals(entry);
		assert owned.get(restored.location()).equals("minecraft:cobblestone");
		assert !owned.containsKey(new Location("other.test:25565", entry.dimension(), 1, 64, 2));
		assert !owned.containsKey(new Location(entry.server(), "minecraft:the_nether", 1, 64, 2));
		assert !owned.containsKey(new Location(entry.server(), entry.dimension(), 2, 64, 2));
		assert !stale(entry.id(), "minecraft:cobblestone");
		assert stale(entry.id(), "minecraft:stone");
		assert stale(entry.id(), "minecraft:air");
		assert !stale(null, "minecraft:cobblestone");
		assert nearest(new ArrayList<>()).isEmpty();
		ArrayList<Nearby> candidates = new ArrayList<>();
		for (int x = 64; x >= 0; x--) candidates.add(new Nearby(new Location(entry.server(), entry.dimension(), x, 64, 0), entry.id(), x * x));
		JsonArray result = nearest(candidates);
		assert result.size() == 64;
		assert result.get(0).getAsJsonObject().get("x").getAsInt() == 0;
		assert result.get(63).getAsJsonObject().get("x").getAsInt() == 63;
		assert result.get(0).getAsJsonObject().get("id").getAsString().equals(entry.id());
	}
}
