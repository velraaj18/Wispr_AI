let mediaRecorder;
let chunks = [];
let isRecording = false;

let audioContext;
let analyser;
let source;
let stream;

let canvas;
let ctx;
let waveRaf = null;
let waveBars = new Array(48).fill(10);
let lastWaveFrame = 0;

function resizeCanvas() {
  if (!canvas) return;
  canvas.width = canvas.offsetWidth;
  canvas.height = 42;
}

window.addEventListener("resize", resizeCanvas);

function drawWave() {
  if (!analyser || !canvas || !ctx) return;

  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteTimeDomainData(data);

  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += Math.abs(data[i] - 128);
  }

  const volume = sum / data.length;
  const peak = Math.max(8, Math.min(38, volume * 1.9));

  waveBars.push(peak);
  waveBars.shift();

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const spacing = canvas.width / waveBars.length;

  const center = canvas.height / 2;

  ctx.fillStyle = "#ffffff";

  for (let i = 0; i < waveBars.length; i++) {
    const h = waveBars[i];
    ctx.beginPath();
    const x = i * spacing + spacing / 2 - 2;
    ctx.roundRect(x, center - h / 2, 4, h, 2);
    ctx.fill();
  }

  waveRaf = requestAnimationFrame(scheduleNextWaveFrame);
}

function scheduleNextWaveFrame(timestamp) {
  if (timestamp - lastWaveFrame < 80) {
    waveRaf = requestAnimationFrame(scheduleNextWaveFrame);
    return;
  }

  lastWaveFrame = timestamp;
  drawWave();
}

$(document).ready(function () {
  canvas = document.getElementById("waveCanvas");
  ctx = canvas.getContext("2d");

  $("#micButton").click(async function () {
    if (!isRecording) {
      await startRecording();
    } else {
      stopRecording();
    }
  });

  async function startRecording() {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });

    resizeCanvas();

    audioContext = new AudioContext();

    source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;

    source.connect(analyser);

    mediaRecorder = new MediaRecorder(stream);

    chunks = [];

    mediaRecorder.ondataavailable = function (e) {
      if (e.data.size > 0) chunks.push(e.data);
    };

    mediaRecorder.onstop = uploadRecording;

    mediaRecorder.start();

    isRecording = true;
    $(".inputContainer").addClass("is-listening");
    resizeCanvas();
    lastWaveFrame = 0;
    drawWave();
    $("#micButton").addClass("recording").text("■");
    $("#liveText").text("Listening...");
  }

  async function uploadRecording() {
    cancelAnimationFrame(waveRaf);
    waveRaf = null;
    lastWaveFrame = 0;

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

      $("#promptInput").val(result.text);

      if (result.text.trim() !== "") {
        $("#liveText").text(result.text);
      } else {
        $("#liveText").text("What's on your mind today?");
      }
    } catch (err) {
      console.error(err);

      $("#liveText").text("Something went wrong");
    }

    $(".inputContainer").removeClass("is-listening");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    waveBars = new Array(48).fill(10);
    $("#micButton").removeClass("recording").text("🎤");
    stream.getTracks().forEach((track) => track.stop());
    audioContext.close();
    isRecording = false;
  }

  function stopRecording() {
    if (!mediaRecorder || !isRecording) return;
    mediaRecorder.stop();
  }
});
