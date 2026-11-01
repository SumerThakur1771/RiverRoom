// Exact modulo bias of the old shuffle (x % n on 32-bit values) and the rejection rate of the
// new one, for every Fisher-Yates step size n = 2..52. Pure arithmetic, no randomness.
// Usage: node tools/measure/shuffle-bias.mjs
let worst = 0, worstN = 0, biased = 0;
for (let n = 2; n <= 52; n++) {
  const r = 2 ** 32 % n, q = Math.floor(2 ** 32 / n);
  if (r) { biased++; if (1 / q > worst) { worst = 1 / q; worstN = n; } }
}
const r52 = 2 ** 32 % 52, q52 = Math.floor(2 ** 32 / 52);
console.log(`old method: biased for ${biased} of 51 step sizes; worst relative bias ${worst.toExponential(3)} at n = ${worstN}`);
console.log(`n = 52: ${r52} results get ${q52 + 1} inputs, the other ${52 - r52} get ${q52}`);
console.log(`new method: rejects ${r52} of 2^32 inputs at n = 52 (probability ${(r52 / 2 ** 32).toExponential(3)} per draw); every result gets ${q52} inputs`);
