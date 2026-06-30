class AudioProcessor extends AudioWorkletProcessor {
  //--------------------------------------------------
  // Browser automatically calls process()
  // whenever a new audio buffer is available.
  //--------------------------------------------------
  process(inputs, outputs, parameters) {
    //--------------------------------------------------
    // inputs[0] = first connected input (microphone)
    //--------------------------------------------------
    const input = inputs[0];
    if (input.length === 0) {
      return true;
    }

    //--------------------------------------------------
    // input[0] = first audio channel.
    // Usually mono or left channel.
    //--------------------------------------------------
    const channel = input[0];

    //--------------------------------------------------
    // Send audio samples back to the main thread.
    // postMessage() is how threads communicate
    //--------------------------------------------------
    // Send structured message to main thread.
    this.port.postMessage({
      type: "audio",
      samples: Array.from(channel),
    });

    //--------------------------------------------------
    // Returning true keeps this processor alive.
    //--------------------------------------------------
    return true;
  }
}

registerProcessor("audio-processor", AudioProcessor);
