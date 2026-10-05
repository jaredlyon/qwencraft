package dev.qwencraft.control;

import com.google.gson.JsonObject;
import dev.qwencraft.Qc;
import dev.qwencraft.QcState;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.component.DataComponents;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.monster.Creeper;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

/** One owner, with escape > creeper flight > retaliation > eating. Completion releases rather than revives work. */
final class Reflexes {
	private enum Mode { NONE, ESCAPE, FLEE_CREEPER, FIGHT, EAT }
	private static Mode mode = Mode.NONE;
	private static LocalPlayer owner;
	private static boolean forward, jump;
	private static BlockPos escapeTarget;
	private static int nextEscapeScan;
	private static Creeper fleeTarget;
	private static long fleeStartedAt;
	private static int previousSlot = -1, foodSlot = -1, swappedFrom = -1;
	private static Item foodItem;
	private static int initialCount, initialFood, startedTick;

	private Reflexes() {}

	static boolean active() { return mode != Mode.NONE; }

	static void tick(Minecraft mc) {
		LocalPlayer p = mc.player;
		if (!QcState.reflex.enabled() || ControlFeature.humanPaused() || p == null || mc.level == null
				|| mc.gameMode == null || !p.isAlive() || p.isSpectator() || mc.gui.screen() != null) {
			finish(mc, p != null && mc.gameMode != null);
			return;
		}
		if (owner != null && owner != p) finish(mc, false);
		boolean drowning = ControlRules.drowning(p.isEyeInFluid(FluidTags.WATER), p.getAirSupply(), p.getMaxAirSupply(), mode == Mode.ESCAPE);
		if (p.isInLava() || p.isOnFire() || drowning) {
			begin(mc, Mode.ESCAPE, drowning ? "swim up" : "jump toward locally safe ground");
			forward = false;
			jump = true;
			if (!drowning) {
				if (escapeTarget == null || p.tickCount >= nextEscapeScan || p.blockPosition().equals(escapeTarget)) {
					escapeTarget = chooseEscape(mc, p);
					nextEscapeScan = p.tickCount + 10;
				}
				if (escapeTarget != null) {
					lookAt(p, escapeTarget.getX() + 0.5, p.getEyeY(), escapeTarget.getZ() + 0.5);
					forward = true;
				}
			}
			applyMovement(mc);
			return;
		}

		if (mode == Mode.FLEE_CREEPER) {
			if (!ControlRules.continueFleeCreeper(fleeTarget != null && fleeTarget.isAlive()
					&& mc.level.getEntity(fleeTarget.getId()) == fleeTarget,
					fleeTarget == null ? 0 : p.distanceToSqr(fleeTarget), System.nanoTime() - fleeStartedAt)) {
				finish(mc, true);
				return;
			}
		} else {
			Creeper threat = findCreeper(mc, p);
			if (threat != null) {
				begin(mc, Mode.FLEE_CREEPER, "sprinting away");
				fleeTarget = threat;
				fleeStartedAt = System.nanoTime();
			}
		}
		if (mode == Mode.FLEE_CREEPER) {
			// Keep the current heading only when both entities have exactly the same horizontal position.
			if (p.getX() != fleeTarget.getX() || p.getZ() != fleeTarget.getZ())
				lookAt(p, 2 * p.getX() - fleeTarget.getX(), p.getEyeY(), 2 * p.getZ() - fleeTarget.getZ());
			else p.setXRot(0);
			forward = true;
			jump = p.horizontalCollision;
			applyMovement(mc);
			return;
		}

		DamageSource damage = p.getLastDamageSource(40);
		LivingEntity attacker = damage != null && damage.getEntity() instanceof LivingEntity living && living instanceof Enemy ? living : null;
		if (attacker != null && attacker.isAlive() && p.hasLineOfSight(attacker)
				&& p.isWithinEntityInteractionRange(attacker, 0)
				&& p.isWithinAttackRange(p.getMainHandItem(), attacker.getBoundingBox(), 0)) {
			begin(mc, Mode.FIGHT, "retaliate against " + attacker.getType().getDescriptionId());
			forward = jump = false;
			applyMovement(mc);
			lookAt(p, attacker.getX(), attacker.getEyeY(), attacker.getZ());
			if (p.getAttackStrengthScale(0) >= 0.95F && !p.cannotAttackWithItem(p.getMainHandItem(), 0)) {
				ControlFeature.input(() -> {
					mc.gameMode.attack(p, attacker);
					p.swing(InteractionHand.MAIN_HAND, p.getMainHandItem().getAttackAnimation(), false);
				});
			}
			return;
		}
		if (mode == Mode.ESCAPE || mode == Mode.FIGHT) finish(mc, true);
		if (mode == Mode.EAT) {
			ItemStack held = p.getMainHandItem();
			if (p.getFoodData().getFoodLevel() > initialFood || held.getCount() < initialCount || held.getItem() != foodItem
					|| !p.isUsingItem() || p.tickCount - startedTick > 100) {
				finish(mc, true);
			} else applyMovement(mc);
			return;
		}
		if (p.getFoodData().getFoodLevel() > QcState.reflex.eatAtFood() || !p.canEat(false)) return;
		int slot = findFood(p);
		if (slot < 0 || p.containerMenu != p.inventoryMenu || !p.containerMenu.getCarried().isEmpty()) return;
		begin(mc, Mode.EAT, "select and consume food");
		previousSlot = p.getInventory().getSelectedSlot();
		foodSlot = slot < 9 ? slot : previousSlot;
		if (slot >= 9) {
			swappedFrom = slot;
			ControlFeature.input(() -> mc.gameMode.handleContainerInput(p.inventoryMenu.containerId, slot, foodSlot, ContainerInput.SWAP, p));
		}
		p.getInventory().setSelectedSlot(foodSlot);
		foodItem = p.getMainHandItem().getItem();
		initialCount = p.getMainHandItem().getCount();
		initialFood = p.getFoodData().getFoodLevel();
		startedTick = p.tickCount;
		ControlFeature.input(() -> {
			mc.options.keyUse.setDown(true);
			mc.gameMode.useItem(p, InteractionHand.MAIN_HAND);
		});
		if (!p.isUsingItem()) finish(mc, true);
	}

