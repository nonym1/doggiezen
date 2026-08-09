// physics.js
//
// Deterministic, environment-agnostic simulation of a DoggieZen run: gravity, flaps, pipe
// spawning/movement, scoring, and collision. Given a seed and the list of fixed-step indices
// at which the player flapped, simulateRun() always produces the exact same outcome — no
// Math.random(), no wall-clock reads, no DOM.
//
// WHY THIS EXISTS: the server used to only bound a submitted score against wall-clock time
// (see MAX_RUN_DURATION_MS in server.js) plus a lighter heuristic on flap-timing plausibility
// (evaluateFlapEvidence()). Neither of those actually replays the game — a determined cheater
// who faked plausible-looking flap timestamps could still claim a score the server had no way
// to check against what those inputs would really have produced. This module closes that gap:
// /api/run/submit now regenerates the SAME pipe layout the player's client used (via the seed
// server issued at /api/run/start) and replays their actual recorded flaps through it,
// producing an independently-computed score to check the claim against.
//
// IMPORTANT — this is a real replay, not a byte-perfect one. The client runs on
// requestAnimationFrame, whose real-world cadence varies by device (a flap "during" a given
// 16.67ms window could, depending on exactly when within that window the event fires, end up
// counted in this step or the next one). The server can't observe that sub-frame timing, only
// the flap's timestamp — so simulateRun()'s result is used as a tight ceiling with a small
// tolerance (see REPLAY_SCORE_TOLERANCE in server.js), not an exact-match gate. That tolerance
// is deliberately small enough to be useless for meaningfully inflating a score, but large
// enough that an honest player never gets flagged over which side of a frame boundary a tap
// landed on.
//
// Loadable both ways:
//   const physics = require('./physics');           // server.js (Node/CommonJS)
//   <script src="physics.js"></script>               // would also work as a plain global,
//                                                        though the client currently embeds an
//                                                        identical inline copy instead — see
//                                                        the note at the top of this file.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DZSim = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- Gameplay constants, mirrored EXACTLY from doggiezen-2-7-1.html's own game loop. ----
  // If you change gravity, flap strength, pipe gap/width, speed ramp, spawn cadence, or canvas
  // size in the client, mirror the change here (and in the client's embedded copy of this
  // simulation) too — otherwise the server starts rejecting honest runs, or worse, stops
  // catching inflated ones.
  const W = 440, H = 800;
  const DOG_X = 110;
  const DOG_R = 28 * 0.72; // 28 * DOG_SCALE
  const GRAVITY = 0.45;
  const FLAP = -8.4;
  const PIPE_GAP = 210;
  const PIPE_W = 68;
  const GROUND_Y = H - 26;
  const PIPE_SPAWN_STEPS = 100; // client's pipeTimer threshold — one spawn every 100 fixed steps
  const PIPE_MARGIN = 80;
  const BASE_SPEED = 3.2;
  const SPEED_STEP = 0.3;
  const SPEED_CAP = 7;
  const MOVING_PIPE_MIN_SCORE = 5;
  const MOVING_PIPE_CHANCE = 0.3;

  // One fixed physics step represents this much real time. Both the client's accumulator loop
  // and the server's replay use this same constant, so a given real-world flap timestamp maps
  // to the same step index on both sides (see stepIndexForTime() below).
  const FIXED_DT_MS = 1000 / 60;

  function stepIndexForTime(ms) {
    return Math.floor(ms / FIXED_DT_MS);
  }

  /** mulberry32 — small, fast, non-cryptographic seeded PRNG. Not security-sensitive: the
   *  seed just needs to make pipe layouts reproducible between client and server, not to
   *  resist an attacker who already knows it (they'd need the exact flap timing to matter
   *  anyway, which is the part actually being checked). */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Runs a full deterministic simulation from a seed + the set of fixed-step indices at
   *  which a flap occurred, until either a collision/ground hit or maxSteps is reached.
   *
   *  Note on simultaneous death + score in the same step: the original client's per-frame
   *  loop doesn't short-circuit on a mid-frame collision (it keeps iterating the pipes array
   *  that same frame), so in a vanishingly rare edge case it could award a point in the exact
   *  frame a player also dies. This simulation stops immediately on death instead, which can
   *  only ever make its score equal to or ONE LOWER than what that exact edge case would give
   *  — never higher. For an anti-cheat ceiling that's the safe direction to round, so this is
   *  an intentional simplification, not a bug. */
  function simulateRun({ seed, flapSteps, maxSteps }) {
    const rand = mulberry32(seed >>> 0);
    const flapSet = new Set(flapSteps || []);
    let dogY = H / 2;
    let dogVy = 0;
    let pipes = [];
    let pipeTimer = 0;
    let speed = BASE_SPEED;
    let score = 0;
    let bullPassed = 0;
    let died = false;
    let step = 0;

    function spawnPipe() {
      const gapY = PIPE_MARGIN + rand() * (H - PIPE_MARGIN * 2 - PIPE_GAP);
      const bull = rand() < 0.5;
      const moving = score >= MOVING_PIPE_MIN_SCORE && rand() < MOVING_PIPE_CHANCE;
      pipes.push({
        x: W + 40,
        gapY,
        baseGapY: gapY,
        passed: false,
        bull,
        moving,
        spawnStep: step,
        oscAmp: 40 + rand() * 30,
        oscSpeed: 0.02 + rand() * 0.015,
      });
    }

    for (step = 0; step < maxSteps; step++) {
      if (flapSet.has(step)) dogVy = FLAP;
      dogVy += GRAVITY;
      dogY += dogVy;
      if (dogY - DOG_R < 0) {
        dogY = DOG_R;
        dogVy = 0;
      }
      if (dogY + DOG_R > GROUND_Y) {
        died = true;
        break;
      }

      pipeTimer++;
      if (pipeTimer > PIPE_SPAWN_STEPS) {
        spawnPipe();
        pipeTimer = 0;
      }

      for (const p of pipes) {
        p.x -= speed;
        if (p.moving) {
          const raw = p.baseGapY + Math.sin((step - p.spawnStep) * p.oscSpeed) * p.oscAmp;
          p.gapY = Math.max(PIPE_MARGIN + PIPE_GAP / 2, Math.min(H - 26 - PIPE_MARGIN - PIPE_GAP / 2, raw));
        }
        if (!p.passed && p.x + PIPE_W < DOG_X - DOG_R) {
          p.passed = true;
          score++;
          if (p.bull) bullPassed++;
          if (score % 5 === 0 && speed < SPEED_CAP) speed += SPEED_STEP;
        }
        const withinX = DOG_X + DOG_R * 0.7 > p.x && DOG_X - DOG_R * 0.7 < p.x + PIPE_W;
        if (withinX) {
          const topEdge = p.gapY - PIPE_GAP / 2;
          const botEdge = p.gapY + PIPE_GAP / 2;
          if (dogY - DOG_R * 0.7 < topEdge || dogY + DOG_R * 0.7 > botEdge) {
            died = true;
            break;
          }
        }
      }
      if (died) break;
      pipes = pipes.filter((p) => p.x > -PIPE_W - 10);
    }

    return { score, bullPassed, died, steps: step };
  }

  return {
    mulberry32,
    simulateRun,
    stepIndexForTime,
    FIXED_DT_MS,
    W,
    H,
    GRAVITY,
    FLAP,
    PIPE_GAP,
    PIPE_W,
  };
});
