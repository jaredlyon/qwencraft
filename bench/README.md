# Local phase-1 bench

This is a disposable **Paper 26.3 build 151** server, not RayCraft acceptance. The visible Fabric development client plays as `QwenBench` in `mod/run/`; nothing here installs into the user's real `.minecraft`. Close the real Minecraft client first so its bridge does not occupy port 25599.

Prerequisites: Node 24.12+, the checked-in Gradle wrapper/vendor JARs, and JDK 25 at `D:/qwencraft/.tools/jdk-25.0.4.1+1`. No npm runtime dependencies or TypeScript build step are needed. Spark's existing `qwen3.8-flash-next` endpoint must be reachable at `http://192.168.100.2:8000/v1`; do not restart/reconfigure that shared service.

## Bring-up (PowerShell, in this order)

1. **Terminal A — server.** Running the launcher accepts the [Minecraft EULA](https://aka.ms/MinecraftEULA) by writing `eula=true`; read and agree before executing it.

   ```powershell
   Set-Location D:/qwencraft
   node bench/server.ts
   ```

   Wait for Paper's `Done` startup line. The launcher downloads `bench/server/paper.jar` from the [Paper build API's](https://fill.papermc.io/v3/projects/paper/versions/26.3/builds) pinned [build-151 artifact](https://fill-data.papermc.io/v1/objects/daf00db322543de77eb2012f37a1919537fafe13e04888ef256e56a5ca51af69/paper-26.3-151.jar) and verifies SHA-256 `daf00db322543de77eb2012f37a1919537fafe13e04888ef256e56a5ca51af69` before execution, including on cached launches. A mismatching cached JAR is refused, not silently replaced. It launches `D:/qwencraft/.tools/jdk-25.0.4.1+1/bin/java.exe -Xmx3G -jar paper.jar --nogui` in `bench/server/`.

2. **Terminal B — operator grant.** RCON becomes available only after server startup.

   ```powershell
   Set-Location D:/qwencraft
   node bench/rcon.ts "op QwenBench"
   ```

3. **Terminal C — visible development client.** It automatically joins `127.0.0.1:25570` as `QwenBench`.

   ```powershell
   $env:JAVA_HOME = 'D:/qwencraft/.tools/jdk-25.0.4.1+1'
   $env:PATH = "$env:JAVA_HOME/bin;$env:PATH"
   Set-Location D:/qwencraft/mod
   .\gradlew.bat runClient
   ```

   On the first launch, MCPFabric generates `mod/run/config/mcpfabric.config.json` and a private token. **Do not start the controller yet.** Close this development client, wait for `runClient` to exit, then run the following in Terminal B to configure only that development bridge (preserving its token):

   ```powershell
   Set-Location D:/qwencraft
   $path = 'mod/run/config/mcpfabric.config.json'
   $bridge = Get-Content $path -Raw | ConvertFrom-Json
   $bridge.host = '127.0.0.1'
   $bridge.port = 25599
   $bridge.requireAuth = $true
   $bridge.enableWorldWrite = $false
   $bridge.enableCommands = $false
   $bridge.enablePlayerControl = $true
   $bridge.enableVision = $true
   $bridge | ConvertTo-Json -Depth 100 | Set-Content $path -Encoding utf8NoBOM
   ```

   `utf8NoBOM` requires PowerShell 7; under Windows PowerShell 5.1 replace the last line with:

   ```powershell
   [System.IO.File]::WriteAllText((Join-Path $PWD $path), ($bridge | ConvertTo-Json -Depth 100), [System.Text.UTF8Encoding]::new($false))
   ```

   Relaunch in Terminal C with the same command:

   ```powershell
   .\gradlew.bat runClient
   ```

   On subsequent runs, the bridge settings persist; check they are still correct before starting the controller. Do not paste the token into commands, logs or screenshots.

4. **Terminal B — authenticated bridge inspection.** These commands use the dev token through the bench configuration, not the real client's token.

   ```powershell
   Set-Location D:/qwencraft
   node bench/rpc.ts info.capabilities '{}' --config bench/qwencraft.bench.json
   node bench/rpc.ts qc.control.state '{}'
   ```

   Confirm world-write/admin commands are disabled and player-control/vision enabled. The companion's guards default fail-closed until the controller applies configuration.

5. **Terminal D — controller.** Start it with the explicit bench config so it never targets RayCraft.

   ```powershell
   Set-Location D:/qwencraft/controller
   node main.ts --config ../bench/qwencraft.bench.json
   ```

   It starts paused. In **this controller terminal**, enter:

   ```text
   resume
   ```

   Vanilla Paper has no `/home`. The one-time home lookup should fail or time out within 10 seconds, print ``set home with `home set` `` and stay idle. At your chosen safe bench anchor, enter:

   ```text
   home set
   resume
   status
   collect 4 oak logs
   ```

   `home set` records the current client position; it is not `/sethome`. The default horizontal home radius is 256 blocks. The initial natural-block list is a starting allowlist to review, not permission to break any crafted block. Activation and control changes produce no lifecycle chat. Bench configuration uses `chat.nicknames=["QwenBench"]` (case-insensitive substring) and `chat.wholeWords=["jared"]` (case-insensitive whole word); whispers always count as addressed. Other players see chat only when Jared types in-game himself (or uses unchanged controller-console `say <text>`) or the agent replies to an incoming non-self addressed message. Code rejects agent chat tools unless the current request contains an incoming non-self `player` event with `mentionsMe=true` or a `whisper` in observation `recentChat` or pending `mustReply`. Non-addressed chat remains context only for the next turn and does not wake the model; allowlisted commands such as `/home` remain separate. [D-48](../docs/00-decisions.md#d-48--addressed-only-agent-chat) [D-47](../docs/00-decisions.md#d-47--reply-only-agent-chat)

## Local checks and shutdown

Run these from `D:/qwencraft` in Terminal B while the client/controller remain visible:

```powershell
node bench/rpc.ts qc.baritone.status '{}'
node --% bench/rpc.ts events.getRecent "{\"limit\":100,\"sinceId\":0}"
```

For conversation checks, have a consenting second player join the loopback bench: first send `What are you doing?` publicly and confirm no model wake/reply, then ask `QwenBench, are you an AI?`, repeat with `Jared, what are you doing?`, and privately ask without either name. The addressed public questions and whisper should receive public/private replies respectively; the unaddressed question stays observation `recentChat` context for the next turn. RCON `say` is system text, not a player message that authorizes agent chat. Check actual replies, events, inventory changes and motion, not merely successful RPC submission. Confirm a chat tool attempt without a current-request incoming non-self addressed message returns `{ok:false, summary:"chat is only for replying to a message that mentions you"}` without sending. Test F8 and physical input takeover while supervised. In the controller terminal, `stop` releases agent actions; `resume` explicitly rearms them; `quit` pauses/releases and exits. None produces lifecycle chat. F8/manual input also disable Java reflexes; console/dead-man pauses leave survival reflexes enabled. Do stop/dead-man checks in a safe full-food location.

Shutdown order: enter `quit` in Terminal D, close the development Minecraft client in Terminal C, then stop Paper from Terminal B:

```powershell
node bench/rcon.ts "stop"
```

Paper may close RCON before the reply marker; in that case the CLI reports an incomplete response even though the server is stopping. Confirm `Saving`/`Stopping` and exit in Terminal A. Alternatively type `stop` directly in Terminal A. Its launcher forwards console input; Ctrl+C also requests a normal stop.

The bench owns only `bench/server/` (world, Paper cache, `server.properties`, EULA, `rcon.secret`, and `bench-notes.json`) and `bench/logs/`. Game port **25570**, RCON **25575**, and bridge **25599** bind to loopback. Offline-mode is strictly for this local bench; never expose it to the network. Treat `rcon.secret` and the password-bearing `server.properties` as private; the launcher preserves its random secret across starts. All config-relative paths resolve against `bench/qwencraft.bench.json`'s directory. Existing worlds/notes are not reset by the launcher.

The RCON CLI collects split replies using a read-only `list` marker after the requested command; the marker's reply is not printed. Both CLIs exit nonzero on failure and never retry a mutation automatically. The RPC CLI prints the successful result as JSON, or an error envelope on stderr.

Offline regression checks (fake loopback RCON only; no Minecraft/Paper process):

```powershell
node --test bench/bench.test.ts
```

These checks cover wire encoding, authentication failure, fragmented multi-packet Unicode responses, and a known SHA-256 value. They do not establish live gameplay acceptance; all five RayCraft criteria remain in [the acceptance design](../docs/50-install-and-verification.md).
