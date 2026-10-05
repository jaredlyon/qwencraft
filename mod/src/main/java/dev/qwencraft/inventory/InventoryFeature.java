package dev.qwencraft.inventory;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import dev.mcpfabric.bridge.RpcException;
import dev.qwencraft.Qc;
import net.minecraft.client.Minecraft;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.AnvilMenu;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.enchantment.ItemEnchantments;
import net.minecraft.world.item.enchantment.Repairable;

/** Read-only tool durability, repair materials, and the current anvil result. */
public final class InventoryFeature {
	private static final EquipmentSlot[] EQUIPMENT = {
			EquipmentSlot.HEAD, EquipmentSlot.CHEST, EquipmentSlot.LEGS, EquipmentSlot.FEET, EquipmentSlot.OFFHAND
	};

	private InventoryFeature() {}

	public static void init() {
		Qc.register("qc.inventory.tools", ctx -> Qc.onMain(InventoryFeature::tools));
		Qc.register("qc.anvil.state", ctx -> Qc.onMain(InventoryFeature::anvilState));
	}

	private static JsonObject tools() throws RpcException {
		Minecraft client = Minecraft.getInstance();
		if (client.player == null || client.level == null) throw RpcException.unavailable("not connected to a world");
		Inventory inventory = client.player.getInventory();
		JsonArray tools = new JsonArray();
		for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
			JsonObject tool = tool(inventory.getItem(slot));
			if (tool == null) continue;
			tool.addProperty("slot", slot);
			tools.add(tool);
		}
		for (EquipmentSlot slot : EQUIPMENT) {
			int index = slot == EquipmentSlot.OFFHAND ? Inventory.SLOT_OFFHAND : slot.getIndex(Inventory.INVENTORY_SIZE);
			JsonObject tool = tool(inventory.getItem(index));
			if (tool == null) continue;
			tool.addProperty("slot", slot.getName());
			tools.add(tool);
		}
		JsonObject result = Qc.obj();
		result.add("tools", tools);
		return result;
	}

	private static JsonObject tool(ItemStack stack) {
		if (stack.isEmpty() || stack.getMaxDamage() <= 0) return null;
		JsonObject tool = Qc.obj();
		tool.addProperty("id", BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
		tool.addProperty("damage", stack.getDamageValue());
		tool.addProperty("maxDamage", stack.getMaxDamage());
		JsonArray enchantments = new JsonArray();
		for (var entry : stack.getOrDefault(DataComponents.ENCHANTMENTS, ItemEnchantments.EMPTY).entrySet()) {
			enchantments.add(entry.getKey().unwrapKey().orElseThrow().identifier() + " " + entry.getIntValue());
		}
		tool.add("enchantments", enchantments);
		tool.addProperty("repairCost", stack.getOrDefault(DataComponents.REPAIR_COST, 0));
		JsonArray repairWith = new JsonArray();
		Repairable repairable = stack.get(DataComponents.REPAIRABLE);
		if (repairable != null) {
			for (var item : repairable.items()) {
				repairWith.add(BuiltInRegistries.ITEM.getKey(item.value()).toString());
			}
		}
		tool.add("repairWith", repairWith);
		return tool;
	}

	private static JsonObject anvilState() {
		Minecraft client = Minecraft.getInstance();
		JsonObject state = Qc.obj();
		state.addProperty("open", false);
		state.addProperty("cost", 0);
		state.add("result", JsonNull.INSTANCE);
		if (client.player != null && client.player.containerMenu instanceof AnvilMenu anvil) {
			state.addProperty("open", true);
			state.addProperty("cost", anvil.getCost());
			ItemStack stack = anvil.getSlot(AnvilMenu.RESULT_SLOT).getItem();
			if (!stack.isEmpty()) {
				JsonObject result = Qc.obj();
				result.addProperty("id", BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
				result.addProperty("damage", stack.getDamageValue());
				state.add("result", result);
			}
		}
		return state;
	}
}
