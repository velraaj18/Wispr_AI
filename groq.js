let mediaRecorder;
let chunks = [];
let isRecording = false;

$(document).ready(function () {
  $("#micButton").click(async function () {
    if (!isRecording) {
      await startRecording();
    } else {
      stopRecording();
    }
  });

  async function startRecording() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });

    mediaRecorder = new MediaRecorder(stream);
    chunks = [];

    mediaRecorder.ondataavailable = function (e) {
      if (e.data.size > 0) {
        chunks.push(e.data);
      }
    };

    mediaRecorder.onstop = async function () {
      $("#status").text("Status: Uploading...");
      $("#micButton").text("⏳");

      const blob = new Blob(chunks, {
        type: "audio/webm",
      });

      const formData = new FormData();
      formData.append("file", blob, "speech.webm");

      try {
        const response = await fetch("http://localhost:8000/transcribe", {
          method: "POST",
          body: formData,
        });

        const result = await response.json();
        console.log(result);
        $("#promptInput").val(result.text);
        $("#status").text("Status: Idle");
        $("#micButton").text("🎤");
      } catch (err) {
        console.error(err);

        $("#status").text("Status: Error");
        $("#micButton").text("🎤");
      }

      // Stop microphone tracks
      mediaRecorder.stream.getTracks().forEach((track) => track.stop());

      isRecording = false;
    };

    mediaRecorder.start();

    isRecording = true;
    $("#status").text("Status: Recording...");
    $("#micButton").text("⏹");
  }

  function stopRecording() {
    if (mediaRecorder && isRecording) {
      $("#status").text("Status: Stopping...");
      mediaRecorder.stop();
    }
  }
});
