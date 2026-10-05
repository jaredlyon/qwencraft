package dev.qwencraft.guards.mixin;

import dev.qwencraft.guards.GuardsFeature;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.multiplayer.ClientPacketListener;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

// Lower priority applies later and prepends HEAD hooks before Fabric (800) and Baritone (1000).
@Mixin(value = ClientPacketListener.class, priority = 700)
public abstract class ClientPacketListenerMixin {
	@Inject(method = "sendChat(Ljava/lang/String;)V", at = @At("HEAD"), cancellable = true)
	private void qc_guardChat(String text, CallbackInfo result) {
		if (!GuardsFeature.allowOutgoing(text, false)) result.cancel();
	}

	@Inject(method = "sendCommand(Ljava/lang/String;)V", at = @At("HEAD"), cancellable = true)
	private void qc_guardCommand(String command, CallbackInfo result) {
		if (!GuardsFeature.allowOutgoing(command, true)) result.cancel();
	}

	@Inject(method = "sendChat(Ljava/lang/String;)V", at = @At(value = "INVOKE",
			target = "Lnet/minecraft/client/multiplayer/ClientPacketListener;send(Lnet/minecraft/network/protocol/Packet;)V", shift = At.Shift.AFTER))
	private void qc_recordChat(String text, CallbackInfo result) {
		GuardsFeature.outgoingSent(text, false);
	}

	// Both unsigned and argument-signed command branches transmit exactly once.
	@Inject(method = "sendCommand(Ljava/lang/String;)V", require = 2, at = @At(value = "INVOKE",
			target = "Lnet/minecraft/client/multiplayer/ClientPacketListener;send(Lnet/minecraft/network/protocol/Packet;)V", shift = At.Shift.AFTER))
	private void qc_recordCommand(String command, CallbackInfo result) {
		GuardsFeature.outgoingSent(command, true);
	}

	// Clickable server text can use the unattended path or its delayed confirmation instead of sendCommand.
	// Check at transmission so a confirmation cannot retain stale permission/rate-limit reservations.
	@Inject(method = {
			"sendUnattendedCommand(Ljava/lang/String;Lnet/minecraft/client/gui/screens/Screen;)V",
			"lambda$openCommandSendConfirmationWindow$0(Ljava/lang/String;Lnet/minecraft/client/gui/screens/Screen;)V"
	}, require = 2, at = @At(value = "INVOKE",
			target = "Lnet/minecraft/client/multiplayer/ClientPacketListener;send(Lnet/minecraft/network/protocol/Packet;)V"), cancellable = true)
	private void qc_guardUnattendedCommand(String command, Screen screen, CallbackInfo result) {
		if (!GuardsFeature.allowOutgoing(command, true)) result.cancel();
	}

	@Inject(method = {
			"sendUnattendedCommand(Ljava/lang/String;Lnet/minecraft/client/gui/screens/Screen;)V",
			"lambda$openCommandSendConfirmationWindow$0(Ljava/lang/String;Lnet/minecraft/client/gui/screens/Screen;)V"
	}, require = 2, at = @At(value = "INVOKE",
			target = "Lnet/minecraft/client/multiplayer/ClientPacketListener;send(Lnet/minecraft/network/protocol/Packet;)V", shift = At.Shift.AFTER))
	private void qc_recordUnattendedCommand(String command, Screen screen, CallbackInfo result) {
		GuardsFeature.outgoingSent(command, true);
	}
}
