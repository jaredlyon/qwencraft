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
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
	}
}
