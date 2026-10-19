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
  (e.g. the opener, with its AI disclosure, when credit runs out) is deleted from the conversation and OpenAI is asked
  again with the same request, now in its own voice; the bridge only ever sees the spoken one. A response with a tool
  call is not asked again: its unheard line is deleted and the tool runs once as the model decided (the bridge speaks
  after it; the goodbye guard asks for a goodbye before an end_call). If the caller cuts in first, the unheard
  response just ends. A line partly heard ends there, like a barge-in.
- A response OpenAI ends without finishing a line: a completed one is spoken to its end, any other is stopped. Text
  OpenAI still writes for a response the bridge cancelled is never spoken.
- Gate barge-in only: with `AI_VOICE_BARGE_IN=instant` (OpenAI starts and cuts responses itself) the call uses the
  OpenAI voice and logs a warning.
- Known gap: two spoken lines in one response may overlap (rare; logged as a warning).
- Applies to outbound and inbound calls (same bridge). The voicemail message is unchanged (it is a Twilio `<Say>`).

## Which ElevenLabs socket (measured live 2026-10-19)
ElevenLabs serves its v3/v4 models (eleven_v4_turbo, the ear test's) only on the **text-to-dialogue** socket
(`elevenlabs-dialogue.ts`), and the v2 models (eleven_flash_v2_5, eleven_turbo_v2_5) only on the **multi-context
text-to-speech** socket (`elevenlabs-tts.ts`); `externalVoiceFor` picks by model. The multi-context socket sends
`ulaw_8000`; the dialogue socket sends `pcm_16000`, made phone audio here (below). First audio after a flushed sentence
~0.24 s (v4 turbo, dialogue) and ~0.25–0.30 s (flash v2.5, multi-context). Shared socket handling and sentence cutting
live in `elevenlabs-socket.ts`.

The dialogue socket has no contexts and no way to stop a line: audio comes back in the order sentences were sent, each
followed by `is_final_audio_for_turn`, so a line is done when it is finished and each of its sentences is back; a cut
line's remaining audio is dropped as it arrives (the next line waits for it to drain: ~0.25 s measured). It names the
voice in its first message, and closes after 20 s without a message, so a keep-alive goes every 10 s.

## How the voice is fed (multi-context socket, `elevenlabs-tts.ts`)
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

## What the phone gets (after the owner's test calls, 2026-10-19)
- First call: crackle on Sam's s/t/k sounds and stutters at line starts. The dialogue socket now sends 16 kHz PCM,
  low-passed at 3.4 kHz and made 8 kHz μ-law here (`phone-audio.ts`); a line's first 250 ms is held and sent as one
  piece; a line's first words go out at its first comma.
- Second call: Sam cut in and out on the phone, though the same audio played clean as a file. The OpenAI voice arrives
  in 400 ms pieces (whole 20 ms phone frames) and plays fine at the same overall burst rate; ElevenLabs' pieces are any
  size (13 ms to ~1 s). Both clients now hand the bridge whole 20 ms frames only (`wholeFrames`): a piece's part frame
  waits for the next piece, and a line's last one is filled out with silence (at most 20 ms). If Sam still cuts out,
  the next step is pacing the frames to Twilio in real time (the fix one OpenAI forum report gives for skipped words).

## Settings (Railway, @cti/api)
- `AI_VOICE_TTS` = `openai` | `elevenlabs` (default `openai`). `elevenlabs` without `ELEVENLABS_API_KEY` falls back to
  `openai` with a warning (a typo must not take calls down).
- `ELEVENLABS_API_KEY` (secret), `AI_VOICE_ELEVENLABS_VOICE` (default Siren), `AI_VOICE_ELEVENLABS_MODEL` (default
  `eleven_v4_turbo`, the model of the ear test; `eleven_flash_v2_5` is the tested alternative).

## Not in this change
- Swapping the brain to Claude (what the owner heard in the browser test): a later step.
- ElevenLabs expressive audio tags ([warmly], [chuckles]).

## Checks before real calls use it
1. Latency spike on the live API: first audio after the caller stops, against today's.
2. A phone-quality clip of Siren for the owner.
3. Simulated calls through the API sim, then a test call to the owner's phone.
