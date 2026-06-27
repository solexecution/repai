/**
 * pose-engine.js
 *
 * Thin wrapper around TensorFlow.js + @tensorflow-models/pose-detection.
 * Uses MoveNet SinglePose Lightning — fast, accurate, runs fully on-device.
 *
 * Assumes tf and poseDetection are loaded globally from CDN scripts.
 */

'use strict';

class PoseEngine {
  constructor() {
    this.detector  = null;
    this.isLoaded  = false;
    this.isRunning = false;
  }

  /**
   * Load the MoveNet model. Call once on app start.
   * @param {function(string):void} [onStatus] – status callback
   */
  async load(onStatus = () => {}) {
    try {
      onStatus('Initialising TensorFlow.js…');
      // Ensure TF backend is ready
      await tf.ready();

      onStatus('Loading MoveNet model…');
      this.detector = await poseDetection.createDetector(
        poseDetection.SupportedModels.MoveNet,
        {
          modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
          enableSmoothing: true,       // temporal smoothing across frames
          minPoseScore: 0.25,
        }
      );

      this.isLoaded = true;
      onStatus('Model ready');
    } catch (err) {
      onStatus('Error loading model: ' + err.message);
      throw err;
    }
  }

  /**
   * Run pose detection on a video element.
   * Returns an array of 17 keypoints (MoveNet format), or [] if not ready.
   *
   * @param {HTMLVideoElement} videoEl
   * @returns {Promise<Array>}
   */
  async detect(videoEl) {
    if (!this.isLoaded || !this.detector) return [];
    if (!videoEl || videoEl.readyState < 2) return [];
    if (videoEl.videoWidth === 0 || videoEl.videoHeight === 0) return [];

    try {
      const poses = await this.detector.estimatePoses(videoEl, {
        flipHorizontal: false,  // we handle flipping in CSS
      });
      if (!poses || poses.length === 0) return [];
      return poses[0].keypoints;
    } catch {
      return [];
    }
  }

  /**
   * Dispose the detector and free GPU memory.
   */
  dispose() {
    if (this.detector) {
      this.detector.dispose();
      this.detector = null;
    }
    this.isLoaded = false;
  }
}

// ─── Skeleton Drawing ─────────────────────────────────────────────────────────

/** Pairs of keypoint indices that form the skeleton bones */
const SKELETON_CONNECTIONS = [
  // Face
  [0, 1], [0, 2], [1, 3], [2, 4],
  // Shoulders
  [5, 6],
  // Left arm
  [5, 7], [7, 9],
  // Right arm
  [6, 8], [8, 10],
  // Torso
  [5, 11], [6, 12], [11, 12],
  // Left leg
  [11, 13], [13, 15],
  // Right leg
  [12, 14], [14, 16],
];

/** Which keypoints are "arms" (highlighted differently per exercise) */
const ARM_KEYPOINTS = new Set([5, 6, 7, 8, 9, 10]); // shoulders + elbows + wrists

/**
 * Draw the skeleton overlay onto a canvas.
 *
 * The video is first drawn to fill the canvas (maintaining aspect ratio with
 * centre-crop, same as object-fit:cover), then bones and joints are overlaid.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLVideoElement} video
 * @param {Array} keypoints   – MoveNet keypoints
 * @param {string} accentColor – CSS color for highlighted joints
 * @returns {{ sx,sy,sw,sh,scaleX,scaleY }} crop transform (for external use)
 */
function drawSkeletonOnCanvas(ctx, video, keypoints, accentColor = '#4facfe') {
  const { canvas } = ctx;
  const cw = canvas.width;
  const ch = canvas.height;

  // ── 1. Draw the video frame, maintaining aspect ratio (cover crop) ──────
  const vw = video.videoWidth  || cw;
  const vh = video.videoHeight || ch;
  const videoAR = vw / vh;
  const canvasAR = cw / ch;

  let sx = 0, sy = 0, sw = vw, sh = vh;
  if (videoAR > canvasAR) {
    // Video is wider → crop left & right
    sw = vh * canvasAR;
    sx = (vw - sw) / 2;
  } else {
    // Video is taller → crop top & bottom
    sh = vw / canvasAR;
    sy = (vh - sh) / 2;
  }
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, cw, ch);

  if (!keypoints || keypoints.length === 0) {
    return { sx, sy, sw, sh, scaleX: cw / sw, scaleY: ch / sh };
  }

  const scaleX = cw / sw;
  const scaleY = ch / sh;

  // Map video-space keypoint to canvas-space
  const toCanvas = (kp) => ({
    x: (kp.x - sx) * scaleX,
    y: (kp.y - sy) * scaleY,
  });

  // ── 2. Draw bones ────────────────────────────────────────────────────────
  ctx.lineCap = 'round';

  for (const [i, j] of SKELETON_CONNECTIONS) {
    const a = keypoints[i];
    const b = keypoints[j];
    if (!a || !b) continue;
    const confA = a.score ?? 1;
    const confB = b.score ?? 1;
    if (confA < 0.2 || confB < 0.2) continue;

    const isArmBone = ARM_KEYPOINTS.has(i) && ARM_KEYPOINTS.has(j);
    const alpha = Math.min(confA, confB);

    if (isArmBone) {
      ctx.strokeStyle = accentColor;
      ctx.lineWidth   = 4;
      ctx.globalAlpha = alpha * 0.9;
      // Glow
      ctx.shadowColor = accentColor;
      ctx.shadowBlur  = 12;
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth   = 3;
      ctx.globalAlpha = alpha * 0.6;
      ctx.shadowBlur  = 0;
    }

    const pa = toCanvas(a);
    const pb = toCanvas(b);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  // ── 3. Draw joints ───────────────────────────────────────────────────────
  ctx.shadowBlur = 0;

  for (let i = 0; i < keypoints.length; i++) {
    const kp = keypoints[i];
    if (!kp) continue;
    const conf = kp.score ?? 1;
    if (conf < 0.2) continue;

    const { x, y } = toCanvas(kp);
    const isArm = ARM_KEYPOINTS.has(i);
    const radius = isArm ? 7 : 5;

    ctx.globalAlpha = Math.min(conf * 1.2, 1);

    if (isArm) {
      // Glowing accent dot
      ctx.shadowColor = accentColor;
      ctx.shadowBlur  = 14;
      ctx.fillStyle   = accentColor;
    } else {
      ctx.shadowBlur = 0;
      ctx.fillStyle  = 'rgba(255,255,255,0.85)';
    }

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();

    // White outline ring for arm joints
    if (isArm) {
      ctx.shadowBlur  = 0;
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth   = 2;
      ctx.globalAlpha = conf * 0.7;
      ctx.stroke();
    }
  }

  ctx.globalAlpha = 1;
  ctx.shadowBlur  = 0;

  return { sx, sy, sw, sh, scaleX, scaleY };
}
