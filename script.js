$(document).ready(function () {
  let isListening = false;
  let mediaStream = null;
  let audioContext;
  let mediaStreamSource;
  let audioProcessor;
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
        // Why?
        // Browsers never allow microphone access automatically.
        // User must explicitly approve.
        // Returns: MediaStream

        // Think of MediaStream as: Live microphone data
        // It is NOT recording.
        // It is simply a live stream of audio.
        //------------------------------------------------------
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });

        //------------------------------------------------------
        // STEP 2
        // Create browser's audio engine
        // Because media stream only provides microphone access
        // It cannot:
        // ❌ process audio
        // ❌ apply filters
        // ❌ connect processors
        // ❌ resample audio
        // AudioContext provides all of these.
        //------------------------------------------------------
        audioContext = new AudioContext();
        sampleBuffer = [];
        $("#sampleRate").text(audioContext.sampleRate);

        //------------------------------------------------------
        // STEP 3
        // Convert MediaStream into an Audio Node.
        // Becasue AudioContext works with "Nodes".
        // MediaStream is NOT an Audio Node.
        // So we wrap it inside
        // MediaStreamAudioSourceNode.
        //------------------------------------------------------
        mediaStreamSource = audioContext.createMediaStreamSource(mediaStream);
        console.log(audioContext);
        console.log(mediaStreamSource);

        //------------------------------------------------------
        // STEP 4
        // Load our custom audio processor
        // Browser doesn't know how we want to process audio.
        // addModule() loads our processor into AudioContext.
        // NOTE:
        // AudioWorklet must be in a separate JS file.
        //------------------------------------------------------
        await audioContext.audioWorklet.addModule("audioProcessorWorklet.js");

        //------------------------------------------------------
        // STEP 5
        // Create an instance of our processor
        audioProcessor = new AudioWorkletNode(audioContext, "audio-processor");

        //------------------------------------------------------
        // STEP 6
        // Connect microphone to the processor
        mediaStreamSource.connect(audioProcessor);
        console.log(audioProcessor);

        //------------------------------------------------------
        // STEP 7
        // Receives audio samples from the Audio processor worklet
        audioProcessor.port.onmessage = async function (event) {
          if (event.data.type !== "audio") return;
          sampleBuffer.push(...event.data.samples);

          $("#bufferedSamples").text(sampleBuffer.length);

          if (sampleBuffer.length < BUFFER_SIZE) return;

          const packet = sampleBuffer.splice(0, BUFFER_SIZE);
          const volume = calculateVolume(packet);
          $("#volumeBar").val(volume * 100);

          //------------------------------------------------------
          // Convert browser audio (48kHz)
          // into Wispr audio (16kHz).
          //------------------------------------------------------
          const resampledPacket = await resampleAudio(packet);
          // console.log(resampledPacket);

          //------------------------------------------------------
          // Convert Float32 samples to 16-bit PCM.
          //------------------------------------------------------
          const int16Packet = convertToInt16(resampledPacket);
          // console.log(int16Packet)

          // Convert into base 64 packet as web socket doesn't allow binary characters in the request.
          const base64Packet = convertToBase64(int16Packet);
          console.log(base64Packet);
        };

        isListening = true;

        $("#micButton").text("⏹");

        $("#status").text("🔴 Recording...");
      } catch (error) {
        console.error(error);

        $("#status").text("❌ Permission Denied");
      }
    } else {
      //------------------------------------------------------
      // Stop every microphone track.
      // Why?
      // Browser keeps microphone active until
      // every track is stopped.
      // If we skip this,
      // microphone light may remain ON.
      //------------------------------------------------------
      mediaStream.getTracks().forEach((track) => {
        track.stop();
      });

      // destroy audio context
      await audioContext.close();

      audioContext = null;
      mediaStream = null;
      mediaStreamSource = null;

      isListening = false;
      $("#status").text("Stopped");
      $("#micButton").text("🎤");
    }
  });

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
  // Wispr expects 16kHz.
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
  // Wispr expects 16-bit PCM audio.
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
