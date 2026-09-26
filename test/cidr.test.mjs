// ALLOWED_CIDRS parsing and matching, IPv4 and IPv6.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ipAllowed, parseCidr, parseCidrList } from '../src/cidr.ts';

const list = (s) => parseCidrList(s).cidrs;

test('IPv4 ranges', () => {
  const c = list('10.1.0.0/16, 203.0.113.7');
  assert.equal(ipAllowed('10.1.200.3', c), true);
  assert.equal(ipAllowed('10.2.0.1', c), false);
  assert.equal(ipAllowed('203.0.113.7', c), true);
  assert.equal(ipAllowed('203.0.113.8', c), false);
});

test('odd prefix lengths', () => {
  const c = list('192.168.1.16/28');
  assert.equal(ipAllowed('192.168.1.31', c), true);
  assert.equal(ipAllowed('192.168.1.32', c), false);
  assert.equal(ipAllowed('192.168.1.15', c), false);
});

test('/0 matches every address of that family only', () => {
  assert.equal(ipAllowed('8.8.8.8', list('0.0.0.0/0')), true);
  assert.equal(ipAllowed('2001:db8::1', list('0.0.0.0/0')), false);
});

test('IPv6 ranges', () => {
  const c = list('2001:db8:abcd::/48');
  assert.equal(ipAllowed('2001:db8:abcd:12::1', c), true);
  assert.equal(ipAllowed('2001:DB8:ABCD:ffff:ffff:ffff:ffff:ffff', c), true);
  assert.equal(ipAllowed('2001:db8:abce::1', c), false);
  assert.equal(ipAllowed('10.0.0.1', c), false);
});

test('IPv4-mapped IPv6 matches the IPv4 range', () => {
  assert.equal(ipAllowed('::ffff:10.1.2.3', list('10.1.0.0/16')), true);
  assert.equal(ipAllowed('::ffff:10.2.2.3', list('10.1.0.0/16')), false);
});

test('bad entries are reported, not matched', () => {
  const { cidrs, invalid } = parseCidrList('10.0.0.0/8, 300.1.1.1, 10.0.0.01, 1.2.3.4/33, 2001:db8::1::2, , fe80::/129, 1:2:3:4:5:6:7:8::');
  assert.equal(cidrs.length, 1);
  assert.deepEqual(invalid, ['300.1.1.1', '10.0.0.01', '1.2.3.4/33', '2001:db8::1::2', 'fe80::/129', '1:2:3:4:5:6:7:8::']);
});

test('an empty list matches nothing, and junk addresses never match', () => {
  assert.equal(ipAllowed('10.0.0.1', []), false);
  const c = list('0.0.0.0/0');
  for (const ip of ['', 'not an ip', '10.0.0.0/8', '1.2.3']) assert.equal(ipAllowed(ip, c), false, ip);
});

test('parseCidr shapes', () => {
  assert.deepEqual(parseCidr('10.0.0.0/8'), { bytes: new Uint8Array([10, 0, 0, 0]), prefix: 8, family: 4 });
  assert.equal(parseCidr('::1')?.family, 6);
  assert.equal(parseCidr('::1')?.prefix, 128);
});
