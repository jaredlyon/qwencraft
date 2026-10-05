package dev.qwencraft.control;

/** Pure stop/lease predicates. Run directly with Java 25: java --source 25 ControlRules.java. */
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
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
	}
}
