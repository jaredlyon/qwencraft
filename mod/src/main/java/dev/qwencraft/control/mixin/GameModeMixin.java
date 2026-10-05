package dev.qwencraft.control.mixin;

import dev.qwencraft.control.ControlFeature;
import net.minecraft.client.multiplayer.MultiPlayerGameMode;
import net.minecraft.world.InteractionResult;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(MultiPlayerGameMode.class)
abstract class GameModeMixin {
	@Inject(method = {"startDestroyBlock", "continueDestroyBlock", "destroyBlock"}, at = @At("HEAD"), cancellable = true)
	private void qwencraft$pauseBreaking(CallbackInfoReturnable<Boolean> cir) {
		if (ControlFeature.gameplayBlocked()) cir.setReturnValue(false);
	}

	@Inject(method = {"useItem", "useItemOn", "interact"}, at = @At("HEAD"), cancellable = true)
	private void qwencraft$pauseInteraction(CallbackInfoReturnable<InteractionResult> cir) {
		if (ControlFeature.gameplayBlocked()) cir.setReturnValue(InteractionResult.PASS);
	}

	@Inject(method = {"attack", "piercingAttack", "handleContainerInput"}, at = @At("HEAD"), cancellable = true)
	private void qwencraft$pauseAction(CallbackInfo ci) {
		if (ControlFeature.gameplayBlocked()) ci.cancel();
	}
}
