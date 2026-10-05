package dev.qwencraft.control;

/** Pure control predicates. Run directly with Java 25: java --source 25 ControlRules.java. */
final class ControlRules {
	private ControlRules() {}

	static long remainingLeaseMs(long ttlMs, long elapsedNanos) {
		return Math.max(0, ttlMs - Math.max(0, elapsedNanos / 1_000_000));
	}

	static boolean ordinaryWorkBlocked(boolean ownedInput, boolean paused, boolean reflex) {
		return !ownedInput && (paused || reflex);
	}

	static boolean gameplayBlocked(boolean ownedInput, boolean paused, boolean human, boolean reflex) {
		return !ownedInput && ((paused && !human) || reflex);
	}

	static boolean shouldFleeCreeper(double distanceSquared, double previousDistanceSquared, float swelling, int swellDirection) {
		return distanceSquared <= 25 && (swelling > 0 || swellDirection > 0 || distanceSquared < previousDistanceSquared);
	}

	static boolean continueFleeCreeper(boolean present, double distanceSquared, long elapsedNanos) {
		return present && distanceSquared < 64 && elapsedNanos < 5_000_000_000L;
	}

	/** Air (ticks, max 300) at which swimming up starts; ~7.5 s of air left, enough to surface from deep water. */
	static final int LOW_AIR = 150;

	/**
	 * Swim up only when air is genuinely low, then keep going until air is full again. Triggering on any lost
	 * bubble made the reflex fire every second while digging through a lake and cancel all work.
	 */
	static boolean drowning(boolean eyeInWater, int air, int maxAir, boolean alreadyEscaping) {
		return eyeInWater && (air < LOW_AIR || (alreadyEscaping && air < maxAir));
	}

	/** Engage hostile mobs within 6 blocks and a player who hit us within 8 blocks, for 15 s after their last hit. */
	static final double MOB_ENGAGE_SQ = 36, PLAYER_ENGAGE_SQ = 64;
	/**
	 * Ranged attackers (skeletons, pillagers, witches, trident drowned) are hunted iff they can land a shot: within 15
	 * blocks (the skeleton bow range, RangedBowAttackGoal radius 15) and with line of sight to the agent.
	 */
	static final double RANGED_ENGAGE_SQ = 225;

	static boolean huntRanged(double distanceSquared, boolean mobSeesAgent) {
		return mobSeesAgent && distanceSquared <= RANGED_ENGAGE_SQ;
	}
	/** Melee mobs hit from ~1.4 blocks, we hit from 3: back off inside this distance while the swing recharges. */
	static final double BACKOFF_DISTANCE = 2.6;

	enum CombatMove { FORWARD, BACK, HOLD }

	static CombatMove combatMove(boolean inReach, boolean swingReady, boolean rangedTarget, double distance) {
		if (!inReach) return CombatMove.FORWARD;
		if (!swingReady && !rangedTarget && distance < BACKOFF_DISTANCE) return CombatMove.BACK;
		return CombatMove.HOLD;
	}
	static final long RETALIATE_NANOS = 15_000_000_000L;
	/** Hotbar index reserved for the best sword (the rightmost slot). */
	static final int SWORD_HOTBAR = 8;

	/**
	 * Strike-first targets: hostile mobs, except creepers (the flee reflex owns them) and mobs that are neutral until
	 * provoked (endermen, zombified piglins, piglins), which are hit only once they are aggressive: hitting a calm
	 * zombified piglin turns the whole group on the agent.
	 */
	static boolean shouldTargetMob(boolean enemy, boolean neutralUntilProvoked, boolean creeper, boolean aggressive) {
		if (creeper) return false;
		return neutralUntilProvoked ? aggressive : enemy;
	}

	static boolean retaliating(long nowNanos, long lastHitNanos, boolean hasAggressor) {
		return hasAggressor && nowNanos - lastHitNanos < RETALIATE_NANOS;
	}

	static int swordRank(String itemId) {
		return switch (itemId) {
			case "minecraft:netherite_sword" -> 5;
			case "minecraft:diamond_sword" -> 4;
			case "minecraft:iron_sword" -> 3;
			case "minecraft:stone_sword", "minecraft:copper_sword" -> 2;
			case "minecraft:golden_sword", "minecraft:wooden_sword" -> 1;
			default -> 0;
		};
	}

