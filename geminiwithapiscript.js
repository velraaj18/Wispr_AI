$(document).ready(function () {
  let isListening = false;
  let mediaStream = null;
  let audioContext;
  let mediaStreamSource;
  let audioProcessor;
  let socket = null; // WebSocket connection to Deepgram

  const INPUT_SAMPLE_RATE = 48000;
  const TARGET_SAMPLE_RATE = 16000;
  const BUFFER_SIZE = 2400;

  let sampleBuffer = [];

  $("#micButton").click(async function () {
    // if we are not currently listening start the microphone
    if (!isListening) {
      try {
        //------------------------------------------------------
        // STEP 1
        // Ask browser permission to use the microphone.
        //------------------------------------------------------
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });

        //------------------------------------------------------
        // STEP 1.5
        // Open a WebSocket connection to Deepgram BEFORE audio
        // starts flowing, so we don't drop early samples.
        // encoding=linear16 + sample_rate=16000 tells Deepgram
        // exactly what format we will be sending it.
        //------------------------------------------------------
        connectGemini();

        //------------------------------------------------------
        // STEP 2
        // Create browser's audio engine
        //------------------------------------------------------
        audioContext = new AudioContext();
        sampleBuffer = [];
        $("#sampleRate").text(audioContext.sampleRate);

        //------------------------------------------------------
        // STEP 3
        // Convert MediaStream into an Audio Node.
        //------------------------------------------------------
        mediaStreamSource = audioContext.createMediaStreamSource(mediaStream);

        //------------------------------------------------------
        // STEP 4
        // Load our custom audio processor
        //------------------------------------------------------
        await audioContext.audioWorklet.addModule("audioProcessorWorklet.js");

        //------------------------------------------------------
        // STEP 5
        // Create an instance of our processor
        //------------------------------------------------------
        audioProcessor = new AudioWorkletNode(audioContext, "audio-processor");

        //------------------------------------------------------
        // STEP 6
        // Connect microphone to the processor
        //------------------------------------------------------
        mediaStreamSource.connect(audioProcessor);

        //------------------------------------------------------
        // STEP 7
        // Receives audio samples from the Audio processor worklet
        //------------------------------------------------------
        audioProcessor.port.onmessage = async function (event) {
          if (event.data.type !== "audio") return;
          sampleBuffer.push(...event.data.samples);

          $("#bufferedSamples").text(sampleBuffer.length);

          if (sampleBuffer.length < BUFFER_SIZE) return;

          const packet = sampleBuffer.splice(0, BUFFER_SIZE);
          const volume = calculateVolume(packet);
          $("#volumeBar").val(volume * 100);

          //------------------------------------------------------
          // Convert browser audio (48kHz) into Deepgram audio (16kHz).
          //------------------------------------------------------
          const resampledPacket = await resampleAudio(packet);

          //------------------------------------------------------
          // Convert Float32 samples to 16-bit PCM.
          //------------------------------------------------------
          const int16Packet = convertToInt16(resampledPacket);

          //------------------------------------------------------
          // Send raw binary PCM straight to Deepgram over the
          // WebSocket. No base64 needed — WebSockets support
          // binary frames natively, and Deepgram expects raw
          // linear16 bytes, not base64 text.
          //------------------------------------------------------
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(int16Packet.buffer);
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
      //------------------------------------------------------
      // Stop every microphone track.
      //------------------------------------------------------
      mediaStream.getTracks().forEach((track) => {
        track.stop();
      });

      // destroy audio context
      await audioContext.close();

      // close the Deepgram socket cleanly
      if (socket) {
        socket.close();
        socket = null;
      }

      audioContext = null;
      mediaStream = null;
      mediaStreamSource = null;

      isListening = false;
      $(".inputContainer").removeClass("is-listening");
      $("#status").text("Stopped");
      $("#micButton").text("🎤");
    }
  });

  function connectGemini() {
    // Now connecting to the Python server instead of gemini directly
    let finalTranscript = "";

    socket = new WebSocket("ws://localhost:4000/ws/transcribe");

    socket.onopen = () => {
      $("#status").text("🟢 Connected to Gemini");
    };

    socket.onmessage = (message) => {
      const data = JSON.parse(message.data);

      // Handle user transcription
      if (data.type === "transcript" && data.role === "user") {
        console.log("User said:", data.text);

        if (data.is_final) {
          finalTranscript += data.text + " ";
          $("#promptInput").val(finalTranscript.trim());
        } else {
          $("#promptInput").val((finalTranscript + data.text).trim());
        }
      }

      // Handle assistant response
      if (data.type === "response" && data.role === "assistant") {
        console.log("Gemini said:", data.text);
        // Display AI response if needed
        $("#response").text(data.text);
      }

      // Handle errors
      if (data.type === "error") {
        $("#status").text("❌ " + data.message);
      }

      // Handle status
      if (data.type === "status") {
        $("#status").text(data.message);
      }
    };

    socket.onerror = (error) => {
      console.error("Socket error:", error);
      $("#status").text("❌ Connection error");
    };

    socket.onclose = () => {
      console.log("Socket closed");
    };
  }

  //------------------------------------------------------
  // Calculate microphone loudness using RMS.
  // Returns:
  // 0 = Silence
  // 1 = Maximum volume
  //------------------------------------------------------
  function calculateVolume(samples) {
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    return Math.sqrt(sum / samples.length);
  }

  //------------------------------------------------------
  // Resample audio from 48kHz to 16kHz.
  //
  // Browser records at 48kHz.
  // Deepgram expects 16kHz.
  //------------------------------------------------------
  async function resampleAudio(samples) {
    //--------------------------------------------------
    // Create an offline audio engine for conversion.
    //--------------------------------------------------
    const offlineContext = new OfflineAudioContext(
      1,
      (samples.length * TARGET_SAMPLE_RATE) / INPUT_SAMPLE_RATE,
      TARGET_SAMPLE_RATE,
    );

    //--------------------------------------------------
    // Create a buffer using the original sample rate.
    //--------------------------------------------------
    const buffer = offlineContext.createBuffer(
      1,
      samples.length,
      INPUT_SAMPLE_RATE,
    );
    buffer.copyToChannel(new Float32Array(samples), 0);

    //--------------------------------------------------
    // Play the buffer inside the offline engine.
    //--------------------------------------------------
    const source = offlineContext.createBufferSource();
    source.buffer = buffer;
    source.connect(offlineContext.destination);
    source.start();

    //--------------------------------------------------
    // Browser performs the resampling.
    //--------------------------------------------------
    const renderedBuffer = await offlineContext.startRendering();
    return renderedBuffer.getChannelData(0);
  }

  //------------------------------------------------------
  // Convert Float32 (-1 to 1)
  // into Int16 (-32768 to 32767).
  //
  // Deepgram expects 16-bit PCM audio.
  //------------------------------------------------------
  function convertToInt16(samples) {
    const int16Samples = new Int16Array(samples.length);

    for (let i = 0; i < samples.length; i++) {
      //--------------------------------------------------
      // Clamp values to valid range.
      //--------------------------------------------------
      const sample = Math.max(-1, Math.min(1, samples[i]));

      //--------------------------------------------------
      // Scale Float32 into Int16.
      //--------------------------------------------------
      int16Samples[i] = sample < 0 ? sample * 32768 : sample * 32767;
    }

    return int16Samples;
  }

  //------------------------------------------------------
  // Convert Int16Array into Base64.
  // Wispr expects Base64 encoded PCM audio.
  //------------------------------------------------------
  function convertToBase64(int16Samples) {
    // View Int16Array as raw bytes.
    const bytes = new Uint8Array(int16Samples.buffer);

    // Convert bytes into binary string.
    let binary = "";

    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }

    // Encode binary string as Base64.
    return btoa(binary);
  }
});
