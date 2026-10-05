package dev.qwencraft.guards.mixin;

import dev.qwencraft.guards.GuardsFeature;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.MultiPlayerGameMode;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(MultiPlayerGameMode.class)
public abstract class MultiPlayerGameModeMixin {
	@Shadow @Final private Minecraft minecraft;
	@Shadow public abstract void stopDestroyBlock();

	@Inject(method = {
			"startDestroyBlock(Lnet/minecraft/core/BlockPos;Lnet/minecraft/core/Direction;)Z",
			"continueDestroyBlock(Lnet/minecraft/core/BlockPos;Lnet/minecraft/core/Direction;)Z"
	}, at = @At("HEAD"), cancellable = true)
	private void qc_guardMining(BlockPos pos, Direction direction, CallbackInfoReturnable<Boolean> result) {
		if (!GuardsFeature.mayBreak(pos)) {
			// Abort an in-progress break as well: a config change cannot leave stale crack/progress state.
			if (minecraft.level != null && minecraft.player != null) stopDestroyBlock();
			result.setReturnValue(false);
		}
	}

	@Inject(method = "destroyBlock(Lnet/minecraft/core/BlockPos;)Z", at = @At("HEAD"), cancellable = true)
	private void qc_guardDirectDestruction(BlockPos pos, CallbackInfoReturnable<Boolean> result) {
		if (!GuardsFeature.mayBreak(pos)) result.setReturnValue(false);
	}
}
