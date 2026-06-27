/**
 * rep-counter.js
 *
 * State-machine rep counters for pushups, pullups, and situps.
 * Supports "Fractional Scoring" for strict mode (e.g. 0.5 reps for a half rep).
 */

'use strict';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MIN_CONFIDENCE = 0.25;

function getDist(p1, p2) {
  return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
}

function calcAngle(p1, p2, p3) {
  const v1x = p1.x - p2.x, v1y = p1.y - p2.y;
  const v2x = p3.x - p2.x, v2y = p3.y - p2.y;
  const dot = v1x * v2x + v1y * v2y;
  const mag = Math.sqrt((v1x * v1x + v1y * v1y) * (v2x * v2x + v2y * v2y));
  if (mag < 1e-6) return 180;
  return Math.acos(Math.max(-1, Math.min(1, dot / mag))) * (180 / Math.PI);
}

function getKP(keypoints, index) {
  const pt = keypoints[index];
  if (!pt || (pt.score !== undefined && pt.score < MIN_CONFIDENCE)) return null;
  return pt;
}

// Find the arm with the highest confidence
function getBestArm(keypoints) {
  const sides = [
    { shoulder: 5, elbow: 7, wrist: 9 },
    { shoulder: 6, elbow: 8, wrist: 10 },
  ];
  let bestArm = null;
  let bestConf = -1;

  for (const s of sides) {
    const shoulder = getKP(keypoints, s.shoulder);
    const elbow    = getKP(keypoints, s.elbow);
    const wrist    = getKP(keypoints, s.wrist);
    if (!shoulder || !elbow || !wrist) continue;

    const conf = (shoulder.score + elbow.score + wrist.score) / 3;
    if (conf > bestConf) {
      bestConf = conf;
      bestArm  = { shoulder, elbow, wrist, confidence: conf, indices: new Set([s.shoulder, s.elbow, s.wrist]) };
    }
  }
  return bestArm;
}

// Find the torso side (shoulder + hip) with highest confidence
function getBestTorso(keypoints) {
  const sides = [
    { shoulder: 5, hip: 11 },
    { shoulder: 6, hip: 12 },
  ];
  let bestTorso = null;
  let bestConf = -1;

  for (const s of sides) {
    const shoulder = getKP(keypoints, s.shoulder);
    const hip      = getKP(keypoints, s.hip);
    if (!shoulder || !hip) continue;

    const conf = (shoulder.score + hip.score) / 2;
    if (conf > bestConf) {
      bestConf = conf;
      bestTorso  = { shoulder, hip, confidence: conf, indices: new Set([s.shoulder, s.hip]) };
    }
  }
  return bestTorso;
}

// Find the leg with highest confidence
function getBestLeg(keypoints) {
  const sides = [
    { hip: 11, knee: 13, ankle: 15 },
    { hip: 12, knee: 14, ankle: 16 },
  ];
  let bestLeg = null;
  let bestConf = -1;

  for (const s of sides) {
    const hip   = getKP(keypoints, s.hip);
    const knee  = getKP(keypoints, s.knee);
    const ankle = getKP(keypoints, s.ankle);
    if (!hip || !knee || !ankle) continue;

    const conf = (hip.score + knee.score + ankle.score) / 3;
    if (conf > bestConf) {
      bestConf = conf;
      bestLeg  = { hip, knee, ankle, confidence: conf, indices: new Set([s.hip, s.knee, s.ankle]) };
    }
  }
  return bestLeg;
}

// ─── Base Counter ─────────────────────────────────────────────────────────────

class BaseCounter {
  constructor() {
    this.count = 0;
    this.phase = 'rest'; // 'rest' | 'moving'
    this.maxProgress = 0;
    this.lastRepTime = 0;
    this.isStrict = false;
    this.MIN_REP_MS = 800;
  }

  reset() {
    this.count = 0;
    this.phase = 'rest';
    this.maxProgress = 0;
    this.lastRepTime = 0;
  }

