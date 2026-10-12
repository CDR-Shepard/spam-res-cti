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

**Known limit:** words arrive ~1 s after the caller starts, so a real interruption stops the agent ~1.0–1.3 s in (today: ~0.3 s, but also on every "mm-hmm"). Humans take ~0.5–1 s to yield. If this feels long in testing, the follow-up is **ducking** (lower the agent's volume during an undecided overlap by re-sending the unplayed audio quieter) — not in this spec.

### 4.2 Silence

- **`wait_for_user` tool** (no parameters). The model calls it when what it heard wasn't meant for it (TV, someone else in the room, noise) or the person asked it to hold on (after a short "Sure, take your time"). The bridge answers it itself (`{"ok":true}`, never reaches the call service) and does **not** ask the agent to speak.
- **Silence check-ins.** Once the agent has finished speaking and is waiting (no response, not closing, opener already played), a timer starts: 8 s normally, 30 s after `wait_for_user`. On fire: transcript note `[no answer for 8 s]`, a hidden note `(No one has said anything for 8 seconds.)` and a response. The prompt: first note → a short check-in ("Hey — are you still there?"); second note → quick goodbye → `end_call` (`hung_up`). The bridge sends at most 2 notes until the caller speaks again. Any caller speech or response cancels the timer.

### 4.3 Response-time numbers

Per caller turn the agent answers:
- `endpointMs` — how long after the caller actually stopped the turn was declared over: (caller audio sent to OpenAI so far, in ms, when `speech_stopped` arrives) − `audio_end_ms`. Assumes no early caller audio was dropped by the outbox (it already logs a warning when it does).
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

## 5. Config

| Var (cti-api) | Default | Notes |
|---|---|---|
| `AI_VOICE_BARGE_IN` | `gate` | `instant` = today's behaviour |
| `AI_VOICE_TRANSCRIBE_MODEL` | gate: `gpt-live-transcribe`; instant: `gpt-4o-mini-transcribe` | Unset follows `AI_VOICE_BARGE_IN`, so `instant` alone also restores today's transcriber; a value set explicitly wins in either mode. Without streaming words the gate degrades to "stop after 3 s" (a short wordless sound is still ignored once the caller stops) |

`AI_VOICE_VAD_EAGERNESS` (exists, `auto`) stays the knob for the ~1.6 s end-of-turn wait; tune it from the new numbers, not in this spec.

## 6. Testing

- Pure units: word classifier (table-driven), overlap gate (fake clock), silence timer, stats (percentiles).
- `bridge.test.ts` (fake sockets, existing harness): mm-hmm keeps audio flowing and never answers; "wait hold on" clears + cancels + truncates and answers after commit; 3 words interrupt; no-words fallback at 3 s (a short wordless sound is ignored once the caller stops); late overlap answered after drain; opener never cut; in-flight response with no audio cancelled; `requestResponse` never double-creates (tool batch + caller turn); `instant` mode byte-for-byte today's frames; silence notes (8 s, 30 s after `wait_for_user`, max 2); stats end up in `onEnd`.
- Prompt snapshot updated; migration test; outreach-api transcript query returns stats; web summary line.
- Owner check after deploy: Test a record → Talk in browser; say "mm-hmm" mid-sentence (keeps going), "wait, hold on" (stops), go quiet (checks in once, then goodbye); read the response-time line.

## 7. Out of scope

Ducking; per-phase eagerness; transcription keywords/prompt; GPT-Live; fake-seller tests (next spec); AI-side backchannels ("mm-hmm" from the agent).
