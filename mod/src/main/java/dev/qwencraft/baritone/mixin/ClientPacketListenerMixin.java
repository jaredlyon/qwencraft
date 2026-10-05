package dev.qwencraft.baritone.mixin;

import dev.qwencraft.baritone.BaritoneFeature;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.network.protocol.game.ClientboundPlayerCombatKillPacket;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ClientPacketListener.class)
public abstract class ClientPacketListenerMixin {
	@Inject(method = "handlePlayerCombatKill", at = @At("TAIL"))
	private void qwencraft$death(ClientboundPlayerCombatKillPacket packet, CallbackInfo ci) {
		BaritoneFeature.deathPacket(packet.playerId(), packet.message());
	}
}
