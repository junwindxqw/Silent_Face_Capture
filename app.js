(function () {
  var TEST_DURATION_MS = 30 * 1000;
  var FACE_CHECK_INTERVAL_MS = 2 * 1000;
  var NO_FACE_WARN_THRESHOLD = 3;
  var FACE_API_SCRIPT = "https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js";
  var FACE_API_MODEL_URL = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights";

  var startBtn = document.getElementById("startBtn");
  var statusText = document.getElementById("statusText");
  var countdownText = document.getElementById("countdownText");
  var photosGrid = document.getElementById("photosGrid");
  var video = document.getElementById("cameraVideo");
  var canvas = document.getElementById("captureCanvas");
  var ctx = canvas.getContext("2d", { willReadFrequently: true });

  var stream = null;
  var detector = null;
  var detectorMode = "";
  var testRunning = false;
  var testEndsAt = 0;
  var tickTimer = null;
  var faceTimer = null;
  var finishTimer = null;
  var captureTimers = [];
  var capturedCount = 0;
  var consecutiveNoFaceCount = 0;
  var faceCheckInProgress = false;

  startBtn.addEventListener("click", startTest);

  async function startTest() {
    if (testRunning) return;

    resetUi();
    setStatus("正在准备摄像头权限...");
    startBtn.disabled = true;

    try {
      if (await shouldPromptForCameraPermission()) {
        alert("请先获取摄像头权限");
      }
      await startCamera();
      alert("您已获取权限");
      await prepareFaceDetector();
    } catch (error) {
      stopCamera();
      startBtn.disabled = false;
      setStatus("启动失败：" + getErrorMessage(error));
      alert("无法启动测试：" + getErrorMessage(error));
      return;
    }

    testRunning = true;
    capturedCount = 0;
    consecutiveNoFaceCount = 0;
    testEndsAt = Date.now() + TEST_DURATION_MS;
    setStatus("测试进行中");

    updateCountdown();
    tickTimer = window.setInterval(updateCountdown, 250);
    faceTimer = window.setInterval(checkFaceAndWarn, FACE_CHECK_INTERVAL_MS);
    scheduleRandomCaptures();

    finishTimer = window.setTimeout(finishTest, TEST_DURATION_MS);
  }

  async function shouldPromptForCameraPermission() {
    if (!navigator.permissions || !navigator.permissions.query) {
      return true;
    }

    try {
      var permissionStatus = await navigator.permissions.query({ name: "camera" });
      return permissionStatus.state !== "granted";
    } catch (error) {
      return true;
    }
  }

  async function startCamera() {
    if (!isCameraAccessAllowed()) {
      throw new Error("请使用 HTTPS 域名访问页面后再调用摄像头");
    }

    stream = await getUserMedia({
      audio: false,
      video: {
        facingMode: "user",
        width: { ideal: 720 },
        height: { ideal: 960 }
      }
    });

    video.srcObject = stream;
    await video.play();
    await waitForVideoReady();
  }

  function isCameraAccessAllowed() {
    var isLocalhost = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    return window.isSecureContext || isLocalhost;
  }

  function getUserMedia(constraints) {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      return navigator.mediaDevices.getUserMedia(constraints);
    }

    var legacyGetUserMedia = navigator.getUserMedia ||
      navigator.webkitGetUserMedia ||
      navigator.mozGetUserMedia ||
      navigator.msGetUserMedia;

    if (!legacyGetUserMedia) {
      return Promise.reject(new Error("当前浏览器不支持调用摄像头"));
    }

    return new Promise(function (resolve, reject) {
      legacyGetUserMedia.call(navigator, constraints, resolve, reject);
    });
  }

  function waitForVideoReady() {
    return new Promise(function (resolve) {
      if (video.videoWidth && video.videoHeight) {
        resolve();
        return;
      }

      video.addEventListener("loadedmetadata", function handleLoaded() {
        video.removeEventListener("loadedmetadata", handleLoaded);
        resolve();
      });
    });
  }

  async function prepareFaceDetector() {
    if ("FaceDetector" in window) {
      detector = new window.FaceDetector({
        fastMode: true,
        maxDetectedFaces: 1
      });
      detectorMode = "native";
      return;
    }

    await loadFaceApi();
    await window.faceapi.nets.tinyFaceDetector.loadFromUri(FACE_API_MODEL_URL);
    detector = window.faceapi;
    detectorMode = "faceapi";
  }

  function loadFaceApi() {
    return new Promise(function (resolve, reject) {
      if (window.faceapi) {
        resolve();
        return;
      }

      var script = document.createElement("script");
      script.src = FACE_API_SCRIPT;
      script.async = true;
      script.onload = resolve;
      script.onerror = function () {
        reject(new Error("人脸识别库加载失败"));
      };
      document.head.appendChild(script);
    });
  }

  async function checkFaceAndWarn() {
    if (!testRunning || faceCheckInProgress) return;

    try {
      faceCheckInProgress = true;
      var hasFace = await detectFace();
      if (hasFace) {
        consecutiveNoFaceCount = 0;
        return;
      }

      consecutiveNoFaceCount += 1;
      if (consecutiveNoFaceCount >= NO_FACE_WARN_THRESHOLD && testRunning) {
        consecutiveNoFaceCount = 0;
        alert("未检测到人脸");
      }
    } catch (error) {
      setStatus("人脸检测异常：" + getErrorMessage(error));
    } finally {
      faceCheckInProgress = false;
    }
  }

  async function detectFace() {
    var detectorHasFace = false;

    if (detectorMode === "native") {
      var faces = await detector.detect(video);
      detectorHasFace = faces.length > 0;
    } else {
      var result = await detector
        .detectSingleFace(video, new detector.TinyFaceDetectorOptions({
          inputSize: 128,
          scoreThreshold: 0.2
        }));
      detectorHasFace = Boolean(result);
    }

    return detectorHasFace || hasLikelyPersonInFrame();
  }

  function hasLikelyPersonInFrame() {
    var width = video.videoWidth;
    var height = video.videoHeight;
    if (!width || !height) return false;

    var sampleWidth = 120;
    var sampleHeight = 90;
    canvas.width = sampleWidth;
    canvas.height = sampleHeight;
    ctx.drawImage(video, 0, 0, sampleWidth, sampleHeight);

    var imageData = ctx.getImageData(0, 0, sampleWidth, sampleHeight).data;
    var skinLikePixels = 0;
    var startX = Math.floor(sampleWidth * 0.2);
    var endX = Math.floor(sampleWidth * 0.8);
    var startY = Math.floor(sampleHeight * 0.12);
    var endY = Math.floor(sampleHeight * 0.88);

    for (var y = startY; y < endY; y += 1) {
      for (var x = startX; x < endX; x += 1) {
        var index = (y * sampleWidth + x) * 4;
        var r = imageData[index];
        var g = imageData[index + 1];
        var b = imageData[index + 2];
        var max = Math.max(r, g, b);
        var min = Math.min(r, g, b);
        var brightness = (r + g + b) / 3;
        var cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        var cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;

        if (
          brightness > 35 &&
          brightness < 245 &&
          max - min > 10 &&
          cb >= 75 &&
          cb <= 135 &&
          cr >= 130 &&
          cr <= 180 &&
          r >= b
        ) {
          skinLikePixels += 1;
        }
      }
    }

    return skinLikePixels > 70;
  }

  function scheduleRandomCaptures() {
    var firstTime = randomInt(5, 13) * 1000;
    var secondTime = randomInt(16, 27) * 1000;

    captureTimers = [firstTime, secondTime].map(function (time) {
      return window.setTimeout(capturePhoto, time);
    });
  }

  function capturePhoto() {
    if (!testRunning || capturedCount >= 2) return;

    var width = video.videoWidth;
    var height = video.videoHeight;
    if (!width || !height) return;

    canvas.width = width;
    canvas.height = height;
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -width, 0, width, height);
    ctx.restore();

    capturedCount += 1;
    renderPhoto(canvas.toDataURL("image/jpeg", 0.9), capturedCount);
  }

  function renderPhoto(src, index) {
    var slot = photosGrid.children[index - 1];
    var wrapper = document.createElement("div");
    var img = document.createElement("img");

    wrapper.className = "photo-item";
    img.src = src;
    img.alt = "第 " + index + " 张随机抓拍照片";
    wrapper.appendChild(img);

    photosGrid.replaceChild(wrapper, slot);
  }

  function finishTest() {
    if (!testRunning) return;

    testRunning = false;
    faceCheckInProgress = false;
    consecutiveNoFaceCount = 0;
    window.clearInterval(tickTimer);
    window.clearInterval(faceTimer);
    window.clearTimeout(finishTimer);
    captureTimers.forEach(window.clearTimeout);
    captureTimers = [];
    stopCamera();
    updateCountdown(true);
    setStatus("测试已结束");
    startBtn.disabled = false;
    alert("测试已结束");
  }

  function stopCamera() {
    if (!stream) return;

    stream.getTracks().forEach(function (track) {
      track.stop();
    });
    stream = null;
    video.srcObject = null;
  }

  function updateCountdown(forceZero) {
    var remaining = forceZero ? 0 : Math.max(0, testEndsAt - Date.now());
    countdownText.textContent = formatTime(remaining);
  }

  function resetUi() {
    photosGrid.innerHTML = "";
    for (var i = 1; i <= 2; i += 1) {
      var placeholder = document.createElement("div");
      placeholder.className = "photo-placeholder";
      placeholder.textContent = "等待第 " + i + " 张照片";
      photosGrid.appendChild(placeholder);
    }
    countdownText.textContent = formatTime(TEST_DURATION_MS);
    setStatus("准备开始");
  }

  function setStatus(text) {
    statusText.textContent = text;
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function formatTime(ms) {
    var totalSeconds = Math.ceil(ms / 1000);
    var minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
    var seconds = String(totalSeconds % 60).padStart(2, "0");
    return minutes + ":" + seconds;
  }

  function getErrorMessage(error) {
    if (!error) return "未知错误";
    if (error.name === "NotAllowedError") return "用户未授权摄像头权限";
    if (error.name === "NotFoundError") return "未找到可用摄像头";
    return error.message || String(error);
  }
})();
