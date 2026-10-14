# AI voice: natural turn-taking — keep talking through "mm-hmm", handle silence, measure response time

Date 2026-10-09. Branch `feat/ai-voice-natural` (worktree `.worktrees/ai-voice-natural`), from origin/main 05371d1. Code: `services/cti-api/src/ai-voice/` (the Twilio ⇄ OpenAI Realtime bridge), plus one column and a summary line in outreach-web.

## 1. What the owner asked for

> "How do we make this sound super natural — like when it interrupts it… I want people to feel like they're talking to a human."
> "How do we make it so that it only pauses where it should — not on mm-hmm etc."

Agreed order (2026-10-09): **(1)** this spec: the "mm-hmm" fix, faster transcription, silence handling, response-time numbers, on the current engine (gpt-realtime-2.1). **(2)** fake-seller tests (an AI plays the seller). **(3)** a GPT-Live trial on practice calls only, compared with (2). Items 2 and 3 get their own specs.

Fixed, not up for change: the agent still opens with "an AI assistant … on a recorded line" and never claims to be human (prompt `# Disclosure`). Natural-sounding, not deceptive.

## 2. The problem in today's code

`bridge-session.ts` sets `semantic_vad` with `create_response: true, interrupt_response: true`. On every `input_audio_buffer.speech_started`, `bridge.ts` `onCallerSpeech()` sends Twilio `clear` and truncates the agent's item; OpenAI cancels the response server-side. So any sound from the caller — "mm-hmm", "yeah", a cough, a TV — cuts the agent off mid-sentence, and the auto-response then answers the "mm-hmm" ("Great! So…"). OpenAI staff confirmed in Sep 2026 that semantic VAD is not a filter for filler words.

Silence: the prompt says to ask "Are you still there?" after a long silence, but nothing ever prompts the model during silence (semantic VAD has no `idle_timeout_ms`; only `server_vad` does), so that rule never fires.

Response time is not measured anywhere.

## 3. Live test results (2026-10-09, scratchpad spike against the real API, continuous 20 ms μ-law line audio)

| Finding | Evidence |
|---|---|
| `create_response: false` and `interrupt_response: false` are honored over WebSocket | No response after a caller turn; the agent kept streaming 197–253 audio deltas through caller speech; `response.done status=completed` |
| `gpt-live-transcribe` is accepted as the session transcriber and streams words **while the caller is still talking** | `session.updated` echoes `{"model":"gpt-live-transcribe","languages":["en"]}`; deltas " Yeah", " I've", " been"… arrive 0.2–0.6 s apart during a 5 s sentence |
| First word ≈ 1.0–1.2 s after `speech_started` | "Mm-hmm": 1.06 s; "Wait, hold on": 1.16 s |
| `gpt-realtime-whisper` is slower for short backchannels | "Mhm" arrived only at completion, 3.2 s after `speech_started` |
| Semantic VAD (`auto`) waits ~1.6 s after a long sentence ends before `speech_stopped`; ~0.3 s after a question | phase 1 vs phase 3 |
| `keywords` is not echoed in the session | dropped or unsupported here — not used |

## 4. Design

### 4.1 Barge-in gate (new default; `AI_VOICE_BARGE_IN=gate|instant`)

The bridge owns turn-taking. Session: `semantic_vad`, `create_response: false`, `interrupt_response: false`, transcription `AI_VOICE_TRANSCRIBE_MODEL` (unset: `gpt-live-transcribe` in gate mode). `instant` keeps today's exact behaviour (both flags true, old `onCallerSpeech`, and — unless the variable is set — today's `gpt-4o-mini-transcribe`), as the one-switch rollback.

When the caller starts talking (`speech_started`, which carries the input `item_id`):

| Agent state | What the gate does |
|---|---|
| Closing (goodbye / transfer line playing) | Nothing. Let it finish. |
| Agent audio is playing | Open an **overlap** for that item. Keep talking. Decide from the caller's words (below). |
| A response is in flight but no audio has played yet | Cancel it now (`response.cancel`) — invisible to the caller — and answer when their turn ends. |
| Agent silent | Normal turn: answer when it ends. |

