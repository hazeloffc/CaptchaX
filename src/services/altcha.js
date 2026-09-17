const crypto = require("crypto");
const axios = require("axios");

const ALGOS = {
  "SHA-1": "sha1",
  "SHA-256": "sha256",
  "SHA-384": "sha384",
  "SHA-512": "sha512",
};

function hashHex(algorithm, data) {
  const nodeAlg = ALGOS[String(algorithm || "SHA-256").toUpperCase()];
  if (!nodeAlg) {
    throw new Error("Unsupported algorithm: " + algorithm);
  }
  return crypto.createHash(nodeAlg).update(String(data), "utf8").digest("hex");
}

async function fetchChallenge(challengeurl) {
  const res = await axios.get(challengeurl, { timeout: 15000 });
  const data = res.data;
  if (!data || !data.challenge || !data.salt) {
    throw new Error("Invalid challenge response (missing challenge/salt)");
  }
  return data;
}

async function solveAltcha({ challengeurl, challenge, max, start, timeout = 60 } = {}) {
  const startTime = Date.now();
  let ch = challenge || null;

  if (!ch && challengeurl) {
    ch = await fetchChallenge(challengeurl);
  }
  if (!ch || !ch.challenge || !ch.salt) {
    throw new Error("challenge object or challengeurl is required");
  }

  const algorithm = ch.algorithm || "SHA-256";
  const maxNumber = Math.min(max || ch.maxnumber || 1e6, ch.maxnumber || 1e6);
  const startNumber = Math.max(start || 0, 0);
  const timeoutMs = Math.min(Math.max((timeout || 60) * 1000, 5000), 300000);

  let number = null;
  for (let n = startNumber; n <= maxNumber; n++) {
    if ((n & 4095) === 0 && Date.now() - startTime > timeoutMs) {
      throw new Error("Timeout solving Altcha challenge");
    }
    if (hashHex(algorithm, ch.salt + n) === ch.challenge) {
      number = n;
      break;
    }
  }

  if (number === null) {
    throw new Error("No solution found within maxnumber");
  }

  const payload = {
    algorithm,
    challenge: ch.challenge,
    number,
    salt: ch.salt,
    signature: ch.signature || null,
  };

  return {
    success: true,
    data: {
      payload: Buffer.from(JSON.stringify(payload)).toString("base64"),
      number,
      algorithm,
      salt: ch.salt,
      signature: ch.signature || null,
    },
    duration: Date.now() - startTime,
  };
}

module.exports = { solveAltcha };
