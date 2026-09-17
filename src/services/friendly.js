const fs = require("fs");
const path = require("path");
const axios = require("axios");

if (globalThis.ASC_TARGET === undefined) {
  globalThis.ASC_TARGET = 0;
}

const { getWasmSolver } = require("friendly-pow/node/api/wasm");
const {
  getPuzzleSolverInputs,
  combineSolutions,
  NUMBER_OF_PUZZLES_OFFSET,
  PUZZLE_DIFFICULTY_OFFSET,
} = require("friendly-pow/node/puzzle");
const { createDiagnosticsBuffer } = require("friendly-pow/node/diagnostics");
const { encode, decode } = require("friendly-pow/node/base64");
const { difficultyToThreshold } = require("friendly-pow/node/encoding");

const DEFAULT_ENDPOINT = "https://api.friendlycaptcha.com/api/v1/puzzle";

let wasmModulePromise = null;
function loadWasmModule() {
  if (!wasmModulePromise) {
    wasmModulePromise = (async () => {
      const pkgPath = require.resolve("friendly-pow/package.json");
      const wasmPath = path.join(path.dirname(pkgPath), "wasm", "optimized.wasm");
      const bytes = fs.readFileSync(wasmPath);
      return WebAssembly.compile(bytes);
    })();
  }
  return wasmModulePromise;
}

async function fetchPuzzle(puzzleEndpoint, sitekey) {
  const url = puzzleEndpoint + "?sitekey=" + encodeURIComponent(sitekey);
  const res = await axios.get(url, {
    timeout: 20000,
    headers: { "x-frc-client": "js-0.9.0" },
  });
  const data = res.data;
  if (!data || !data.success || !data.data || !data.data.puzzle) {
    throw new Error("Invalid puzzle response: " + JSON.stringify(data).slice(0, 200));
  }
  return data.data.puzzle;
}

async function solveFriendly({ sitekey, puzzleEndpoint, timeout = 180 } = {}) {
  const startTime = Date.now();
  if (!sitekey) {
    throw new Error("sitekey is required");
  }
  const endpoint = puzzleEndpoint || DEFAULT_ENDPOINT;
  const timeoutMs = Math.min(Math.max((timeout || 180) * 1000, 10000), 600000);

  const puzzle = await fetchPuzzle(endpoint, sitekey);
  const parts = String(puzzle).split(".");
  if (parts.length < 2) {
    throw new Error("Malformed puzzle (expected signature.base64)");
  }

  const buffer = decode(parts[1]);
  const n = buffer[NUMBER_OF_PUZZLES_OFFSET];
  const threshold = difficultyToThreshold(buffer[PUZZLE_DIFFICULTY_OFFSET]);
  if (!n || n <= 0 || n > 512) {
    throw new Error("Malformed puzzle (bad puzzle count)");
  }

  const inputs = getPuzzleSolverInputs(buffer, n);
  const solve = await getWasmSolver(await loadWasmModule());

  const solutions = [];
  for (const input of inputs) {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error("Timeout solving FriendlyCaptcha puzzle");
    }
    const out = solve(input, threshold);
    const s = out && out[0];
    const h = out && out[1];
    if (!s || !h || h.length === 0) {
      throw new Error("No solution found for puzzle part");
    }
    solutions.push(s.slice(-8));
  }

  const combined = combineSolutions(solutions);
  const elapsedSec = (Date.now() - startTime) / 1000;
  const diagnostics = createDiagnosticsBuffer(2, elapsedSec);
  const solution = `${parts[0]}.${parts[1]}.${encode(combined)}.${encode(diagnostics)}`;

  return {
    success: true,
    data: {
      solution,
      puzzles: n,
      field: "frc-captcha-solution",
    },
    duration: Date.now() - startTime,
  };
}

module.exports = { solveFriendly };
