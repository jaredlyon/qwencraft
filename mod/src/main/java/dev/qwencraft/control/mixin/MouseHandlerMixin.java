package dev.qwencraft.control.mixin;

import dev.qwencraft.control.ControlFeature;
import net.minecraft.client.MouseHandler;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(MouseHandler.class)
abstract class MouseHandlerMixin {
	@Shadow private boolean ignoreFirstMove;
	@Shadow private boolean mouseGrabbed;

	// SDL relative motion, not LocalPlayer rotations used by MCPFabric or Baritone.
	@Inject(method = "onMove", at = @At("HEAD"))
	private void qwencraft$physicalLook(long handle, double x, double y, double dx, double dy, CallbackInfo ci) {
		if (!ignoreFirstMove && mouseGrabbed && handle == net.minecraft.client.Minecraft.getInstance().getWindow().handle()
				&& (dx != 0 || dy != 0)) ControlFeature.onPhysicalMouseMove();
	}
}