  // To be overridden by subclasses
  calculateProgress(keypoints) { return { progress: 0, conf: 0, raw: null }; }
  isValidMovement(keypoints) { return true; }
  onMoveStart(keypoints) {}
  getTrackedIndices(keypoints) { return null; }

  update(keypoints) {
    const { progress, conf, raw } = this.calculateProgress(keypoints);
    if (conf === 0) return { repCompleted: false, countAdded: 0, phase: this.phase, progress: 0, raw };

    let repCompleted = false;
    let countAdded = 0;

    if (this.phase === 'rest') {
      if (progress > 0.1) {
        this.phase = 'moving';
        this.maxProgress = progress;
        this.onMoveStart(keypoints);
      }
    } else if (this.phase === 'moving') {
      // Only track max progress if strict constraints (like staying stationary) are met
      if (this.isValidMovement(keypoints)) {
        this.maxProgress = Math.max(this.maxProgress, progress);
      }

      // Return to rest position
      if (progress < 0.1) {
        const now = Date.now();
        if (now - this.lastRepTime > this.MIN_REP_MS) {
          
          if (this.isStrict) {
            // Strict mode: Fractional scoring! (e.g. 0.5 for half rep)
            if (this.maxProgress > 0.2) { 
              // Round down to nearest 0.1
              countAdded = Math.floor(this.maxProgress * 10) / 10;
              this.count += countAdded;
              this.lastRepTime = now;
              repCompleted = true;
            }
          } else {
            // Casual mode: Anything > 60% counts as a full 1.0 rep
            if (this.maxProgress > 0.6) {
              countAdded = 1.0;
              this.count += countAdded;
              this.lastRepTime = now;
              repCompleted = true;
            }
          }
        }
        this.phase = 'rest';
        this.maxProgress = 0;
      }
    }

    return { 
      repCompleted, 
      countAdded, 
      phase: this.phase, 
      progress: this.phase === 'moving' ? this.maxProgress : progress,
      confidence: conf,
      raw
    };
  }
}

// ─── Pushup Counter ───────────────────────────────────────────────────────────

class PushupCounter extends BaseCounter {
  constructor() {
    super();
    this.MIN_REP_MS = 800;
    this.REST_ANGLE = 155; 
    this.MAX_ANGLE  = 90;
    this.repStartX  = null;
  }

  reset() {
    super.reset();
    this.repStartX = null;
  }

  calculateProgress(keypoints) {
    const arm = getBestArm(keypoints);
    if (!arm) return { progress: 0, conf: 0, raw: null };

    const angle = calcAngle(
      { x: arm.shoulder.x, y: arm.shoulder.y },
      { x: arm.elbow.x,    y: arm.elbow.y    },
      { x: arm.wrist.x,    y: arm.wrist.y    }
    );

    // Map 155° -> 0.0, and 90° -> 1.0
    let prog = (this.REST_ANGLE - angle) / (this.REST_ANGLE - this.MAX_ANGLE);
    prog = Math.max(0, Math.min(1, prog)); // clamp [0, 1]

    return { progress: prog, conf: arm.confidence, raw: angle };
  }

  onMoveStart(keypoints) {
    const arm = getBestArm(keypoints);
    if (arm) this.repStartX = arm.shoulder.x;
  }

  isValidMovement(keypoints) {
    const arm = getBestArm(keypoints);
    if (!arm || this.repStartX === null) return true;
    
    // Strict requirement: Shoulders must not drift horizontally (no walking)
    const armLength = getDist(arm.shoulder, arm.elbow) + getDist(arm.elbow, arm.wrist);
    return Math.abs(arm.shoulder.x - this.repStartX) < (armLength * 0.8);
  }

  getTrackedIndices(keypoints) {
    const arm = getBestArm(keypoints);
    return arm ? arm.indices : null;
  }
}

// ─── Pullup Counter ───────────────────────────────────────────────────────────