	private static Creeper findCreeper(Minecraft mc, LocalPlayer p) {
		Creeper nearest = null;
		double nearestDistance = Double.POSITIVE_INFINITY;
		for (var entity : mc.level.entitiesForRendering()) {
			if (!(entity instanceof Creeper creeper) || !creeper.isAlive()) continue;
			double distance = p.distanceToSqr(creeper);
			if (distance >= nearestDistance || distance > 25) continue;
			double dx = p.xOld - creeper.xOld, dy = p.yOld - creeper.yOld, dz = p.zOld - creeper.zOld;
			if (ControlRules.shouldFleeCreeper(distance, dx * dx + dy * dy + dz * dz, creeper.getSwelling(1), creeper.getSwellDir())) {
				nearest = creeper;
				nearestDistance = distance;
			}
		}
		return nearest;
	}

	private static int findFood(LocalPlayer player) {
		for (int slot = 0; slot < 36; slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (!stack.isEmpty() && stack.has(DataComponents.FOOD) && stack.has(DataComponents.CONSUMABLE)) return slot;
		}
		return -1;
	}

	private static void begin(Minecraft mc, Mode next, String action) {
		if (mode == next) return;
		finish(mc, true);
		ControlFeature.stopOrdinaryWork("reflex");
		mode = next;
		owner = mc.player;
		JsonObject event = Qc.obj();
		event.addProperty("name", next.name().toLowerCase(java.util.Locale.ROOT));
		event.addProperty("action", action);
		Qc.emit("qc.reflex", event);
	}

	static void applyMovement(Minecraft mc) {
		if (!active() || mc.player != owner || ControlFeature.humanPaused()) return;
		// A controller RPC may have installed a new process since the previous tick.
		ControlFeature.cancelBaritone();
		ControlFeature.input(() -> {
			mc.options.keyUp.setDown(forward);
			mc.options.keyDown.setDown(false);
			mc.options.keyLeft.setDown(false);
			mc.options.keyRight.setDown(false);
			mc.options.keyJump.setDown(jump);
			mc.options.keyShift.setDown(false);
			mc.options.keySprint.setDown(mode == Mode.FLEE_CREEPER);
			mc.options.keyAttack.setDown(false);
			mc.options.keyUse.setDown(mode == Mode.EAT);
		});
	}

	static void finish(Minecraft mc, boolean connected) {
		if (!active()) return;
		LocalPlayer p = owner;
		if (p != null && p == mc.player) {
			if (mode == Mode.EAT) {
				if (connected && mc.gameMode != null) {
					mc.gameMode.releaseUsingItem(p);
					if (swappedFrom >= 0 && p.containerMenu == p.inventoryMenu) {
						ControlFeature.input(() -> mc.gameMode.handleContainerInput(p.inventoryMenu.containerId,
								swappedFrom, foodSlot, ContainerInput.SWAP, p));
					}
				} else p.stopUsingItem();
				if (previousSlot >= 0) p.getInventory().setSelectedSlot(previousSlot);
			}
		}
		mode = Mode.NONE;
		owner = null;
		forward = jump = false;
		escapeTarget = null;
		fleeTarget = null;
		fleeStartedAt = 0;
		previousSlot = foodSlot = swappedFrom = -1;
		foodItem = null;
		ControlFeature.releaseKeys();
	}

