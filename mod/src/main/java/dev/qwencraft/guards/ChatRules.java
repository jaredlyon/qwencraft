package dev.qwencraft.guards;

import java.util.List;
import java.util.regex.Pattern;

/** Text-only policy; no rendered name or echo establishes authenticated identity. */
final class ChatRules {
	private static final int CASE_FLAGS = Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE | Pattern.UNICODE_CHARACTER_CLASS;
	private static final Pattern USERNAME = Pattern.compile("[A-Za-z0-9_]{1,16}");
	private static final List<Pattern> WHISPERS = List.of(
			Pattern.compile("^(?:<([A-Za-z0-9_]{1,16})>|([A-Za-z0-9_]{1,16})) whispers to you: .*$", CASE_FLAGS),
			Pattern.compile("^\\[([A-Za-z0-9_]{1,16}) -> me\\] .*$", CASE_FLAGS),
			Pattern.compile("^From ([A-Za-z0-9_]{1,16}): .*$", CASE_FLAGS));
	private static final Pattern PUBLIC_ECHO = Pattern.compile("^<([^>]+)> (.*)$");
	private static final List<Pattern> PRIVATE_ECHO = List.of(
			Pattern.compile("^You whisper to ([A-Za-z0-9_]{1,16}): (.*)$", CASE_FLAGS),
			Pattern.compile("^\\[me -> ([A-Za-z0-9_]{1,16})\\] (.*)$", CASE_FLAGS),
			Pattern.compile("^To ([A-Za-z0-9_]{1,16}): (.*)$", CASE_FLAGS));
	private static final Pattern TOKENS = Pattern.compile("\\s+");

	private ChatRules() {}

	static String rejection(String text, int maxLen, List<String> commands) {
		// Java and TypeScript both count UTF-16 code units, as does Minecraft's Utf8String codec.
		if (text.length() > Math.min(256, maxLen)) return "too_long";
		if (text.startsWith("#")) return "command_not_allowed";
		if (text.startsWith("/") && !commands.contains(firstToken(text))) return "command_not_allowed";
		return null;
	}

	private static String firstToken(String text) {
		int end = 0;
		while (end < text.length() && !Character.isWhitespace(text.charAt(end))) end++;
		return text.substring(0, end);
	}

	static List<Pattern> mentions(List<String> names, List<String> words) {
		return java.util.stream.Stream.concat(
				names.stream().filter(s -> !s.isEmpty()).map(s -> Pattern.compile(Pattern.quote(s), CASE_FLAGS)),
				words.stream().filter(s -> !s.isEmpty()).map(s -> Pattern.compile("\\b" + Pattern.quote(s) + "\\b", CASE_FLAGS)))
				.toList();
	}

	static boolean mentions(String text, List<Pattern> patterns) {
		for (Pattern pattern : patterns) if (pattern.matcher(text).find()) return true;
		return false;
	}

	static String username(String name) {
		return USERNAME.matcher(name).matches() ? name : null;
	}

	static String whisperSender(String text) {
		for (Pattern pattern : WHISPERS) {
			var match = pattern.matcher(text);
			if (match.matches()) return match.group(1) != null ? match.group(1) : match.group(2);
		}
		return null;
	}

	record Sent(String text, String body, String recipient, boolean privateMessage) {
		static Sent of(String text) {
			String[] parts = TOKENS.split(text, 3);
			if (parts.length == 3 && List.of("/msg", "/tell", "/w").contains(parts[0])) {
				return new Sent(text, parts[2], parts[1], true);
			}
			if (text.startsWith("/r ")) return new Sent(text, text.substring(3), null, true);
			return new Sent(text, text, null, false);
		}

		boolean echoes(String incoming, String localName) {
			if (incoming.equals(text)) return true;
			if (!privateMessage) {
				var match = PUBLIC_ECHO.matcher(incoming);
				return match.matches() && match.group(1).equalsIgnoreCase(localName) && match.group(2).equals(body);
			}
			for (Pattern pattern : PRIVATE_ECHO) {
				var match = pattern.matcher(incoming);
				if (match.matches() && (recipient == null || recipient.equalsIgnoreCase(match.group(1))) && body.equals(match.group(2))) return true;
			}
			return false;
		}
	}

	/** Run with -ea after compilation; assertions intentionally require no test dependency or client. */
	public static void main(String[] args) {
		List<String> commands = List.of("/home", "/msg");
		assert rejection("/home", 256, commands) == null;
		assert rejection("/homebase", 256, commands).equals("command_not_allowed");
		assert rejection("/minecraft:home", 256, commands).equals("command_not_allowed");
		assert rejection("#goto 1 2", 256, commands).equals("command_not_allowed");
		assert rejection("\ud83d\ude00".repeat(129), 256, commands).equals("too_long");
		assert rejection("/msg Bob " + "a".repeat(248), 256, commands).equals("too_long");
		List<Pattern> mentions = mentions(List.of("waffle"), List.of("ai", "bot"));
		assert mentions("WAFFLES!", mentions);
		assert mentions("(AI), bot!", mentions);
		assert !mentions("stairs robot ai_ aié", mentions);
		assert whisperSender("Bob whispers to you: hello").equals("Bob");
		assert whisperSender("<Bob> whispers to you: hello").equals("Bob");
		assert whisperSender("[Bob -> me] hello").equals("Bob");
		assert whisperSender("From Bob: hello").equals("Bob");
		assert whisperSender("someone says From Bob: hello") == null;
		assert Sent.of("hello").echoes("<Waffle> hello", "Waffle");
		assert !Sent.of("hello").echoes("<Bob> hello", "Waffle");
		assert Sent.of("/msg Bob hello").echoes("[me -> Bob] hello", "Waffle");
		assert !Sent.of("/msg Bob hello").echoes("From Bob: hello", "Waffle");
		assert !Sent.of("/msg Bob hello").echoes("To Alice: hello", "Waffle");
	}
}
