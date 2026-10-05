package dev.qwencraft.baritone;

import baritone.api.event.events.PathEvent;
import dev.mcpfabric.bridge.RpcException;

/** Run with -ea on the mod's runtime classpath; no game instance is needed. */
public final class BaritoneContractCheck {
	private BaritoneContractCheck() {}

	public static void main(String[] args) throws RpcException {
		assert BaritoneFeature.coordinate(3.9, "x") == 3;
		assert BaritoneFeature.coordinate(-0.1, "x") == -1;
		assert BaritoneFeature.coordinate(Integer.MIN_VALUE, "x") == Integer.MIN_VALUE;
		for (double bad : new double[] {Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY,
				(double)Integer.MAX_VALUE + 1, (double)Integer.MIN_VALUE - 1}) {
			try {
				BaritoneFeature.coordinate(bad, "x");
				throw new AssertionError("Accepted invalid coordinate: " + bad);
			} catch (RpcException expected) {
				assert expected.code().equals(RpcException.badRequest("").code());
			}
		}
		assert "at_goal".equals(BaritoneFeature.pathState(PathEvent.AT_GOAL));
		assert "calc_failed".equals(BaritoneFeature.pathState(PathEvent.CALC_FAILED));
		assert "calc_failed".equals(BaritoneFeature.pathState(PathEvent.NEXT_CALC_FAILED));
		assert "canceled".equals(BaritoneFeature.pathState(PathEvent.CANCELED));
		assert BaritoneFeature.pathState(PathEvent.CALC_STARTED) == null;
	}
}
