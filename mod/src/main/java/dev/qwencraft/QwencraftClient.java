package dev.qwencraft;

import dev.qwencraft.baritone.BaritoneFeature;
import dev.qwencraft.control.ControlFeature;
import dev.qwencraft.guards.GuardsFeature;
import dev.qwencraft.inventory.InventoryFeature;
import net.fabricmc.api.ClientModInitializer;

/** Client entrypoint. Fabric runs every "main" entrypoint (incl. MCPFabric's, which creates the router) before this. */
public final class QwencraftClient implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		QcState.registerRpcs();
		BaritoneFeature.init();
		GuardsFeature.init();
		ControlFeature.init();
		InventoryFeature.init();
		Qc.LOG.info("qwencraft initialized");
	}
}