class PullupCounter extends BaseCounter {
  constructor() {
    super();
    this.MIN_REP_MS = 1200;
    this.REST_ANGLE = 150; 
    this.MAX_ANGLE  = 60;
    this.repStartX  = null;
  }

  reset() {
    super.reset();
    this.repStartX = null;
  }

  calculateProgress(keypoints) {
    const arm = getBestArm(keypoints);
    if (!arm) return { progress: 0, conf: 0, raw: null };

    const angle = calcAngle(
      { x: arm.shoulder.x, y: arm.shoulder.y },
      { x: arm.elbow.x,    y: arm.elbow.y    },
      { x: arm.wrist.x,    y: arm.wrist.y    }
    );

    // Map 150° -> 0.0, and 60° -> 1.0
    let prog = (this.REST_ANGLE - angle) / (this.REST_ANGLE - this.MAX_ANGLE);
    prog = Math.max(0, Math.min(1, prog));

    return { progress: prog, conf: arm.confidence, raw: angle };
  }

  onMoveStart(keypoints) {
    const arm = getBestArm(keypoints);
    if (arm) this.repStartX = arm.shoulder.x;
  }

  isValidMovement(keypoints) {
    const arm = getBestArm(keypoints);
    const nose = getKP(keypoints, 0);
    if (!arm) return true;

    // Strict requirements:
    // 1. Must reach upwards (wrist above shoulder)
    if (arm.wrist.y > arm.shoulder.y) return false;

    // 2. No swinging (shoulder X stays stable)
    if (this.repStartX !== null) {
      const armLength = getDist(arm.shoulder, arm.elbow) + getDist(arm.elbow, arm.wrist);
      if (Math.abs(arm.shoulder.x - this.repStartX) > (armLength * 0.8)) return false;
    }

    return true;
  }
}

// ─── Situp Counter ────────────────────────────────────────────────────────────

class SitupCounter extends BaseCounter {
  constructor() {
    super();
    this.MIN_REP_MS = 1000;
  }

  calculateProgress(keypoints) {
    const torso = getBestTorso(keypoints);
    if (!torso) return { progress: 0, conf: 0, raw: null };

    // To prevent cheating with leg raises, we track torso verticality.
    // Lying flat: shoulder Y ≈ hip Y -> heightDiff ≈ 0
    // Sitting up: shoulder Y is much smaller than hip Y -> heightDiff ≈ torsoLength
    
    const torsoLength = getDist(torso.shoulder, torso.hip);
    if (torsoLength < 10) return { progress: 0, conf: torso.confidence, raw: 0 };

    const heightDiff = torso.hip.y - torso.shoulder.y; 
    
    // progress is roughly (heightDiff / torsoLength)
    // Map: 0.2 (mostly flat) -> 0.0, 0.8 (mostly vertical) -> 1.0
    let prog = (heightDiff / torsoLength - 0.2) / (0.8 - 0.2);
    prog = Math.max(0, Math.min(1, prog));

    return { progress: prog, conf: torso.confidence, raw: (heightDiff / torsoLength) };
  }
}

// ─── Plank Counter ────────────────────────────────────────────────────────────

class PlankCounter {
  constructor() {
    this.count = 0; // Accumulated seconds
    this.phase = 'rest'; // 'rest' | 'holding' | 'bad form'
    this.isStrict = true;
    this.lastFrameTime = 0;
    this.badFormFrames = 0;
  }

  reset() {
    this.count = 0;
    this.phase = 'rest';
    this.lastFrameTime = 0;
    this.badFormFrames = 0;
  }

