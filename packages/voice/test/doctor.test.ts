import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceDoctor, type VoiceDoctorDeps } from '../src/index.ts';

const base: VoiceDoctorDeps = {
  platform: 'darwin', sayAvailable: true, voiceCount: 40,
  swiftcPresent: true, whisperBinPresent: false, whisperModelPresent: false, micToolPresent: false,
  resolvedStt: 'apple',
};
const deps = (o: Partial<VoiceDoctorDeps> = {}): VoiceDoctorDeps => ({ ...base, ...o });
const find = (cs: ReturnType<typeof voiceDoctor>, re: RegExp) => cs.find((c) => re.test(c.name));

test('a healthy Mac with Apple Speech + say passes, no fix lines', () => {
  const cs = voiceDoctor(deps());
  assert.ok(find(cs, /Voice out/)?.status === 'pass');
  assert.ok(find(cs, /Apple Speech/)?.status === 'pass');
  for (const c of cs) if (c.status === 'pass') assert.equal(c.fix, undefined);
});

test('non-darwin: one warn that voice is macOS-only, and the app still runs', () => {
  const cs = voiceDoctor(deps({ platform: 'linux' }));
  assert.equal(cs.length, 1);
  assert.equal(cs[0].status, 'warn');
  assert.match(cs[0].detail, /macOS-only/);
  assert.ok(cs[0].fix);
});

test('no say: spoken replies warn with a reinstall fix, voice-in can still pass', () => {
  const cs = voiceDoctor(deps({ sayAvailable: false, voiceCount: 0 }));
  const out = find(cs, /Voice out/)!;
  assert.equal(out.status, 'warn');
  assert.match(out.fix ?? '', /xcode-select|Command Line Tools/);
});

test('whisper fallback passes when swiftc is absent but the model + mic tool are present', () => {
  const cs = voiceDoctor(deps({ swiftcPresent: false, resolvedStt: 'whisper', whisperBinPresent: true, whisperModelPresent: true, micToolPresent: true }));
  assert.equal(find(cs, /whisper/)?.status, 'pass');
});

test('nothing for voice-in: warn (degrade to text) with a concrete fix, never fail', () => {
  const cs = voiceDoctor(deps({ swiftcPresent: false, resolvedStt: null, whisperBinPresent: false, whisperModelPresent: false, micToolPresent: false }));
  const vin = find(cs, /Voice in/)!;
  assert.equal(vin.status, 'warn');
  assert.match(vin.detail, /degrades to text|still type/);
  assert.match(vin.fix ?? '', /xcode-select|whisper/);
  assert.ok(!cs.some((c) => c.status === 'fail'), 'voice missing must never fail the doctor');
});