	private static void lookAt(LocalPlayer p, double x, double y, double z) {
		double dx = x - p.getX(), dy = y - p.getEyeY(), dz = z - p.getZ();
		p.setYRot((float) Math.toDegrees(Math.atan2(dz, dx)) - 90);
		p.setXRot((float) -Math.toDegrees(Math.atan2(dy, Math.hypot(dx, dz))));
		p.setYHeadRot(p.getYRot());
	}

	/** Local, loaded-cell escape only; never tunnels, breaks, places, or claims a pathfinding guarantee. */
	private static BlockPos chooseEscape(Minecraft mc, LocalPlayer p) {
		BlockPos base = p.blockPosition();
		BlockPos.MutableBlockPos feet = new BlockPos.MutableBlockPos();
		BlockPos.MutableBlockPos head = new BlockPos.MutableBlockPos();
		BlockPos.MutableBlockPos floor = new BlockPos.MutableBlockPos();
		BlockPos.MutableBlockPos step = new BlockPos.MutableBlockPos();
		int bestX = 0, bestY = 0, bestZ = 0;
		double bestScore = Double.MAX_VALUE;
		for (int y = 0; y <= 1; y++) for (int x = -4; x <= 4; x++) for (int z = -4; z <= 4; z++) {
			if (x == 0 && z == 0) continue;
			feet.set(base.getX() + x, base.getY() + y, base.getZ() + z);
			head.set(feet.getX(), feet.getY() + 1, feet.getZ());
			floor.set(feet.getX(), feet.getY() - 1, feet.getZ());
			if (!mc.level.hasChunkAt(feet)) continue;
			BlockState f = mc.level.getBlockState(feet), h = mc.level.getBlockState(head), below = mc.level.getBlockState(floor);
			if (hazard(f) || hazard(h) || hazard(below) || !f.getCollisionShape(mc.level, feet).isEmpty()
					|| !h.getCollisionShape(mc.level, head).isEmpty()
					|| (!below.isCollisionShapeFullBlock(mc.level, floor) && !f.getFluidState().is(FluidTags.WATER))) continue;
			// Check intervening space and support; current lava is allowed only as the escape's origin.
			if (!clearRoute(mc, base, feet, head, floor, step, p.isInLava())) continue;
			double score = x * x + z * z + y * y * 2;
			if (p.isOnFire() && f.getFluidState().is(FluidTags.WATER)) score -= 40;
			if (score < bestScore) {
				bestX = feet.getX(); bestY = feet.getY(); bestZ = feet.getZ(); bestScore = score;
			}
		}
		return bestScore == Double.MAX_VALUE ? null : new BlockPos(bestX, bestY, bestZ);
	}

	private static boolean clearRoute(Minecraft mc, BlockPos origin, BlockPos target,
			BlockPos.MutableBlockPos head, BlockPos.MutableBlockPos floor, BlockPos.MutableBlockPos step, boolean leavingLava) {
		int dx = target.getX() - origin.getX(), dz = target.getZ() - origin.getZ();
		int steps = Math.max(Math.abs(dx), Math.abs(dz));
		for (int i = 1; i < steps; i++) {
			step.set(origin.getX() + (int) Math.round((double) dx * i / steps), target.getY(),
					origin.getZ() + (int) Math.round((double) dz * i / steps));
			head.set(step.getX(), step.getY() + 1, step.getZ());
			floor.set(step.getX(), step.getY() - 1, step.getZ());
			if (!mc.level.hasChunkAt(step)) return false;
			BlockState f = mc.level.getBlockState(step), h = mc.level.getBlockState(head), below = mc.level.getBlockState(floor);
			if (!f.getCollisionShape(mc.level, step).isEmpty() || !h.getCollisionShape(mc.level, head).isEmpty() || hazard(h)) return false;
			boolean lava = f.getFluidState().is(FluidTags.LAVA) || below.getFluidState().is(FluidTags.LAVA);
			if (lava && !leavingLava) return false;
			if (!lava) leavingLava = false;
			if (!lava && (hazard(f) || hazard(below) || (!below.isCollisionShapeFullBlock(mc.level, floor)
					&& !f.getFluidState().is(FluidTags.WATER)))) return false;
		}
		return true;
	}

	private static boolean hazard(BlockState state) {
		return state.getFluidState().is(FluidTags.LAVA) || state.is(Blocks.FIRE) || state.is(Blocks.SOUL_FIRE)
				|| state.is(Blocks.MAGMA_BLOCK) || state.is(Blocks.CAMPFIRE) || state.is(Blocks.SOUL_CAMPFIRE)
				|| state.is(Blocks.CACTUS) || state.is(Blocks.SWEET_BERRY_BUSH);
	}
}
