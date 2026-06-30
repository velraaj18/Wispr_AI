$(document).ready(function () {
  let isListening = false;

  let mediaRecorder;
  let audioChunks = [];

  $("#micButton").click(async function () {
    if (!isListening) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });

        mediaRecorder = new MediaRecorder(stream);

        audioChunks = [];

        mediaRecorder.ondataavailable = function (event) {
          audioChunks.push(event.data);

          console.log("Chunk received");
        };

        mediaRecorder.onstop = function () {
          const audioBlob = new Blob(audioChunks, {
            type: "audio/webm",
          });

          const audioUrl = URL.createObjectURL(audioBlob);

          const audio = new Audio(audioUrl);

          audio.play();

          console.log(audioBlob);

          $("#status").text("✅ Recording Complete");
        };

        mediaRecorder.start();

        isListening = true;

        $("#micButton").text("⏹");

        $("#status").text("🔴 Recording...");
      } catch (error) {
        console.error(error);

        $("#status").text("❌ Permission Denied");
      }
    } else {
      mediaRecorder.stop();

      isListening = false;

      $("#micButton").text("🎤");
    }
  });
});
