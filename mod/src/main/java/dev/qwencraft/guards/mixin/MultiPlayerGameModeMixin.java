package dev.qwencraft.guards.mixin;

import dev.qwencraft.QcState;
import dev.qwencraft.guards.GuardsFeature;
import dev.qwencraft.guards.PlacedBlocks;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.MultiPlayerGameMode;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.item.context.BlockPlaceContext;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(MultiPlayerGameMode.class)
public abstract class MultiPlayerGameModeMixin {
	@Shadow @Final private Minecraft minecraft;
	@Shadow public abstract void stopDestroyBlock();
	@Unique private BlockPos qc_placementPos;
	@Unique private BlockState qc_placementPrior;

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

	@Inject(method = "destroyBlock(Lnet/minecraft/core/BlockPos;)Z", at = @At("RETURN"))
	private void qc_removeBrokenPlacement(BlockPos pos, CallbackInfoReturnable<Boolean> result) {
		if (Boolean.TRUE.equals(result.getReturnValue())) PlacedBlocks.broken(pos);
	}

	@Inject(method = "useItemOn", at = @At("HEAD"))
	private void qc_capturePlacement(LocalPlayer player, InteractionHand hand, BlockHitResult hit, CallbackInfoReturnable<InteractionResult> result) {
		qc_placementPos = null;
		qc_placementPrior = null;
		if (QcState.paused() || minecraft.level == null) return;
		// Vanilla's context also handles replaceable slabs/snow with the held item and hit face.
		qc_placementPos = new BlockPlaceContext(player, hand, player.getItemInHand(hand), hit).getClickedPos().immutable();
		qc_placementPrior = minecraft.level.getBlockState(qc_placementPos);
	}

	@Inject(method = "useItemOn", at = @At("RETURN"))
	private void qc_recordPlacement(LocalPlayer player, InteractionHand hand, BlockHitResult hit, CallbackInfoReturnable<InteractionResult> result) {
		BlockPos pos = qc_placementPos;
		BlockState prior = qc_placementPrior;
		qc_placementPos = null;
		qc_placementPrior = null;
		if (pos == null || QcState.paused() || minecraft.level == null || !result.getReturnValue().consumesAction()) return;
		BlockState current = minecraft.level.getBlockState(pos);
		if (!current.isAir() && !current.equals(prior)) PlacedBlocks.placed(pos);
	}
}
