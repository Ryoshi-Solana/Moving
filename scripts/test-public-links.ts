import { verifiedPublicUrl } from '@/lib/public-links';

const cases: Array<[string, string | undefined, readonly string[], string | null]> = [
  ['accepts the exact token page', 'https://pump.fun/coin/abc123', ['pump.fun', 'www.pump.fun'], 'https://pump.fun/coin/abc123'],
  ['accepts a specific X profile', 'https://x.com/moving_project', ['x.com', 'www.x.com'], 'https://x.com/moving_project'],
  ['rejects a generic Pump.fun homepage', 'https://pump.fun/', ['pump.fun'], null],
  ['rejects a generic X homepage', 'https://x.com/', ['x.com'], null],
  ['rejects HTTP', 'http://pump.fun/coin/abc123', ['pump.fun'], null],
  ['rejects an unapproved hostname', 'https://evil.example/coin/abc123', ['pump.fun'], null],
  ['rejects a deceptive subdomain', 'https://pump.fun.evil.example/coin/abc123', ['pump.fun'], null],
  ['rejects unsupported schemes', 'javascript:alert(1)', ['x.com'], null],
  ['rejects malformed URLs', 'not a URL', ['pump.fun'], null],
  ['rejects missing values', undefined, ['x.com'], null]
];

let passed = 0;
let failed = 0;
for (const [label, raw, hosts, expected] of cases) {
  const actual = verifiedPublicUrl(raw, hosts);
  if (actual === expected) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL ${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}
console.log(`Public link validation: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
