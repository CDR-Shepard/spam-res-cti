# AI calls speak with an ElevenLabs voice

**Date:** 2026-10-19 · **Owner decision:** "A" (keep our phone bridge, swap the voice) after an ear test in ElevenLabs; voice
"Siren - Natural realistic conversational voice" (`eXpIbVcVbLo8ZJQDlDnl`).

## Why
The owner wants calls to sound like a person. Twenty-plus prompt rounds left "Natural" flat (~6.2–6.5/10); the
OpenAI voice itself is part of the ceiling. ElevenLabs voices are the most natural the owner has heard.

## What changes
Behind a switch, `AI_VOICE_TTS=elevenlabs` (default `openai` = today, byte for byte):
- The OpenAI Realtime session keeps doing what it does now: hears the caller (audio in, VAD, transcription), thinks,
  and calls tools. It answers in **text** instead of audio (`output_modalities: ['text']`).
- A socket layer (`external-voice.ts`) sits between the bridge and the OpenAI socket. It streams each response's text
  to ElevenLabs (multi-context WebSocket, one context per response item, `ulaw_8000` = Twilio's format) and hands the
  bridge ElevenLabs' audio as if OpenAI had sent it (`response.output_audio.delta`). The response's `response.done` is
  held until its audio has finished, so every bridge rule that reads "did the agent speak" (the goodbye guard, the
  drain before hanging up, turn timing, the barge-in gate) works unchanged.
- Barge-in: the bridge's `conversation.item.truncate` cannot cut a text item, so the layer stops the ElevenLabs
  context instead (no more audio) and drops the truncate. The model may believe it said the whole line (accepted for
  v1; v2 can rewrite the item to what was heard, using ElevenLabs' character timings).
- If ElevenLabs fails mid-call, the layer switches the session back to OpenAI audio (`output_modalities: ['audio']`)
  and the call carries on in the OpenAI voice; it never leaves the caller in silence. A line the caller heard none of
  (e.g. the opener, with its AI disclosure, when credit runs out) is deleted from the conversation, with any tool call
  in the same response, and OpenAI is asked again with the same request, now in its own voice; the bridge only ever
  sees the spoken one. A line partly heard ends there, like a barge-in.
- A response OpenAI ends without finishing a line: a completed one is spoken to its end, any other is stopped. Text
  OpenAI still writes for a response the bridge cancelled is never spoken.
- Gate barge-in only: with `AI_VOICE_BARGE_IN=instant` (OpenAI starts and cuts responses itself) the call uses the
  OpenAI voice and logs a warning.
- Known gap: two spoken lines in one response may overlap (rare; logged as a warning).
- Applies to outbound and inbound calls (same bridge). The voicemail message is unchanged (it is a Twilio `<Say>`).

## How the voice is fed (`elevenlabs-tts.ts`)
- One socket per call, opened when the call starts so the opener has no connect delay; one context per agent line
  (the OpenAI item id), first message carrying the voice settings from the ear test (stability 0.5, similarity 0.75).
- Each sentence goes out as soon as it is written, with `flush` (ElevenLabs' advice for agents), so the first sentence
  is spoken while the rest is still being written. Titles and street abbreviations ("Mr.", "St.") and spoken pauses
  ("six one nine... five five five") are not sentence ends.
- A line ends with `flush` + `close_context`; ElevenLabs' `isFinal` marks it done. No `isFinal` within 10 s fails the
  voice (falls back to OpenAI) so a call never hangs on a silent line.
- The socket idles out after 180 s (ElevenLabs' maximum); an idle close is not a failure, the next line reconnects. A
  close before it opened (bad key, no credit), while a line is in progress, or an error message fails the voice.
- The key goes in the `xi-api-key` header, never the URL.

## Settings (Railway, @cti/api)
- `AI_VOICE_TTS` = `openai` | `elevenlabs` (default `openai`). `elevenlabs` without `ELEVENLABS_API_KEY` falls back to
  `openai` with a warning (a typo must not take calls down).
- `ELEVENLABS_API_KEY` (secret), `AI_VOICE_ELEVENLABS_VOICE` (default Siren), `AI_VOICE_ELEVENLABS_MODEL` (default
  `eleven_v4_turbo`, the model of the ear test; the latency spike confirms it on the socket, else `eleven_flash_v2_5`).

## Not in this change
- Swapping the brain to Claude (what the owner heard in the browser test): a later step.
- ElevenLabs expressive audio tags ([warmly], [chuckles]).

## Checks before real calls use it
1. Latency spike on the live API: first audio after the caller stops, against today's.
2. A phone-quality clip of Siren for the owner.
3. Simulated calls through the API sim, then a test call to the owner's phone.