  update(keypoints) {
    const torso = getBestTorso(keypoints);
    if (!torso) return { repCompleted: false, countAdded: 0, phase: 'rest', progress: 0, raw: 0 };
    
    // Check back straightness using shoulder, hip, and ankle if available
    let isValidPlank = false;
    let rawAngle = 0;

    const sides = [
      { s:5, h:11, k:13, a:15 },
      { s:6, h:12, k:14, a:16 }
    ];
    
    for (const side of sides) {
      const sh = getKP(keypoints, side.s);
      const hi = getKP(keypoints, side.h);
      const kn = getKP(keypoints, side.k);
      const an = getKP(keypoints, side.a);
      
      const legPt = kn || an; // Prefer knee, fallback to ankle
      if (sh && hi && legPt) {
         const angle = calcAngle(sh, hi, legPt);
         rawAngle = angle;
         
         // 1. Back straightness (140-220)
         const isStraight = angle > 140 && angle < 220;
         
         // 2. Torso horizontalness (height diff < length * 0.8)
         const len = getDist(sh, hi);
         const isHorizontal = Math.abs(sh.y - hi.y) < len * 0.8;
         
         if (isStraight && isHorizontal) {
           isValidPlank = true;
           break;
         }
      }
    }

    // Fallback if legs aren't visible but torso is strictly horizontal
    if (!isValidPlank && rawAngle === 0) {
      const len = getDist(torso.shoulder, torso.hip);
      if (Math.abs(torso.shoulder.y - torso.hip.y) < len * 0.6) {
        isValidPlank = true;
      }
    }

    const now = Date.now();
    const dt = this.lastFrameTime ? (now - this.lastFrameTime) / 1000 : 0;
    this.lastFrameTime = now;
    
    let countAdded = 0;
    let repCompleted = false;

    if (isValidPlank) {
       this.badFormFrames = 0;
       this.phase = 'holding';
       countAdded = dt;
       this.count += countAdded;
       repCompleted = true; // Constantly true so UI updates every frame
    } else {
       this.badFormFrames++;
       if (this.badFormFrames > 15) {
         this.phase = 'bad form';
       } else if (this.phase === 'holding') {
         // Allow brief lapses without immediately breaking state
         countAdded = dt;
         this.count += countAdded;
         repCompleted = true;
       }
    }
    
    return {
      repCompleted,
      countAdded,
      phase: this.phase,
      progress: isValidPlank ? 1 : 0,
      confidence: torso.confidence,
      raw: rawAngle
    };
  }

  getTrackedIndices(keypoints) {
    const torso = getBestTorso(keypoints);
    // For plank, we might also want ankles, but torso is strictly what is scored.
    return torso ? torso.indices : null;
  }
}

// ─── Squat Counter ────────────────────────────────────────────────────────────

class SquatCounter extends BaseCounter {
  constructor() {
    super();
    this.MIN_REP_MS = 1200;
    this.REST_ANGLE = 160; 
    this.MAX_ANGLE  = 90;
    this.repStartX  = null;
  }

  reset() {
    super.reset();
    this.repStartX = null;
  }

  calculateProgress(keypoints) {
    const leg = getBestLeg(keypoints);
    if (!leg) return { progress: 0, conf: 0, raw: null };

    const angle = calcAngle(
      { x: leg.hip.x,   y: leg.hip.y   },
      { x: leg.knee.x,  y: leg.knee.y  },
      { x: leg.ankle.x, y: leg.ankle.y }
    );

    // Map 160° -> 0.0, and 90° -> 1.0
    let prog = (this.REST_ANGLE - angle) / (this.REST_ANGLE - this.MAX_ANGLE);
    prog = Math.max(0, Math.min(1, prog));

    return { progress: prog, conf: leg.confidence, raw: angle };
  }

  onMoveStart(keypoints) {
    const leg = getBestLeg(keypoints);
    if (leg) this.repStartX = leg.ankle.x;
  }

  isValidMovement(keypoints) {
    // If they walk away during a rep, invalidate it
    const leg = getBestLeg(keypoints);
    if (!leg || this.repStartX === null) return true;
    const legLength = getDist(leg.hip, leg.knee) + getDist(leg.knee, leg.ankle);
    return Math.abs(leg.ankle.x - this.repStartX) < (legLength * 0.5);
  }

  getTrackedIndices(keypoints) {
    const leg = getBestLeg(keypoints);
    return leg ? leg.indices : null;
  }
}
