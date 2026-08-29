# Task 8 Report: Chat Emotion Reaction

**Status:** DONE

**Commits:** working tree changes on `main`, committed as a single commit following `5671a0b` (新增 Dashboard 聊天分页...) — see `git log -1` after commit for hash.

**Files Changed:**
- `D:/GitHub/AI-deskcompanion/src/chat.js` — added exported `EMOTION_TAG_INSTRUCTION` constant.
- `D:/GitHub/AI-deskcompanion/src/main.js` — imports `EMOTION_TAG_INSTRUCTION`; appended it to both `effectiveCfg.systemPrompt` constructions (`pet:chat-send-with-image` ~L3192, `pet:chat-send` ~L3794); added module-level `EMOTION_TAG_RE` and `EMOTION_EMOJI` near `CHAT_CONTEXT_MESSAGES` (~L3044); added emotion-tag buffering/parsing inside both handlers' `onDelta` callbacks, and stripped the tag from the `full` string returned by `streamChatReply` before it's used for conversation history / `pet:chat-complete` / `pet:chat-message-done` / `extractMemoryFacts` / `saveScreenTip`.
- `D:/GitHub/AI-deskcompanion/src/renderer.js` — added `spawnEmojiReaction`/`drawEmojiReactParticles` one-shot emoji particle system (~L1396-1436, next to the existing `noteParticles` music-beat system); added `window.pet.onChatEmotion(...)` listener next to `playAnimationRow`/`onPlayRow` (~L1440); wired `drawEmojiReactParticles(nowMs)` into `render()` next to the existing `drawNoteParticles(nowMs)` call.
- `D:/GitHub/AI-deskcompanion/src/preload.cjs` — added `onChatEmotion` IPC bridge next to `onChatComplete`.
- `D:/GitHub/AI-deskcompanion/config.default.json` — added `_emotionRows`/`emotionRows` for both `sebastian-raven` and `ciel-young-master`, next to each pet's `claudeStatusRows`.
- `D:/GitHub/AI-deskcompanion/config.json` (gitignored, not committed) — mirrored the same `emotionRows` addition for local testing/dev-parity, since this is the file actually loaded at runtime when present.

**Design Decisions:**
- Single-call self-tagging: the model prepends `[EMOTION:xxx]\n` as the first line of its streamed reply (`chat.js`'s `EMOTION_TAG_INSTRUCTION`), avoiding a second classification call.
- Buffering in `onDelta`: both `pet:chat-send` and `pet:chat-send-with-image` handlers accumulate incoming deltas into `introBuffer` until a `\n` is seen (tag line complete) or the buffer exceeds 60 chars (safety valve for models that don't comply with the format — otherwise no character would ever reach the display since we'd wait forever for a newline). Once resolved, the tag (if matched by `EMOTION_TAG_RE`) is stripped and `pet:chat-emotion` is emitted with `{ emotion, emoji, row }`; if the format wasn't followed, the buffered text is passed through unchanged and no reaction fires.
- `pet:chat-emotion` is always sent to `win` (the floating pet window), never `senderWin` — the emotion reaction must play on the pet sprite regardless of whether the chat was sent from the pet's own bubble UI or from the Dashboard's chat tab (which has no sprite to animate).
- **Deviation from the literal task pseudocode, done deliberately for correctness:** `streamChatReply`'s returned `full` string is built internally from the *raw* deltas (`full += delta` happens before `onDelta(delta)` is even called — see `chat.js`'s `streamOllamaChat`/`streamOpenAiCompatibleChat`), so it is NOT automatically clean just because `onDelta` forwarded a stripped `outDelta`. Without an extra strip, the `[EMOTION:xxx]` tag would still land in: saved conversation history (`conv.messages`), the final chat bubble text (`pet:chat-message-done` — confirmed `renderer.js`'s `onChatMessageDone` blindly overwrites the bubble's `textContent` with this value, which would visibly reintroduce the tag after the streamed/stripped version had already displayed correctly), the TTS completion signal (`pet:chat-complete`), `extractMemoryFacts`, and (image handler) `saveScreenTip`'s `记录` entry. Added `const full = rawFull.replace(EMOTION_TAG_RE, '');` right after each `streamChatReply` call and use `full` (not the raw promise result) everywhere downstream. `EMOTION_TAG_RE` was hoisted to module scope so both handlers share one instance.
- Emoji particle animation (`renderer.js`) mirrors the existing note-particle system's visual language (single font-drawn glyph, alpha fade) but is a one-shot bounce-in-then-drift-fade rather than a continuous per-beat stream, per the task spec's `EMOJI_REACT_LIFE_MS`/bounce-scale timing.
- `emotionRows` in config is deliberately sparse (no `neutral` mapping) — emotions without a row mapping still spawn the emoji via `EMOTION_EMOJI`, just no forced pose change, matching the "grow later" design noted in the `_emotionRows` config comment.

**Tests Run:**
- `node -c src/main.js` — OK
- `node -c src/chat.js` — OK
- `node -c src/renderer.js` — OK
- `node -c src/preload.cjs` — OK
- `node -e "JSON.parse(require('fs').readFileSync('config.default.json','utf8'))"` — OK, valid JSON
- `node -e "JSON.parse(require('fs').readFileSync('config.json','utf8'))"` — OK, valid JSON
- `npm start` run for ~12s then terminated — no startup errors, no stack traces in log; only expected `[companion watcher] watcher exited (code=143 signal=null)` from the SIGTERM on timeout. No stray `electron.exe` processes left after (`tasklist` clean).

**Self-Review:**
- Verified the non-compliant-model fallback path: if the model never emits a `\n` within the tag window, buffering stops at >60 chars and the whole buffered chunk is flushed as-is (no tag stripped, no `pet:chat-emotion` fired) — worst case this delays the very first ~60 characters of the reply reaching the bubble by however long it takes the model to stream that much, not the whole reply. This is a real behavior — with slow local models producing single-token deltas, up to the first 60 chars could appear as one lump instead of streaming smoothly — but is a small, bounded window and stops the app from ever hard-stalling waiting for a newline that never comes.
- Confirmed the `full`-stripping fix described above was necessary, not speculative: traced `streamOllamaChat`/`streamOpenAiCompatibleChat` in `chat.js`, both build their returned string from the same `delta` passed to `onDelta`, independent of `onDelta`'s side effects, and confirmed `renderer.js`'s `onChatMessageDone` handler (`pendingBubbleEl.textContent = text`) would have re-displayed the raw tag on completion had this not been fixed.
- Confirmed `pet.emotionRows` (not `chatCfg`/`visionCfg`) is read from `activePet()`, matching both pets' `config.default.json` placement.
- `EMOTION_TAG_RE` only recognizes the five documented emotions (`happy|sad|angry|surprised|neutral`); an unrecognized tag word (e.g. model hallucinating `[EMOTION:excited]`) falls into the "no match" branch, passes the raw line through untouched (including the bracket syntax, visible to the user) and fires no reaction — acceptable given `EMOTION_TAG_INSTRUCTION` explicitly constrains the model to that vocabulary, but noted as a soft edge case worth watching if this shows up in practice with a chattier model.
- Did not touch the two other `streamChatReply` call sites in `main.js` (~L329, ~L438, ~L1452, and the memory-extraction/report-generation ones around L3560-3748) — none of those are user-facing chat replies through the pet UI, so they were correctly left without the emotion instruction/parsing per the task's scope (only `pet:chat-send` and `pet:chat-send-with-image`).
