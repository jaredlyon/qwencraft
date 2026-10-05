package dev.qwencraft.control.mixin;

import dev.mcpfabric.client.BotController;
import dev.qwencraft.control.ControlFeature;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(value = BotController.class, remap = false)
abstract class BotControllerMixin {
	@Inject(method = {"setMovement", "jumpOnce", "startMining", "startNavigation"}, at = @At("HEAD"), cancellable = true)
	private void qwencraft$rejectPausedWork(CallbackInfo ci) {
		if (ControlFeature.agentWorkBlocked()) ci.cancel();
	}
}