	public static void main(String[] args) {
		check(remainingLeaseMs(3000, 0) == 3000, "fresh lease");
		check(remainingLeaseMs(3000, 2_999_000_000L) == 1, "lease before deadline");
		check(remainingLeaseMs(3000, 3_000_000_000L) == 0, "deadline expires");
		check(remainingLeaseMs(3000, 9_000_000_000L) == 0, "nonnegative expired lease");
		for (boolean paused : new boolean[] {false, true}) for (boolean reflex : new boolean[] {false, true}) {
			check(!ordinaryWorkBlocked(true, paused, reflex), "owned reflex lane");
			check(ordinaryWorkBlocked(false, paused, reflex) == (paused || reflex), "stale work gate");
		}
		check(gameplayBlocked(false, true, false, false), "console/lease action gate");
		check(!gameplayBlocked(false, true, true, false), "human handoff remains playable");
		check(gameplayBlocked(false, false, false, true), "reflex exclusive ownership");
		check(!gameplayBlocked(true, true, false, true), "survival under console/lease pause");
		check(shouldFleeCreeper(25, 25, 0.1F, -1), "swelling at five blocks");
		check(shouldFleeCreeper(25, 25, 0, 1), "positive swell direction before swelling");
		check(shouldFleeCreeper(24, 25, 0, -1), "approaching creeper");
		check(!shouldFleeCreeper(25, 25, 0, -1), "stationary unprimed creeper");
		check(!shouldFleeCreeper(25, 24, 0, -1), "receding unprimed creeper");
		check(!shouldFleeCreeper(25.01, 30, 1, 1), "outside trigger radius");
		check(continueFleeCreeper(true, 63.99, 4_999_999_999L), "flee until safe or deadline");
		check(!continueFleeCreeper(true, 64, 0), "release at eight blocks");
		check(!continueFleeCreeper(false, 1, 0), "release when creeper is gone");
		check(!continueFleeCreeper(true, 1, 5_000_000_000L), "release after five seconds");
		check(!drowning(true, 298, 300, false), "one lost bubble is not drowning");
		check(drowning(true, 149, 300, false), "low air starts the swim up");
		check(drowning(true, 299, 300, true), "keep swimming until air is full");
		check(!drowning(true, 300, 300, true), "full air ends the escape");
		check(!drowning(false, 10, 300, false), "head above water is not drowning");
		check(shouldTargetMob(true, false, false, false), "hostile mob is hit before it attacks");
		check(!shouldTargetMob(true, false, true, true), "creepers are left to the flee reflex");
		check(!shouldTargetMob(true, true, false, false), "calm zombified piglin/enderman is not provoked");
		check(shouldTargetMob(true, true, false, true), "aggressive neutral mob is hit");
		check(!shouldTargetMob(false, false, false, true), "passive animals are never targeted");
		check(retaliating(14_999_999_999L, 0, true), "retaliate within fifteen seconds of the last hit");
		check(!retaliating(15_000_000_000L, 0, true), "stop retaliating fifteen seconds after the last hit");
		check(!retaliating(1, 0, false), "no aggressor, no retaliation");
		check(swordRank("minecraft:diamond_sword") > swordRank("minecraft:iron_sword"), "diamond beats iron");
		check(swordRank("minecraft:netherite_sword") > swordRank("minecraft:diamond_sword"), "netherite beats diamond");
		check(combatMove(false, true, false, 5) == CombatMove.FORWARD, "close the distance when out of reach");
		check(combatMove(true, false, false, 1.8) == CombatMove.BACK, "back off a close melee mob while recharging");
		check(combatMove(true, true, false, 1.8) == CombatMove.HOLD, "stand and strike when the swing is ready");
		check(combatMove(true, false, false, 2.9) == CombatMove.HOLD, "hold at the edge of reach");
		check(combatMove(true, false, true, 1.8) == CombatMove.HOLD, "stay on a ranged mob instead of backing into its fire");
		check(huntRanged(14.9 * 14.9, true), "hunt a skeleton that can shoot us");
		check(!huntRanged(14.9 * 14.9, false), "ignore a skeleton without line of sight");
		check(!huntRanged(15.1 * 15.1, true), "ignore a skeleton beyond bow range");
		check(swordRank("minecraft:diamond_pickaxe") == 0, "pickaxes are not swords");
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
	}
}
