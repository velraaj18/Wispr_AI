$(document).ready(function () {
  let isListening = false;
  let mediaStream = null;
  let audioContext;
  let mediaStreamSource;
  let audioProcessor;
  let socket;
  let sampleBuffer = [];

  const WISPR_AI_API_KEY = "Need to get API key";
  const BUFFER_SIZE = 2400;
  const INPUT_SAMPLE_RATE = 48000;
  const TARGET_SAMPLE_RATE = 16000;

  //------------------------------------------------------
  // Wispr Flow requires packets of consistent duration.
  // At 16kHz, BUFFER_SIZE (2400) resamples down to 800
  // samples = 0.05 seconds per packet.
  // We batch 20 packets before each send = 1 second of
  // audio per append message, which is what Wispr recommends.
  //------------------------------------------------------
  const PACKET_DURATION_SECONDS = 800 / TARGET_SAMPLE_RATE; // 0.05s
  const BATCH_SIZE = 20; // packets per append message = ~1 second

  // Wispr Flow requires tracking how many packets we've sent
  // to correctly set the position field in append messages.
  let totalPacketsSent = 0;

  // Staging area: hold packets + volumes until we have a full batch.
  let pendingPackets = [];
  let pendingVolumes = [];

  $("#micButton").click(async function () {
    if (!isListening) {
      try {
        // Create a media stream
        // This is where the browser asks for the permssion of user for microphone access
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });

        // Connect to Wispr Flow BEFORE audio starts
        // So that we don't lose any audio samples
        connectWispr();

        // Create a browser audio engine to process the audio from media stream
        audioContext = new AudioContext();
        sampleBuffer = [];
        $("#sampleRate").text(audioContext.sampleRate);

        // Convert the media stream into Audio node
        mediaStreamSource = audioContext.createMediaStreamSource(mediaStream);

        // Load our custom audio processor
        // The audio processor needs to be placed externally and added here
        await audioContext.audioWorklet.addModule("audioProcessorWorklet.js");

        // Create an instance of the audio processor
        audioProcessor = new AudioWorkletNode(audioContext, "audio-processor");

        // Connect microphone node to the processor node
        mediaStreamSource.connect(audioProcessor);

        // Receive audio samples from the worklet (Audio Processor)
        // Process and Stage them to send to Wispr AI Socket API
        audioProcessor.port.onmessage = async function (event) {
          console.log(event);
          if (event.data.type !== "audio") return;
          sampleBuffer.push(...event.data.samples);
          $("#bufferedSamples").text(sampleBuffer.length);

          // audio processor send tiny chunks of 128 samples, we wait until it reaches the buffer_size
          // We don't want to send tiny 128-sample packets to Wispr — it's inefficient. So we hold off until we've accumulated enough samples.
          if (sampleBuffer.length < BUFFER_SIZE) return;

          // splice(0, BUFFER_SIZE) removes exactly BUFFER_SIZE samples from the front of the buffer and returns them as packet. Anything beyond that stays in sampleBuffer and rolls over to the next cycle.
          const packet = sampleBuffer.splice(0, BUFFER_SIZE);
          const volume = calculateVolume(packet);
          $("#volumeBar").val(volume * 100);

          // Resample 48khz -> 16khz using existing methods
          const resampledPacket = await resampleAudio(packet);

          // Convert the Float32 binary bits into Int16 binary
          const int16Packet = convertToInt16(resampledPacket);

          // Wispr Flow requires base64 encoded PCM (Deepgram can directly use Int16 binary packet)
          const base64Packet = convertToBase64(int16Packet);

          // Stage packet + its volume for the next batch send.
          pendingPackets.push(base64Packet);
          pendingVolumes.push(volume);

          // Only send to Wispr once we've collected a full batch.
          // This keeps audio chunks at a consistent ~1 second duration, which Wispr requires for stable results.
          if (pendingPackets.length >= BATCH_SIZE) {
            flushToWispr();
          }
        };

        isListening = true;
        $(".inputContainer").addClass("is-listening");
        $("#micButton").text("⏹");
        $("#status").text("🔴 Recording...");
      } catch (error) {
        console.error(error);
        $("#status").text("❌ Permission Denied");
      }
    } else {
      // Flush any remaining staged packets before stopping, so the last partial second of speech isn't dropped.
      if (pendingPackets.length > 0) {
        flushToWispr();
      }

      // COMMIT: tell Wispr the audio stream is complete and
      // how many total packets we sent. The server uses this to finalize and return the last transcription result.
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "commit",
            total_packets: totalPacketsSent,
          }),
        );
      }
      
      // Stop every microphone track
      mediaStream.getTrack().forEach((element) => {
        element.stop();
      });

      await audioContext.close();

      audioContext = null;
      mediaStream = null;
      mediaStreamSource = null;
      isListening = false;
      $(".inputContainer").removeClass("is-listening");

      $("#micButton").text("🎤");
      $("#status").text("Processing...");
    }
  });

  //------------------------------------------------------
  // Open a WebSocket connection to Wispr Flow and wire up
  // all the message handlers.
  //
  // Wispr's protocol has three phases:
  //   1. Connect → server sends auth confirmation
  //   2. Stream  → we send append messages with audio batches
  //   3. Commit  → we signal end of audio, server finalizes
  //------------------------------------------------------
  function connectWispr() {
    // Reset counters for each new session.
    totalPacketsSent = 0;
    pendingPackets = [];
    pendingVolumes = [];

    socket = new WebSocket(
      `wss://platform-api.wisprflow.ai/api/v1/dash/ws?api_key=Bearer%20${WISPR_API_KEY}`,
    );

    socket.onopen = () => {
      // The first message MUST be an auth message.
      // Optional context fields improve transcription quality —
      // set app.type to "ai" since this is an AI chat interface.
      socket.send(
        JSON.stringify({
          type: "auth",
          access_token: WISPR_API_KEY,
          language: ["en"],
          context: {
            app: {
              name: "Voice Prompt Demo",
              type: "ai",
            },
          },
        }),
      );

      $("#status").text("🟢 Connected to Wispr");
    };

    socket.onmessage = (event) => {
      const response = JSON.parse(event.data);
      if (response.status == "auth") {
        // Auth confirmed — audio can now flow.
        console.log("Wispr auth confirmed");
      } else if (response.status === "text") {
        // Partial results arrive roughly every 30 seconds
        // during long recordings. The final result arrives
        // after we send commit (response.final === true).
        const text = response.body?.text;

        if (text) {
          $("#promptInput").val(text);
        }

        if (response.final) {
          $("#status").text("✅ Done");
          $(".inputContainer").removeClass("is-listening");
          socket.close();
          socket = null;
        }
      } else if (response.status === "info") {
        // Commit acknowledged — server is processing.
        console.log("Wispr info:", response.message);
      } else if (response.status === "error") {
        // Wispr closes the socket on unrecoverable errors.
        console.error("Wispr error:", response);
        $("#status").text("❌ Wispr error");
      }
    };

    socket.onerror = (error) => {
      console.error("Wispr socket error:", error);
      $("#status").text("❌ Connection error");
    };

    socket.onclose = () => {
      console.log("Wispr socket closed");
    };
  }

  //------------------------------------------------------
  // Send all staged packets to Wispr as a single append
  // message, then reset the staging arrays.
  //
  // position = total packets sent before this batch.
  // Wispr uses this to reconstruct audio order on the server.
  //------------------------------------------------------
  function flushToWispr() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (pendingPackets.length === 0) return;

    socket.send(
      JSON.stringify({
        type: "append",
        position: totalPacketsSent,
        audio_packets: {
          packets: pendingPackets,
          volumes: pendingVolumes,
          packet_duration: PACKET_DURATION_SECONDS,
          audio_encoding: "wav",
          byte_encoding: "base64",
        },
      }),
    );

    totalPacketsSent += pendingPackets.length;
    pendingPackets = [];
    pendingVolumes = [];
  }

  // Calculate microphone loudness using Root Mean Square.
  // Returns 0 (silence) to 1 (maximum volume).
  function calculateVolume(samples) {
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    return Math.sqrt(sum / samples.length);
  }

  //------------------------------------------------------
  // Resample audio from 48kHz to 16kHz.
  // Browser records at 48kHz; Wispr expects 16kHz.
  //------------------------------------------------------
  async function resampleAudio(samples) {
    const offlineContext = new OfflineAudioContext(
      1,
      (samples.length * TARGET_SAMPLE_RATE) / INPUT_SAMPLE_RATE,
      TARGET_SAMPLE_RATE,
    );

    const buffer = offlineContext.createBuffer(
      1,
      samples.length,
      INPUT_SAMPLE_RATE,
    );
    buffer.copyToChannel(new Float32Array(samples), 0);

    const source = offlineContext.createBufferSource();
    source.buffer = buffer;
    source.connect(offlineContext.destination);
    source.start();

    const renderedBuffer = await offlineContext.startRendering();
    return renderedBuffer.getChannelData(0);
  }

  //------------------------------------------------------
  // Convert Float32 (-1 to 1) into Int16 (-32768 to 32767).
  // Wispr expects 16-bit PCM audio.
  //------------------------------------------------------
  function convertToInt16(samples) {
    const int16Samples = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      int16Samples[i] = sample < 0 ? sample * 32768 : sample * 32767;
    }
    return int16Samples;
  }

  //------------------------------------------------------
  // Convert Int16Array into Base64.
  // Wispr requires base64-encoded PCM (unlike Deepgram
  // which accepted raw binary WebSocket frames).
  //------------------------------------------------------
  function convertToBase64(int16Samples) {
    const bytes = new Uint8Array(int16Samples.buffer);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
});
