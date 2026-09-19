import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cargoFamily,
  hazardDeclaration,
  terminalCommodity,
  inferCargo,
} from './ais-cargo.js';

test('AIS families are read from the type decade', () => {
  assert.equal(cargoFamily('70'), 'cargo');
  assert.equal(cargoFamily('79'), 'cargo');
  assert.equal(cargoFamily('80'), 'tanker');
  assert.equal(cargoFamily('89'), 'tanker');
  assert.equal(cargoFamily('52'), '');
  assert.equal(cargoFamily('abc'), '');
});

test('hazard categories decode from the second digit', () => {
  assert.equal(hazardDeclaration('81').category, 'A');
  assert.equal(hazardDeclaration('72').category, 'B');
  assert.equal(hazardDeclaration('73').category, 'C');
  assert.equal(hazardDeclaration('84').category, 'D');
  assert.match(hazardDeclaration('81').note, /most hazardous/);
});

test('codes that declare nothing produce no hazard claim', () => {
  assert.equal(hazardDeclaration('70'), null, '0 means unspecified, not category zero');
  assert.equal(hazardDeclaration('79'), null, '9 means no additional information');
  assert.equal(hazardDeclaration('75'), null, 'reserved codes are not categories');
  assert.equal(hazardDeclaration('52'), null, 'a tug declares no cargo');
});

test('a hazard declaration outranks every inference', () => {
  const cargo = inferCargo({ type: '81', destination: 'AU NTL', nav_status: 5 }, { trend: 'LOADING', deltaM: 5 });
  assert.equal(cargo.confidence, 'BROADCAST');
  assert.match(cargo.statement, /IMO category A/);
});

test('a single-commodity terminal names the commodity', () => {
  const terminal = terminalCommodity('AU NTL', '79');
  assert.equal(terminal.commodity, 'coal');
  assert.equal(terminal.role, 'export');
});

test('the terminal inference respects the hull type', () => {
  // Mailiao is a crude/petrochemical berth; a dry-cargo hull is not loading crude.
  assert.equal(terminalCommodity('TWMLI', '79'), null);
  assert.ok(terminalCommodity('TWMLI', '80'));
  // Port Hedland ships iron ore, not oil.
  assert.equal(terminalCommodity('AUPHE', '80'), null);
  assert.ok(terminalCommodity('AUPHE', '70'));
});

test('multi-commodity ports are never used for inference', () => {
  assert.equal(terminalCommodity('NLRTM', '79'), null);
  assert.equal(terminalCommodity('SGSIN', '80'), null);
});

test('loading at a coal terminal reads as loading coal', () => {
  const cargo = inferCargo(
    { type: '79', destination: 'AU NTL', nav_status: 5 },
    { trend: 'LOADING', deltaM: 5.7 },
  );
  assert.equal(cargo.confidence, 'LIKELY');
  assert.match(cargo.statement, /Loading coal at Newcastle/);
  assert.match(cargo.statement, /not from a manifest/);
});

test('a terminal alone, with no cargo work, is not enough', () => {
  const cargo = inferCargo(
    { type: '79', destination: 'AU NTL', nav_status: 0, speed: 12 },
    { trend: 'UNKNOWN', deltaM: null },
  );
  assert.equal(cargo.confidence, 'CLASS', 'no laden state and no draught trend');
});

test('without a terminal only the hull class is claimed', () => {
  assert.match(inferCargo({ type: '80' }, {}).statement, /Liquid bulk/);
  assert.match(inferCargo({ type: '70' }, {}).statement, /Dry or general cargo/);
  assert.equal(inferCargo({ type: '80' }, {}).confidence, 'CLASS');
});

test('a ballast hull is described as empty', () => {
  assert.match(inferCargo({ type: '80', load_state: 'BALLAST' }, {}).statement, /running empty/);
});

test('non-cargo hulls carry nothing, and say why', () => {
  const cargo = inferCargo({ type: '52' }, {});
  assert.equal(cargo.confidence, 'UNKNOWN');
  assert.match(cargo.statement, /nothing to carry/);
  assert.deepEqual(cargo.basis, ['AIS ship type is not cargo or tanker']);
});

test('every verdict records what it was based on', () => {
  assert.ok(inferCargo({ type: '81' }, {}).basis.length);
  assert.ok(inferCargo({ type: '79', destination: 'AU NTL', nav_status: 5 }, { trend: 'LOADING' }).basis.length);
  assert.ok(inferCargo({ type: '70' }, {}).basis.length);
});

test('an absent ship type is unknown, not "carries nothing"', () => {
  const missing = inferCargo({ name: 'OI MARU' }, {});
  assert.equal(missing.confidence, 'UNKNOWN');
  assert.match(missing.statement, /No ship type broadcast/);
  assert.doesNotMatch(missing.statement, /nothing to carry/);

  const tug = inferCargo({ type: '52' }, {});
  assert.match(tug.statement, /nothing to carry/, 'a declared tug genuinely carries none');
});
