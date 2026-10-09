import { positiveIntOrDefault } from '@/lib/server-config';

const cases: Array<[string, string | undefined, number, number, number]> = [
  ['undefined value uses default', undefined, 20, 1000, 20],
  ['empty value uses default', '', 20, 1000, 20],
  ['non-numeric value uses default', 'abc', 20, 1000, 20],
  ['NaN-like value uses default', 'Infinity', 20, 1000, 20],
  ['zero uses default', '0', 20, 1000, 20],
  ['negative value uses default', '-4', 20, 1000, 20],
  ['decimal value uses default', '2.5', 20, 1000, 20],
  ['above maximum uses default', '1001', 20, 1000, 20],
  ['valid value is preserved', '45', 20, 1000, 45],
  ['valid minimum is preserved', '1', 20, 1000, 1],
  ['valid TTL is preserved', '3600', 60, 3600, 3600],
  ['TTL above maximum uses default', '3601', 60, 3600, 60]
];

let passed = 0;
let failed = 0;
for (const [label, raw, fallback, max, expected] of cases) {
  const actual = positiveIntOrDefault(raw, fallback, max);
  if (actual === expected) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL ${label}: expected ${expected}, got ${actual}`);
  }
}
console.log(`Server config: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
