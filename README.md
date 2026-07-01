# Voice Transcription Integration Guide: Deepgram vs Wispr Flow

## Table of Contents
1. [Quick Comparison](#quick-comparison)
2. [Deepgram Setup & Integration](#deepgram-setup--integration)
3. [Wispr Flow Setup & Integration](#wispr-flow-setup--integration)
4. [Code Differences](#code-differences)
5. [Functionality Differences](#functionality-differences)
6. [Language Support](#language-support)
7. [Implementation Checklist](#implementation-checklist)

---

## Quick Comparison

| Feature | Deepgram | Wispr Flow |
|---------|----------|-----------|
| **Pricing** | Free $200 credit (12,000+ min transcription) | Free tier: 2,000 words/week; Pro: $15/month |
| **API Access** | Public, self-serve | Exclusive access only (enterprise@wisprflow.ai) |
| **Audio Format** | Raw binary PCM (Int16Array.buffer) | Base64-encoded PCM string |
| **WebSocket Auth** | Subprotocol header | Query string + auth JSON message |
| **Transcription Style** | Live word-by-word streaming | Batch results every ~30s, final after commit |
| **Setup Time** | 5 minutes | Contact required, approval needed |
| **Best For** | Real-time captions, live feedback | Polished final text, developer apps |
| **Model Quality** | Nova 3 (latest, high accuracy) | General + enterprise LLM correction |

---

## Deepgram Setup & Integration

### Step 1: Create a Free Account

1. Go to [console.deepgram.com/signup](https://console.deepgram.com/signup)
2. Sign up with email (no credit card required)
3. You receive $200 free credit instantly
4. Navigate to **API Keys** in the console
5. Copy your API key (starts with `b5...` or similar)
6. Store it securely (never commit to Git)

### Step 2: Understand Deepgram's Architecture

Deepgram expects:
- **Sample Rate**: 16kHz (we resample 48kHz → 16kHz in the browser)
- **Encoding**: Linear 16-bit PCM (we convert Float32 → Int16)
- **Transport**: Raw binary frames over WebSocket (no base64 wrapper)
- **Model**: Nova 3 (specify in URL params)

### Step 3: WebSocket Connection

The socket opens directly with your API key in the subprotocol header:

```js
const DEEPGRAM_API_KEY = "YOUR_API_KEY";

socket = new WebSocket(
  "wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1&interim_results=true&model=nova-3",
  ["token", DEEPGRAM_API_KEY]  // ← API key goes here as subprotocol
);
```

### Step 4: Send Audio Data

Once connected, send raw binary Int16 PCM directly—no JSON wrapper, no base64:

```js
// After resampling and converting to Int16
const int16Packet = convertToInt16(resampledPacket);

// Send raw binary directly (this is the key difference)
if (socket && socket.readyState === WebSocket.OPEN) {
  socket.send(int16Packet.buffer);  // ← Raw ArrayBuffer, not encoded
}
```

### Step 5: Handle Responses

Deepgram streams results as they arrive. Each message includes interim and final transcripts:

```js
socket.onmessage = (message) => {
  const data = JSON.parse(message.data);
  const transcript = data.channel?.alternatives?.[0]?.transcript;
  const confidence = data.channel?.alternatives?.[0]?.confidence;
  const isFinal = data.is_final;

  if (transcript) {
    if (isFinal) {
      // Lock this chunk in permanently
      finalTranscript += transcript + " ";
      $("#promptInput").val(finalTranscript.trim());
    } else {
      // Show interim text temporarily (may change)
      $("#promptInput").val((finalTranscript + transcript).trim());
    }
  }
};
```

### Step 6: Stop Recording

Simply close the socket—Deepgram handles cleanup server-side:

```js
socket.close();
socket = null;
```

---

## Wispr Flow Setup & Integration

### Step 1: Request API Access

Wispr Flow API is not self-serve. You must contact them:

1. Email: **enterprise@wisprflow.ai**
2. Subject: "API Access Request for Web Integration"
3. Include:
   - Your organization name
   - Use case (voice input for web app, etc.)
   - Expected volume (words/month)
   - Timeline

4. Wait for approval (typically 1-2 weeks)
5. Once approved, log into [platform.wisprflow.ai](https://platform.wisprflow.ai)
6. Go to **API Keys > Create New Key**
7. Copy your API key (store securely)

### Step 2: Understand Wispr Flow's Architecture

Wispr Flow expects:
- **Sample Rate**: 16kHz (we resample 48kHz → 16kHz in the browser)
- **Encoding**: Linear 16-bit PCM encoded as **base64** string
- **Transport**: JSON-wrapped messages with position tracking
- **Format**: Each packet must have consistent duration (0.05s recommended)
- **Volume Data**: RMS volume for each packet (for UI feedback)

### Step 3: WebSocket Connection

The socket opens with the API key in the query string:

```js
const WISPR_API_KEY = "YOUR_WISPR_API_KEY";

socket = new WebSocket(
  `wss://platform-api.wisprflow.ai/api/v1/dash/ws?api_key=Bearer%20${WISPR_API_KEY}`
);
```

### Step 4: Send Auth Handshake (Required First Message)

Unlike Deepgram, Wispr requires an `auth` message immediately after connection, before any audio:

```js
socket.onopen = () => {
  socket.send(JSON.stringify({
    type: "auth",
    access_token: WISPR_API_KEY,
    language: ["en"],
    context: {
      app: {
        name: "Voice Prompt Demo",
        type: "ai"  // or "dictation", "meeting", etc.
      }
    }
  }));
};
```

### Step 5: Batch and Send Audio in Chunks

Wispr Flow requires audio in batches (typically 20 packets per batch = ~1 second of audio). Each packet must be:
- **Base64-encoded** (not raw binary)
- **Consistent duration** (0.05s per packet at 16kHz = 800 samples)
- **Volume tracked** (RMS value per packet)

```js
// Stage packets until we have 20
let pendingPackets = [];
let pendingVolumes = [];
const BATCH_SIZE = 20;

// When a new packet arrives
const int16Packet = convertToInt16(resampledPacket);
const base64Packet = convertToBase64(int16Packet);  // ← Must encode to base64
const volume = calculateVolume(packet);

pendingPackets.push(base64Packet);
pendingVolumes.push(volume);

// When batch is full, send it
if (pendingPackets.length >= BATCH_SIZE) {
  socket.send(JSON.stringify({
    type: "append",
    position: totalPacketsSent,  // ← Wispr tracks position for ordering
    audio_packets: {
      packets: pendingPackets,
      volumes: pendingVolumes,
      packet_duration: 0.05,        // seconds
      audio_encoding: "wav",
      byte_encoding: "base64"
    }
  }));

  totalPacketsSent += pendingPackets.length;
  pendingPackets = [];
  pendingVolumes = [];
}
```

### Step 6: Commit the Audio Stream

When you stop recording, send a `commit` message with the total packet count:

```js
socket.send(JSON.stringify({
  type: "commit",
  total_packets: totalPacketsSent
}));
```

Wispr will then return the final polished transcript and close the connection.

### Step 7: Handle Responses

Wispr sends responses with a `status` field. Watch for `text` status messages:

```js
socket.onmessage = (event) => {
  const response = JSON.parse(event.data);

  if (response.status === "auth") {
    console.log("Auth confirmed, ready for audio");

  } else if (response.status === "text") {
    const transcript = response.body?.text;
    $("#promptInput").val(transcript);

    if (response.final) {
      console.log("Final result received");
      socket.close();
    }

  } else if (response.status === "error") {
    console.error("Wispr error:", response);
  }
};
```

---

## Code Differences

### Audio Format Conversion

Both require the same conversion chain (Float32 → Int16), but diverge on the final step:

```js
// ✅ Both: Float32 (-1.0 to 1.0) → Int16 (-32768 to 32767)
function convertToInt16(samples) {
  const int16Samples = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    int16Samples[i] = sample < 0 ? sample * 32768 : sample * 32767;
  }
  return int16Samples;
}

// ✅ Both: 48kHz → 16kHz resampling (identical)
async function resampleAudio(samples) {
  const offlineContext = new OfflineAudioContext(
    1,
    (samples.length * 16000) / 48000,
    16000
  );
  const buffer = offlineContext.createBuffer(1, samples.length, 48000);
  buffer.copyToChannel(new Float32Array(samples), 0);
  const source = offlineContext.createBufferSource();
  source.buffer = buffer;
  source.connect(offlineContext.destination);
  source.start();
  const renderedBuffer = await offlineContext.startRendering();
  return renderedBuffer.getChannelData(0);
}

// ❌ Deepgram: Send raw binary directly
socket.send(int16Packet.buffer);

// ✅ Wispr: Encode to base64 first
function convertToBase64(int16Samples) {
  const bytes = new Uint8Array(int16Samples.buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);  // ← Wispr-only step
}
const base64Packet = convertToBase64(int16Packet);
socket.send(JSON.stringify({ type: "append", packets: [base64Packet] }));
```

### Message Structure

```js
// ✅ Deepgram: Raw binary frame (simplest)
socket.send(int16Packet.buffer);

// Response JSON (flat)
{
  "is_final": false,
  "speech_final": false,
  "channel": {
    "alternatives": [{ "transcript": "hello", "confidence": 0.98 }]
  }
}

// ✅ Wispr: Wrapped JSON with metadata (more complex)
socket.send(JSON.stringify({
  type: "append",
  position: 0,
  audio_packets: {
    packets: ["AQIDBAUGBw=="],  // base64 array
    volumes: [0.15, 0.18],
    packet_duration: 0.05,
    audio_encoding: "wav",
    byte_encoding: "base64"
  }
}));

// Response JSON (status-based)
{
  "status": "text",
  "final": true,
  "body": { "text": "hello world" }
}
```

### Session Lifecycle

```js
// ✅ Deepgram (simple)
// 1. Open WebSocket
// 2. Send audio frames continuously
// 3. Close socket
// Done.

// ✅ Wispr (structured)
// 1. Open WebSocket
// 2. Send auth message (required first)
// 3. Batch audio into append messages
// 4. Send commit message (required last)
// 5. Wait for final result
// 6. Server closes socket
```

### Key Differences Table

| Aspect | Deepgram | Wispr Flow |
|--------|----------|-----------|
| **Auth Timing** | Inline with URL params (subprotocol header) | Explicit JSON message after `onopen` |
| **Audio Encoding** | Raw binary ArrayBuffer | Base64-encoded string in JSON |
| **Message Wrapping** | Direct buffer send, no JSON | Full JSON envelope with metadata |
| **Session Handshake** | None required | Mandatory `auth` message first |
| **Session Termination** | Client closes socket | Client sends `commit`, server closes |
| **Packet Batching** | Not required (individual frames OK) | Required (batch 20 packets minimum) |
| **Volume Tracking** | Not sent to API | Required per packet in `append` |
| **Position Tracking** | Not needed by API | Required (`position` field) |
| **Response Format** | Flat JSON with `is_final` flag | Nested JSON with `status` field |

---

## Functionality Differences

| Aspect | Deepgram | Wispr Flow |
|--------|----------|-----------|
| **Transcription Timing** | Real-time (word-by-word as you speak) | Batch (final result after you stop) |
| **Interim Results** | Yes, streamed continuously via `is_final: false` | Partial every ~30s during long recordings |
| **Accuracy Correction** | Model-based only (Nova 3 is very accurate) | Cloud transcription + LLM post-processing for context |
| **Latency** | 200-500ms per word (streaming overhead) | 2-5 second delay total (batch + LLM pass) |
| **Use Cases** | Live captions, real-time feedback, chat | Polished final text, documentation, emails |
| **Volume Data** | Not provided | Provided per packet (RMS value) |
| **Position Tracking** | Not needed | Required (each batch has position number) |
| **Language Switching** | Mid-stream (specify in URL) | Declared in auth message, consistent per session |
| **Cost Model** | Per minute of audio | Per word of output |
| **Offline Fallback** | None (cloud-only) | None (cloud-only) |
| **Error Handling** | Connection drops with descriptive error | Status messages include error details |
| **Confidence Scores** | Provided per alternative | Not provided in response |

---

## Language Support

### Deepgram Supported Languages

Deepgram's Nova 3 model supports comprehensive language coverage:

**Major Languages (Highest Accuracy)**
- English (US, UK, Indian, Australian dialects)
- Spanish (Spain, Latin America)
- French (France, Canadian)
- German
- Italian
- Portuguese (Brazil, Portugal)
- Dutch
- Polish
- Russian
- Japanese
- Mandarin Chinese
- Korean

**Additional Supported Languages**
- Arabic (Modern Standard, Egyptian, Gulf)
- Hindi
- Turkish
- Swedish
- Danish
- Norwegian
- Finnish
- Greek
- Czech
- Hungarian
- Romanian
- Thai
- Vietnamese
- Indonesian
- Tagalog
- Urdu
- Hebrew

**Total: 30+ languages with high accuracy**

**Specify in WebSocket URL:**
```js
const languageCode = "es";  // Spanish
const socket = new WebSocket(
  `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&language=${languageCode}&model=nova-3`,
  ["token", DEEPGRAM_API_KEY]
);

// Supported language codes:
// en (English), es (Spanish), fr (French), de (German), it (Italian),
// pt (Portuguese), nl (Dutch), pl (Polish), ru (Russian), ja (Japanese),
// zh (Mandarin), ko (Korean), ar (Arabic), hi (Hindi), tr (Turkish),
// sv (Swedish), da (Danish), no (Norwegian), fi (Finnish), el (Greek),
// cs (Czech), hu (Hungarian), ro (Romanian), th (Thai), vi (Vietnamese),
// id (Indonesian), tl (Tagalog), ur (Urdu), he (Hebrew)
```

### Wispr Flow Supported Languages

Wispr Flow supports 100+ languages with tiered accuracy levels:

**Tier 1 - Highest Accuracy (Full AI Enhancement)**
- English (US, UK, Indian, Australian)
- Spanish (Spain, Mexico, Latin America)
- French (France, Canada)
- German
- Italian
- Portuguese (Brazil, Portugal)
- Dutch
- Japanese
- Mandarin Chinese
- Korean

**Tier 2 - Good Accuracy (Full Support)**
- Russian
- Polish
- Turkish
- Swedish
- Danish
- Norwegian
- Finnish
- Greek
- Czech
- Hungarian
- Romanian
- Arabic (Modern Standard, Egyptian, Gulf)
- Hebrew
- Thai
- Vietnamese
- Indonesian
- Tagalog
- Hindi
- Urdu
- Punjabi
- Bengali
- Telugu
- Marathi
- Gujarati
- Tamil
- Kannada
- Afrikaans
- Croatian
- Serbian
- Ukrainian
- Bulgarian
- Slovak
- Slovenian
- Lithuanian
- Latvian
- Estonian

**Tier 3 - Supported Languages (Limited Accuracy)**
- Amharic
- Armenian
- Azerbaijani
- Basque
- Belarusian
- Bosnian
- Catalan
- Esperanto
- Galician
- Georgian
- Hausa
- Icelandic
- Igbo
- Irish
- Javanese
- Kannada
- Khmer
- Kurdish
- Kyrgyz
- Lao
- Lithuanian
- Luxembourgish
- Macedonian
- Malay
- Maltese
- Maori
- Mongolian
- Myanmar
- Nepali
- Pashto
- Persian
- Swahili
- Sundanese
- Tatar
- Telegu
- Tibetan
- Tigrinya
- Turkmen
- Twi
- Uighur
- Uzbek
- Welsh
- Xhosa
- Yiddish
- Yoruba
- Zulu

**Total: 100+ languages supported**

**Specify in Auth Message:**
```js
// Single language
socket.send(JSON.stringify({
  type: "auth",
  access_token: WISPR_API_KEY,
  language: ["es"],  // Spanish only
  context: { app: { name: "My App", type: "ai" } }
}));

// Auto-detection across multiple languages
socket.send(JSON.stringify({
  type: "auth",
  access_token: WISPR_API_KEY,
  language: ["en", "es", "fr"],  // Will auto-detect among these
  context: { app: { name: "My App", type: "ai" } }
}));

// Supported language codes:
// en, es, fr, de, it, pt, nl, pl, ru, ja, zh, ko, ar, hi, tr,
// sv, da, no, fi, el, cs, hu, ro, th, vi, id, tl, ur, pa, bn,
// te, mr, gu, ta, kn, af, hr, sr, uk, bg, sk, sl, lt, lv, et,
// am, hy, az, eu, be, bs, ca, eo, gl, ka, ha, is, ig, ga, jv,
// kk, km, ku, ky, lo, lb, mk, ms, mt, mi, mn, my, ne, ps, fa,
// sw, su, tt, tg, bo, ti, tk, tw, ug, uz, cy, xh, yi, yo, zu
```

**Language Auto-Detection**: When you specify multiple languages in the auth message, Wispr Flow will automatically detect which language is being spoken and apply the appropriate transcription model.

---

## Implementation Checklist

### For Deepgram

- [ ] Sign up at [console.deepgram.com](https://console.deepgram.com/signup) (free, no card required)
- [ ] Receive $200 free credit instantly
- [ ] Navigate to **API Keys** section
- [ ] Copy your API key
- [ ] Update `DEEPGRAM_API_KEY` constant in script.js
- [ ] Ensure `audioProcessorWorklet.js` is in the same directory as your HTML file
- [ ] Verify HTML imports jQuery and script.js correctly
- [ ] Test with browser microphone (grant permission when prompted)
- [ ] Open browser DevTools Console
- [ ] Click the 🎤 button and speak clearly
- [ ] Verify transcript appears in the input field
- [ ] Check Network tab (filter by WS) to confirm WebSocket frames are flowing
- [ ] Monitor Deepgram console to track credit usage
- [ ] Test multiple languages by updating the URL parameter

### For Wispr Flow

- [ ] Prepare API access request (organization name, use case, expected volume)
- [ ] Email **enterprise@wisprflow.ai** with access request
- [ ] Wait for approval email (typically 1-2 weeks)
- [ ] Log into [platform.wisprflow.ai](https://platform.wisprflow.ai) once approved
- [ ] Navigate to **API Keys** section
- [ ] Click **Create New Key**
- [ ] Copy your API key and store securely
- [ ] Update `WISPR_API_KEY` constant in script.js
- [ ] Ensure `audioProcessorWorklet.js` is in the same directory as your HTML file
- [ ] Verify HTML imports jQuery and script.js correctly
- [ ] Test with browser microphone (grant permission when prompted)
- [ ] Open browser DevTools Console
- [ ] Click the 🎤 button and speak clearly
- [ ] Verify auth confirmation in console: "Auth confirmed, ready for audio"
- [ ] Watch Network tab (filter by WS) to confirm auth message is sent first
- [ ] Confirm append messages are batched and sent approximately every 1 second
- [ ] Verify final transcript appears after hitting the ⏹ button
- [ ] Check that commit message is sent with correct total_packets count
- [ ] Test language auto-detection by updating the language array in auth

---

## Quick Start Code Reference

### Minimal Deepgram Integration
```js
const DEEPGRAM_API_KEY = "YOUR_KEY_HERE";

function connectDeepgram() {
  const socket = new WebSocket(
    "wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&model=nova-3",
    ["token", DEEPGRAM_API_KEY]
  );

  socket.onopen = () => console.log("Connected to Deepgram");
  
  socket.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    const text = data.channel?.alternatives?.[0]?.transcript;
    if (text) console.log(text);
  };

  return socket;
}
```

### Minimal Wispr Flow Integration
```js
const WISPR_API_KEY = "YOUR_KEY_HERE";

function connectWispr() {
  const socket = new WebSocket(
    `wss://platform-api.wisprflow.ai/api/v1/dash/ws?api_key=Bearer%20${WISPR_API_KEY}`
  );

  socket.onopen = () => {
    socket.send(JSON.stringify({
      type: "auth",
      access_token: WISPR_API_KEY,
      language: ["en"],
      context: { app: { name: "Demo", type: "ai" } }
    }));
  };

  socket.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.status === "text") console.log(data.body?.text);
  };

  return socket;
}
```

---

## Troubleshooting

### Deepgram Issues

**Problem**: Empty transcript with 0% confidence
- **Solution**: Switch to Nova 3 model by adding `&model=nova-3` to the URL
- **Solution**: Check microphone volume—ensure volume bar moves while speaking
- **Solution**: Speak clearly and closer to microphone

**Problem**: Connection closes immediately
- **Solution**: Verify API key is correct (no extra spaces)
- **Solution**: Ensure URL encoding is proper (especially spaces in model names)
- **Solution**: Check WebSocket is opened before audio starts flowing

**Problem**: No audio being sent
- **Solution**: Confirm audioProcessorWorklet.js exists in same directory
- **Solution**: Check browser console for permission errors
- **Solution**: Verify microphone permission was granted

### Wispr Flow Issues

**Problem**: "Auth not confirmed" error
- **Solution**: Ensure auth message is sent immediately in `socket.onopen`
- **Solution**: Verify API key format includes "Bearer " prefix in query string
- **Solution**: Check that language array is specified in auth message

**Problem**: No transcript appearing after stop
- **Solution**: Confirm commit message is sent with correct `total_packets` count
- **Solution**: Verify batches were being sent while recording
- **Solution**: Check Network tab to confirm append messages contain base64 data

**Problem**: Audio seems to be dropping
- **Solution**: Ensure BATCH_SIZE is 20 and packets are staged correctly
- **Solution**: Verify packet_duration is consistently 0.05 seconds
- **Solution**: Check volume array matches packets array length

---

## Performance Considerations

### Deepgram
- **Bandwidth**: ~100KB/min of audio (base64 encoded in streaming JSON)
- **Latency**: 200-500ms per word update
- **Memory**: Minimal (streams data continuously)
- **Best For**: Real-time applications, UI responsiveness is priority

### Wispr Flow
- **Bandwidth**: ~150KB/min of audio (base64 batches)
- **Latency**: 2-5 second total delay (batch collection + LLM pass)
- **Memory**: Slightly higher (batches audio in memory)
- **Best For**: Final output accuracy, LLM post-processing value

---

## Conclusion

- **Choose Deepgram** for immediate, real-time transcription with zero setup friction
- **Choose Wispr Flow** for polished, context-aware transcription when you can wait 2-5 seconds and have enterprise approval

Both services excel at their respective use cases. Start with Deepgram for prototyping, then evaluate Wispr Flow if your application needs the additional LLM enhancement and you can secure API access.

3605bd3b9ea266a826aeb7c85df97be0d983f186