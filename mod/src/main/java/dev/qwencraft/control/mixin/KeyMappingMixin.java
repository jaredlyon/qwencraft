package dev.qwencraft.control.mixin;

import dev.qwencraft.control.ControlFeature;
import net.minecraft.client.KeyMapping;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.ModifyVariable;

@Mixin(KeyMapping.class)
abstract class KeyMappingMixin {
	@ModifyVariable(method = "setDown", at = @At("HEAD"), argsOnly = true)
	private boolean qwencraft$pauseSyntheticInput(boolean down) {
		return ControlFeature.filterKeyState((KeyMapping) (Object) this, down);
	}
}
