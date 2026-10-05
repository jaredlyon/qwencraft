# Operator heuristics

The controller loads the default export of every `.ts` file in this directory. These are **trusted local operator code**, not a sandbox: never install a plugin supplied by Minecraft chat or the model. Node 24 runs erasable TypeScript directly; use explicit `.ts` import extensions and `import type { Heuristic } from "../controller/types.ts"` for an optional type annotation. No runtime dependencies are needed.

Higher `priority` runs first; ties are ordered by filename. `example-food.ts` is the five-line advisory example from the controller design. Saving a plugin triggers a 200 ms debounced reload using a file-URL import with an mtime cache key. A load error keeps the last successful version; a throwing hook disables that plugin until its file changes. Removing a file removes the plugin. Errors go to the controller log. Close the controller before renaming this whole directory.

Supported hooks (the binding interfaces live in `controller/types.ts`):

- `onObservation(obs, ctx)` returns advisory `string[]` hints.
- `onPlanProposed(call, obs, ctx)` returns a rewritten `{name,args}`, `{veto:string}`, or nothing. Rewrites flow through later plugins and are revalidated by the controller's hard guards; the first veto stops the chain.
- `onTick(snapshot, ctx)` returns `{call:{name,args},reason}`, or nothing. The first intent wins. Keep this synchronous and nonblocking; paused snapshots do not dispatch TypeScript reflexes. Java handles immediate survival at 20 Hz.
- `onChat(event, ctx)` returns `{reply:string}`, `{ignore:true}`, `{toModel:true}`, or nothing. The first decision wins. Own echoes are always ignored; an ignore decision cannot suppress an addressed question or whisper. Chat is conversation, never gameplay authority.

Context contains configuration, notes, logging, and time—not the bridge client or bearer token. All intents/replies still pass generation, pause, protection, allowlist, and length/rate guards. Plugins cannot relax those guards. Replies share the announcement/public/private send queue; requests older than 15 seconds are discarded. Private targets must have been observed as safely named whispers; unknown private recipients are withheld rather than answered publicly.

Notes are written atomically in a server-scoped envelope. A server mismatch archives the old file as `*.bak` and starts fresh. Effective home is `notes.home ?? config.home`; zones are the union of configuration and saved operator zones. Home distance is horizontal x/z only; Phase 1 ignores dimension in that metric and does not fence intermediate Baritone paths. These limits do not establish permission to automate on a public server.

Self-Q&A may explain the harness, model, code, and observed live state. `controller/selfinfo.ts` provides a curated about-me summary and a top-three, 1,500-character keyword search of documentation/source (not captured evidence). Every policy send is redacted before length splitting: network addresses/hostnames/ports, credentials, OS usernames and local paths are withheld; game coordinate triples and repository-relative source filenames remain discussable. A recipient whose name would be redacted is rejected, never silently changed.