An overlap is decided by the words streamed so far (`conversation.item.input_audio_transcription.delta` for that item), normalised and split:

- **Stop now** if any word is a stop cue: `wait`, `hold` (on/up), `hang` (on), `stop`, `no`, `nope`, `nah`, `sorry`, `excuse`, `what`, `huh`, `who`, `why`, `pardon`, `actually`, `but`.
- **Stop now** if 2 or more words are not listening sounds.
- **Listening sounds** (never stop the agent alone): mm-hmm / mhm / hmm / uh-huh, yeah / yep / yup / yes, ok / okay / O.K., right, sure, alright, got it / gotcha, I see, oh / ah / wow, cool, nice, great, true, totally, exactly, really, interesting, a single "hello", the phrases of course / sounds good / go ahead / go on / I know / fair enough / no problem (folded before the stop-cue check, so "no problem" is not "no"; "of course not" is not folded), and fillers um / uh — including stretched or doubled ones (mmm, hm, umm, uhh, ohh, erm). Unicode dashes count as hyphens.
- **Stop anyway** if the caller has been talking for 3.0 s and no word has arrived (transcriber hiccup, another language). The timer is disarmed when the caller stops talking, so a short wordless sound (a cough) is settled by its empty transcript and ignored. (Raised from 2.0 s after the spike: first words land ~1.0–1.2 s in, and semantic VAD's stop can lag 1.5–2.8 s.)

"Stop" = Twilio `clear`, `response.cancel`, truncate the item at what was heard (existing `PlaybackTracker.interrupt()`), transcript note `[stopped — they interrupted]`. When their turn ends, the agent answers.

When an undecided overlap's turn ends (`committed`, then `…transcription.completed` gives the final text), re-check the final text. Words can still stream in after the commit: if they turn it into an interruption, the agent is cut and that already-finished turn is answered. Still listening sounds (or empty) → the agent never answers it, except:

- **Late overlap = an early answer.** If the caller started talking when the agent's audio was fully generated and at most 1.5 s of it was left to play ("…got a quick minute?" / "yeah sure"), or is still talking when the agent finishes (its audio drained before their `speech_stopped`), it is their answer: the agent answers once its audio finishes playing. A mid-sentence "mm-hmm" has long stopped before the drain, so it stays ignored; a wordless sound is never an answer. Audio still queued ahead of an item (a tool follow-up forwarded while the first response plays) counts toward what is left to play.

**The opener is protected.** The first agent response (the disclosure line) is never cut by the gate; caller speech over it is never answered mid-line: a real interruption over it ("Wait, who is this?", "Hello? Hello?") is answered once the opener has played, a listening sound over its last 1.5 s, or still going when it finishes, counts as a late answer, and anything else is ignored. Compliance: "AI assistant … recorded line" is always said in full.

All responses go through one `requestResponse()`: if a response is active or a tool batch is running, it is deferred until that finishes, so the bridge never sends two `response.create`s at once.

**Known limit:** words arrive ~1 s after the caller starts, so a real interruption stops the agent ~1.0–1.3 s in (today: ~0.3 s, but also on every "mm-hmm"). Humans take ~0.5–1 s to yield. If this feels long in testing, the follow-up is **ducking** (lower the agent's volume during an undecided overlap by re-sending the unplayed audio quieter) — not in this spec. **2026-10-13:** it did feel long; §4.5 (the sound judge, now the default) stops on how long the caller keeps talking instead. The word rules in this section are `AI_VOICE_OVERLAP_JUDGE=words`, and stay as a second path under the sound judge.

### 4.2 Silence

- **`wait_for_user` tool** (no parameters). The model calls it when what it heard wasn't meant for it (TV, someone else in the room, noise) or the person asked it to hold on (after a short "Sure, take your time"). The bridge answers it itself (`{"ok":true}`, never reaches the call service) and does **not** ask the agent to speak.
- **Silence check-ins.** Once the agent has finished speaking and is waiting (no response, not closing, opener already played), a timer starts: 8 s normally, 30 s after `wait_for_user`. On fire: transcript note `[no answer for 8 s]`, a hidden note `(No one has said anything for 8 seconds.)` and a response. The prompt: first note → a short check-in ("Hey — are you still there?"); second note → quick goodbye → `end_call` (`hung_up`). The bridge sends at most 2 notes until the caller speaks again. Any caller speech or response cancels the timer.

### 4.3 Response-time numbers

Per caller turn the agent answers:
- `endpointMs` — how long after the caller actually stopped the turn was declared over: (caller audio sent to OpenAI so far, in ms, when `speech_stopped` arrives) − `audio_end_ms`. Assumes no early caller audio was dropped by the outbox (it already logs a warning when it does). **Amended 2026-10-12:** OpenAI's `audio_end_ms` already includes the VAD's wait (for `server_vad`, the `silence_duration_ms`), so that formula alone understates what the caller waited (prod showed an endpoint p50 of 90 ms while callers waited seconds). With `server_vad`, `endpointMs` = sent − `audio_end_ms` + `AI_VOICE_SILENCE_MS`. With `semantic_vad` the true wait is not knowable from the event, so the formula is unchanged and still understates it.
- `answerMs` — wall clock from `speech_stopped` to the first agent audio forwarded to Twilio.
- `totalMs = endpointMs + answerMs`. Twilio playout and network (~0.1–0.2 s) are not included.

Per call, saved in new column `ai_calls.turn_stats jsonb` (migration 0059) when the bridge ends:

```json
{ "v": 1, "bargeIn": "gate", "turns": 9,
  "totalMs": { "p50": 1900, "p90": 2600, "max": 3100 },
  "endpointMs": { "p50": 1100 }, "answerMs": { "p50": 800 },
  "interruptions": 1, "listening": 4, "silenceChecks": 0 }
```

outreach-web shows one line above every call transcript, e.g. "Response time: usually 1.9 s (slowest 3.1 s) · kept talking through 4 "mm-hmm"s · stopped for 1 interruption". `null` stats (calls before this ships) show nothing. `listening` counts overlaps ignored as listening sounds that had at least one word; a cough, noise or failed transcription is not counted. Also logged per call (`ai-voice: turn stats`).

### 4.4 Prompt changes

- `# Tools`: `wait_for_user` — when to call it, silently or after "Sure, take your time"; say nothing after it.
- `# Unclear audio`: replace the unreachable long-silence rule with the note-based rule (§4.2).
- `# Personality & Tone`: "If you get cut off, don't repeat what you already said — respond to what they said; pick your point back up only if it still matters." "A short 'mm-hmm' or 'yeah' as their whole reply means yes/okay to what you just asked." "For simple confirmations, answer right away."

### 4.5 Sound judge (v2, 2026-10-13)

**Problem.** On a live gate call, turns where the caller spoke over the agent took p90 4.9 s / max 7.0 s to answer (normal turns were fine), because (1) a real interruption was recognised only once its words arrived, ~1 s or more after the caller started, and (2) a late overlap (an answer over the agent's last ~1.5 s) and a caller still talking when the agent's audio ended were answered only after the agent's audio drained **and** the final transcript arrived. The owner: "keeps talking over me and then later registers it". Prod was switched to `instant` (fast, but it stops on every "mm-hmm").

**Rules** (gate mode, `AI_VOICE_OVERLAP_JUDGE=sound`, the default):

- **A. Sound stop.** While the agent is speaking (not the opener), the caller's current sound reaching `AI_VOICE_STOP_MS` (default 600 ms) cuts the agent at once (§4.1's "stop"). Shorter sounds ("mm-hmm", "yeah", "okay": about 200–560 ms) do not. The word rules of §4.1 stay as a second path — a stop word, two real words, 3 s with no words — so a short "wait" still stops it, about a second later.
- **B. Late overlap.** Caller speech that starts with at most 1.5 s (`LATE_OVERLAP_MS`) of agent audio left cuts the agent at once (Twilio `clear` + truncate), no words needed; that turn is answered at its commit (~0.9 s after they stop) like any turn. Any sound OpenAI's VAD takes for speech counts — a cough in those last 1.5 s also cuts the agent and is answered, unlike §4.1, where a wordless sound is never an answer. A late cut never cancels a reply whose audio has all arrived (`output_audio.done`): its `response.done` still delivers its tool calls, so "Bye!" + `end_call` or a transfer preamble + `transfer_to_rep` still run (the caller's turn waits behind them, and a tool that ends the conversation wins, as in §4.1). A follow-up reply with no audio yet is still cancelled. Sound and word cuts (A) cancel as before, so "wait, one more thing" over a goodbye still drops its `end_call`.
- **C. Still talking when the agent's audio finishes.** No longer an overlap: it is the caller's turn, answered at its commit — never waiting for the transcript. (The bridge also answers it at once if it was already committed, but that is a defensive path: OpenAI sends `speech_stopped` before `committed`, and a stopped overlap is not handed back — it waits for its words as in §4.1.) While a tool follow-up reply is pending at that moment, nothing is handed back: the overlap is judged as in §4.1.
- **The opener** (the AI disclosure) is still never cut: the sound and late rules do not apply to it, and a late overlap over it is judged by its words as in §4.1. Rule C does apply: a caller still talking over the opener when it finishes is answered at their commit (a cough included), without waiting for words.

**How the sound is measured** (`bridge-sound.ts`, `CallerSoundMeter`). Every inbound Twilio frame (20 ms of μ-law) is decoded after it is forwarded to OpenAI. A frame is loud at RMS ≥ 300 (16-bit scale) and ≥ 4× the line's noise floor (which follows quiet frames quickly and loud ones slowly, so a steady hum raises the bar but speech does not). A sound runs from its first loud frame to its last; quiet gaps under 300 ms (between words, "mm … hmm") do not end it. Its clock is the caller's audio, so it needs no timers. The gate (`bridge-overlap.ts`) checks the run on every frame while an overlap is open and not yet stopped (`speech_stopped`).

**Calibration** (scratchpad spike, 2026-10-13: TTS clips, 4 voices, as 8 kHz μ-law; "run" = first loud frame → last loud frame, quiet gaps under 300 ms bridged; loud = frame RMS ≥ 300):

| Caller audio | Sound run |
|---|---|
| Listening sounds: mm-hmm, yeah, uh-huh, okay, right, sure, yep, got it, oh okay, yeah yeah | mostly 200–560 ms |
| Real replies: "no not really", "it's vacant", "I'm not interested", "how much would you pay?" | mostly 600–1700 ms |
| Rule "run ≥ 600 ms" | 2 of 40 listening sounds would stop the agent; 20 of 28 real replies stop it by sound (the rest by words, later) |

**Trade-off.** About 5% of listening sounds may stop the agent (a long "yeah, yeah"); short real replies stop it by their words about a second later, as before. `AI_VOICE_STOP_MS` moves the line: lower stops sooner but more "mm-hmm"s stop it; higher means fewer false stops but slower ones. To tune from real calls, the bridge logs `ai-voice bridge: caller interrupted the agent` `{ why: sound | late | words | no words, runMs }` and `ai-voice bridge: caller listening sound` `{ maxRunMs }` (numbers and enums only). `AI_VOICE_OVERLAP_JUDGE=words` is the rollback to §4.1's word judge exactly; `instant` mode never measures sound (its frames are unchanged).

## 5. Config

| Var (cti-api) | Default | Notes |
|---|---|---|
| `AI_VOICE_BARGE_IN` | `gate` | `instant` = today's behaviour |
| `AI_VOICE_TRANSCRIBE_MODEL` | gate: `gpt-live-transcribe`; instant: `gpt-4o-mini-transcribe` | Unset follows `AI_VOICE_BARGE_IN`, so `instant` alone also restores today's transcriber; a value set explicitly wins in either mode. Without streaming words the gate degrades to "stop after 3 s" (a short wordless sound is still ignored once the caller stops) |
| `AI_VOICE_TURN_DETECTION` | gate: `server_vad`; instant: `semantic_vad` | Added 2026-10-12. Unset follows `AI_VOICE_BARGE_IN` (instant keeps today's frames byte for byte); a value set explicitly wins in either mode, so `semantic_vad` alone rolls back just the VAD. `server_vad` is sent as `{ type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms, create_response, interrupt_response }` (gate: both `false`; instant: both `true`) |
| `AI_VOICE_SILENCE_MS` | `500` | Added 2026-10-12. Integer 200–2000; `server_vad` only. Lower = faster, but the agent more often starts answering into a pause |
| `AI_VOICE_OVERLAP_JUDGE` | `sound` | Added 2026-10-13 (§4.5). Gate mode only. `sound` = the caller's sound lasting `AI_VOICE_STOP_MS` stops the agent at once, late overlaps stop it at once, a caller still talking at the end is answered at their commit; the word rules still apply. `words` = the 2026-10-09 word judge (§4.1) exactly — the rollback |
| `AI_VOICE_STOP_MS` | `600` | Added 2026-10-13. Integer 300–2000; sound judge only. Lower = stops sooner, but more "mm-hmm"s stop it; higher = fewer false stops, but slower |

`AI_VOICE_VAD_EAGERNESS` (exists, `auto`) applies to `semantic_vad` only (2026-10-12; it was the knob for the ~1.6 s end-of-turn wait, which proved to be up to ~4.8 s).

### 2026-10-12 latency finding

Live callers waited seconds for the agent to answer. Measured against the live OpenAI API (scratchpad spike, the real prompt, `gpt-realtime-2.1`, 6 turns per configuration, all times from the caller's last voiced audio):

| Turn detection | Detects end of turn (p50) | Model's first audio (p50) |
|---|---|---|
| `semantic_vad`, eagerness `auto` (prod until now) | 4774 ms, bimodal: about 1.0 s or the ~4.8 s cap; short replies such as "Yeah, this is Jane." hit the cap most | 843 ms |
| `semantic_vad`, eagerness `high` | 2403 ms (about 1.4 s or about 2.9 s) | about 813 ms |
| `server_vad`, `silence_duration_ms` 500 | 912 ms (all 6 turns 874–1012 ms) | about 882 ms |

The transcriber (`gpt-live-transcribe`, `gpt-4o-mini-transcribe`, none, whisper) and the reasoning effort (`low`, `minimal`) made no material difference. So the gate now defaults to `server_vad` at 500 ms. A caller who pauses longer than that mid-thought gets a response created early; if they resume before the agent's first audio (about 0.9 s later) the gate cancels it unheard (§4.1) and one response answers both parts after their second commit, so the early start costs nothing the caller can hear. Instant mode is unchanged.

## 6. Testing

- Pure units: word classifier (table-driven), overlap gate (fake clock), silence timer, stats (percentiles).
- `bridge.test.ts` (fake sockets, existing harness): mm-hmm keeps audio flowing and never answers; "wait hold on" clears + cancels + truncates and answers after commit; 3 words interrupt; no-words fallback at 3 s (a short wordless sound is ignored once the caller stops); late overlap answered after drain; opener never cut; in-flight response with no audio cancelled; `requestResponse` never double-creates (tool batch + caller turn); `instant` mode byte-for-byte today's frames; silence notes (8 s, 30 s after `wait_for_user`, max 2); stats end up in `onEnd`.
- Prompt snapshot updated; migration test; outreach-api transcript query returns stats; web summary line.
- Owner check after deploy: Test a record → Talk in browser; say "mm-hmm" mid-sentence (keeps going), "wait, hold on" (stops), go quiet (checks in once, then goodbye); read the response-time line.

## 7. Out of scope

Ducking; per-phase eagerness; transcription keywords/prompt; GPT-Live; fake-seller tests (next spec); AI-side backchannels ("mm-hmm" from the agent).
