import { describe, expect, it } from 'vitest';
import { findConsolidations, findRules } from './consolidation.ts';
import { buildGraph } from './repertoire.ts';

const at = (graph: ReturnType<typeof buildGraph>, path: string) =>
  Object.values(graph.nodes).find(node => node.path.join(' ') === path)!;

describe('opponent-aware rules and consolidation', () => {
  it('detects the 2×2 central pawn tension square (c4, d4 vs c5, d5 → cxd5) and suppresses noisy setup deviations', () => {
    const graph = buildGraph(`
      1. d4 d5
      2. c4 c5
        (2... e6 3. Nf3 c5 (3... Nf6 4. g3 c5 (4... Be7 5. Bg2) (4... c6 5. Bg2) 5. cxd5) (3... Be7 4. g3) 4. cxd5)
        (2... c6 3. Nf3 Nf6 (3... e6 4. g3) 4. g3)
        (2... Nf6 3. Nf3)
      3. cxd5 *
    `);

    const { rules, findings } = findConsolidations(graph);
    const squareRule = rules.find(
      rule => rule.kind === 'pattern' && rule.signature === 'pattern:pawn-square:c4,d4/c5,d5',
    );
    expect(squareRule).toBeDefined();
    expect(squareRule).toMatchObject({
      kind: 'pattern',
      setup: 'c4, d4 vs c5, d5 pawn square',
      description: "2×2 pawn tension square (c4, d4 vs Black's c5, d5)",
      total: 3,
    });
    expect(squareRule!.moves).toHaveLength(1);
    expect(squareRule!.moves[0].san).toBe('cxd5');
    expect(squareRule!.moves[0].keys).toHaveLength(3);

    // No redundant "After …c5" trigger duplicating the exact same 3 cxd5 positions.
    expect(rules.some(rule => rule.signature === 'trigger:move:c5')).toBe(false);

    // Setup rules mark cxd5 as explained rather than an unexplained exception.
    const c4d4Rule = rules.find(rule => rule.kind === 'setup' && rule.setup === 'c4 d4')!;
    expect(c4d4Rule.explained?.[at(graph, 'd4 d5 c4 c5').key]).toMatchObject({
      signature: 'pattern:pawn-square:c4,d4/c5,d5',
    });
    const nf3Rule = rules.find(rule => rule.kind === 'setup' && rule.setup === 'Nf3 c4 d4')!;
    expect(nf3Rule.explained?.[at(graph, 'd4 d5 c4 e6 Nf3 c5').key]).toMatchObject({
      signature: 'pattern:pawn-square:c4,d4/c5,d5',
    });
    const g3Rule = rules.find(rule => rule.kind === 'setup' && rule.setup === 'Nf3 c4 d4 g3')!;
    expect(g3Rule.explained?.[at(graph, 'd4 d5 c4 e6 Nf3 Nf6 g3 c5').key]).toMatchObject({
      signature: 'pattern:pawn-square:c4,d4/c5,d5',
    });

    // None of the three cxd5 positions are flagged as deviations toward Nf3, g3, or Bg2.
    const cxd5Keys = new Set(squareRule!.moves[0].keys);
    expect(findings.filter(item => cxd5Keys.has(item.key) && item.current === 'cxd5')).toEqual([]);
  });

  it('detects early opponent bishop sorties leaving b7 undefended (…Bf5 / …Bg4 → Qb3)', () => {
    const graph = buildGraph(`
      1. d4 d5
      2. c4 Bf5
        (2... c6 3. Nf3 Bf5
          (3... Nf6 4. g3 Bf5 (4... Bg4 5. Qb3) (4... e6 5. Bg2) (4... g6 5. Bg2) 5. Qb3)
          (3... e6 4. g3)
          4. Qb3 Qc7 5. Nc3)
        (2... e6 3. Nf3 Nf6 4. g3)
      3. Qb3 e6 4. Qxb7 *
    `);

    const { rules, findings } = findConsolidations(graph);
    const bishopRule = rules.find(
      rule => rule.kind === 'pattern' && rule.signature === 'pattern:bishop-sortie:c8>b7',
    );
    expect(bishopRule).toBeDefined();
    expect(bishopRule).toMatchObject({
      kind: 'pattern',
      setup: "Black's c8 bishop out (b7 undefended)",
      description: "Black's c8 bishop developed out, leaving b7 undefended",
      total: 4,
    });
    expect(bishopRule!.moves).toHaveLength(1);
    expect(bishopRule!.moves[0].san).toBe('Qb3');
    expect(bishopRule!.moves[0].keys).toHaveLength(4);

    // 4. Qxb7 (b7 already attacked) and 5. Nc3 (b7 defended by Qc7) are NOT conflated into the Qb3 rule.
    expect(bishopRule!.moves[0].keys).not.toContain(at(graph, 'd4 d5 c4 Bf5 Qb3 e6').key);
    expect(bishopRule!.moves[0].keys).not.toContain(at(graph, 'd4 d5 c4 c6 Nf3 Bf5 Qb3 Qc7').key);

    // Noisy setup-deviation proposals for Qb3 are suppressed.
    const qb3Keys = new Set(bishopRule!.moves[0].keys);
    expect(findings.filter(item => qb3Keys.has(item.key) && item.current === 'Qb3')).toEqual([]);
  });

  it('detects unopposed flank pawn challenges (…c5 vs d4 with d5 empty) and flags inconsistencies within the pattern', () => {
    // Consistent 4/4 case: all four lines push d5.
    const consistent = buildGraph(`
      1. d4 c5
        (1... Nf6 2. Nf3 c5 (2... e6 3. c4 c5 4. d5) (2... d5 3. c4) 3. d5)
        (1... e6 2. Nf3 c5 (2... d5 3. c4) 3. d5)
        (1... g6 2. Nf3)
      2. d5 *
    `);
    const clean = findConsolidations(consistent);
    const cleanRule = clean.rules.find(
      rule => rule.kind === 'pattern' && rule.signature === 'pattern:pawn-challenge:c5>d4',
    );
    expect(cleanRule).toMatchObject({
      kind: 'pattern',
      setup: '…c5 challenges d4 (d5 empty)',
      description: "Black's pawn on c5 challenges d4 with d5 empty",
      total: 4,
    });
    expect(cleanRule!.moves).toHaveLength(1);
    expect(cleanRule!.moves[0].san).toBe('d5');
    expect(
      clean.findings.filter(
        item => item.key === at(consistent, 'd4 c5').key && item.proposed === 'Nf3',
      ),
    ).toEqual([]);

    // Inconsistent 3/4 case: 1. d4 c5 plays 2. c4 (and continues 2...e6 3. Nf3) while the other 3 push d5.
    const inconsistent = buildGraph(`
      1. d4 c5
        (1... Nf6 2. Nf3 c5 (2... e6 3. c4 c5 4. d5) (2... d5 3. c4) 3. d5)
        (1... e6 2. Nf3 c5 (2... d5 3. c4) 3. d5)
        (1... g6 2. Nf3)
      2. c4 e6 3. Nf3 *
    `);
    const mixed = findConsolidations(inconsistent);
    const mixedRule = mixed.rules.find(
      rule => rule.kind === 'pattern' && rule.signature === 'pattern:pawn-challenge:c5>d4',
    );
    expect(mixedRule).toMatchObject({ total: 4 });
    expect(mixedRule!.moves.map(move => [move.san, move.keys.length])).toEqual([
      ['d5', 3],
      ['c4', 1],
    ]);
    // Subsequent ply 1. d4 c5 2. c4 e6 is NOT re-flagged because the challenge already existed at 1. d4 c5.
    expect(mixedRule!.moves.flatMap(move => move.keys)).not.toContain(
      at(inconsistent, 'd4 c5 c4 e6').key,
    );

    const unify = mixed.findings.find(
      item => item.key === at(inconsistent, 'd4 c5').key && item.proposed === 'd5',
    );
    expect(unify).toBeDefined();
    expect(unify!.current).toBe('c4');
    expect(unify!.peers).toMatchObject({
      count: 3,
      currentCount: 1,
      ruleKind: 'pattern',
      ruleSignature: 'pattern:pawn-challenge:c5>d4',
      reason: '…c5 challenges d4 (d5 empty)',
    });
    // Because 1. d4 c5 is governed by the …c5 pattern rule, setup-rule consistency does not fire for Nf3.
    expect(
      mixed.findings.find(
        item =>
          item.key === at(inconsistent, 'd4 c5').key &&
          item.proposed === 'Nf3' &&
          item.peers?.ruleKind === 'setup',
      ),
    ).toBeUndefined();
  });

  it('detects move-by-move opponent triggers across setups without creating noise for quiet moves', () => {
    const graph = buildGraph(`
      1. d4 d5
        (1... e5 2. dxe5)
        (1... c5 2. d5)
        (1... Nf6 2. Nf3 d5 (2... c5 3. d5) (2... e5 3. dxe5) 3. c4)
        (1... e6 2. Nf3 d5 3. c4)
        (1... g6 2. Nf3)
        (1... d6 2. Nf3)
      2. c4 dxc4 (2... e6 3. Nf3 dxc4 4. Qa4+) (2... c6 3. Nf3 Nf6 4. g3) 3. Qa4+ *
    `);

    const { rules, findings } = findConsolidations(graph);
    expect(rules.find(rule => rule.signature === 'trigger:move:d5')).toMatchObject({
      kind: 'trigger',
      setup: 'After …d5',
      description: 'When Black plays …d5',
      total: 3,
    });
    expect(rules.find(rule => rule.signature === 'trigger:move:dxc4')).toMatchObject({
      kind: 'trigger',
      setup: 'After …dxc4',
      total: 2,
    });
    expect(rules.find(rule => rule.signature === 'pattern:pawn-challenge:e5>d4')).toMatchObject({
      kind: 'pattern',
      setup: '…e5 challenges d4 (d5 empty)',
      total: 2,
    });

    // All three special replies after 1. d4 are explained on the d4 setup rule.
    const d4Rule = rules.find(rule => rule.kind === 'setup' && rule.setup === 'd4')!;
    expect(d4Rule.explained?.[at(graph, 'd4 d5').key]?.signature).toBe('trigger:move:d5');
    expect(d4Rule.explained?.[at(graph, 'd4 c5').key]?.signature).toBe(
      'pattern:pawn-challenge:c5>d4',
    );
    expect(d4Rule.explained?.[at(graph, 'd4 e5').key]?.signature).toBe(
      'pattern:pawn-challenge:e5>d4',
    );

    // No setup-consistency findings proposing Nf3 against 1...e5 or 1...c5.
    expect(
      findings.filter(
        item =>
          (item.key === at(graph, 'd4 e5').key || item.key === at(graph, 'd4 c5').key) &&
          item.proposed === 'Nf3',
      ),
    ).toEqual([]);
  });

  it('detects bishop pins on developed knights across setups', () => {
    const graph = buildGraph(`
      1. d4 Nf6 2. c4 e6 3. Nc3 Bb4
        (3... d5 4. Nf3 Bb4 (4... Be7 5. Bf4) (4... c6 5. Bf4) 5. Qc2)
        (3... Be7 4. Nf3)
        (3... c5 4. d5)
      4. Qc2 *
    `);
    const { rules } = findRules(graph);
    const pinRule = rules.find(rule => rule.signature === 'pattern:pin:b4-c3');
    expect(pinRule).toMatchObject({
      kind: 'pattern',
      setup: '…Bb4 pins Nc3',
      description: "Black's bishop on b4 pins Nc3",
      total: 2,
    });
    expect(pinRule!.moves[0].san).toBe('Qc2');
  });

  it('applies all opponent-aware patterns and triggers symmetrically for Black repertoires', () => {
    // 1. Black 2×2 central pawn tension square (c5, d5 vs c4, d4 → cxd4).
    const blackSquare = buildGraph(
      `
      1. d4 d5 2. Nf3 (2. e3 c5 3. c4 cxd4) (2. Bf4 c5 3. c4 cxd4) c5 3. c4 cxd4 *
    `,
      'black',
    );
    const sqRules = findRules(blackSquare).rules;
    expect(
      sqRules.find(rule => rule.signature === 'pattern:pawn-square:c5,d5/c4,d4'),
    ).toMatchObject({
      kind: 'pattern',
      setup: 'c5, d5 vs c4, d4 pawn square',
      description: "2×2 pawn tension square (c5, d5 vs White's c4, d4)",
      total: 3,
    });

    // 2. Black early White bishop sortie (Bf4 / Bg5 leaving b2 undefended → Qb6).
    const blackBishop = buildGraph(
      `
      1. d4 d5 2. c4 c6 3. Bf4
        (3. Nf3 Nf6 4. Bf4 (4. Bg5 Qb6) (4. e3 e6) (4. Nc3 e6) Qb6)
        (3. e3 Nf6)
        (3. Nc3 Nf6)
      Qb6 *
    `,
      'black',
    );
    const bishRules = findRules(blackBishop).rules;
    const bishRule = bishRules.find(rule => rule.signature === 'pattern:bishop-sortie:c1>b2');
    expect(bishRule).toMatchObject({
      kind: 'pattern',
      setup: "White's c1 bishop out (b2 undefended)",
      description: "White's c1 bishop developed out, leaving b2 undefended",
      total: 3,
    });
    expect(bishRule!.moves[0].san).toBe('Qb6');

    // 3. Black unopposed flank challenge (c4 vs d5 with d4 empty → d4), with 3/4 inconsistency.
    const blackChallenge = buildGraph(
      `
      1. Nf3 (1. g3 d5 2. Bg2 Nf6 3. c4 d4) (1. e3 d5 2. Nf3 Nf6 3. c4 d4)
      d5 2. c4 (2. g3 Nf6 3. c4 d4) (2. e3 Nf6) (2. d3 Nf6)
      e6 *
    `,
      'black',
    );
    const { rules: bcRules, findings: bcFindings } = findConsolidations(blackChallenge);
    const challengeRule = bcRules.find(rule => rule.signature === 'pattern:pawn-challenge:c4>d5');
    expect(challengeRule).toMatchObject({
      kind: 'pattern',
      setup: 'c4 challenges d5 (d4 empty)',
      description: "White's pawn on c4 challenges d5 with d4 empty",
      total: 4,
    });
    expect(challengeRule!.moves.map(move => [move.san, move.keys.length])).toEqual([
      ['d4', 3],
      ['e6', 1],
    ]);
    const blackUnify = bcFindings.find(
      item => item.key === at(blackChallenge, 'Nf3 d5 c4').key && item.proposed === 'd4',
    );
    expect(blackUnify).toBeDefined();
    expect(blackUnify!.peers).toMatchObject({
      count: 3,
      currentCount: 1,
      ruleKind: 'pattern',
      reason: 'c4 challenges d5 (d4 empty)',
    });

    // 4. Black last-move trigger (After cxd5 → exd5 across setups).
    const blackTrigger = buildGraph(
      `
      1. d4 d5 2. c4 e6 3. cxd5
        (3. Nf3 Nf6 4. cxd5 exd5)
        (3. Nc3 Nf6 4. cxd5 (4. Bg5 Be7) (4. Nf3 Be7) exd5)
      exd5 *
    `,
      'black',
    );
    const trigRules = findRules(blackTrigger).rules;
    expect(trigRules.find(rule => rule.signature === 'trigger:move:cxd5')).toMatchObject({
      kind: 'trigger',
      setup: 'After cxd5',
      description: 'When White plays cxd5',
      total: 3,
    });
  });

  it('ignores non-target moves for b7/b2 bishop-sortie and excludes stale pawn challenges after piece retreats', () => {
    // Black plays …h6 against Bg5 (not targeting b2): should become After Bg5 → h6, not b2 undefended.
    const sicilian = buildGraph(
      `
      1. e4 c5 2. Nf3 Nc6 3. d4
        (3. Bb5 g6 4. Bxc6 bxc6 5. O-O Bg7 6. c3 Nf6 7. d3 O-O 8. Bg5 h6)
        (3. Bc4 e6 4. Nc3 Nf6 5. d3 d5 6. exd5 exd5 7. Bb5 Bd6 8. Bg5 O-O)
      cxd4 4. Nxd4 g6 5. Nc3 Bg7 6. Nxc6 bxc6 7. Bc4 e6 8. O-O Ne7 9. Bg5 h6 *
    `,
      'black',
    );
    const sicRules = findRules(sicilian).rules;
    expect(sicRules.some(rule => rule.signature.includes('bishop-sortie'))).toBe(false);
    expect(sicRules.find(rule => rule.signature === 'trigger:move:Bg5')).toMatchObject({
      kind: 'trigger',
      total: 3,
    });

    // QG/Slav c8-bishop sorties (4× Qb3, 1× Ne5) stay clean even when QGA lines (2...dxc4) also have Bf5/Bg4.
    const catalan = buildGraph(`
      1. d4 d5 2. c4 Bf5
        (2... dxc4 3. e3 Bf5 (3... Nf6 4. Nf3 Bg4 5. Bxc4) 4. Nf3)
        (2... c6 3. Nf3 Bf5
          (3... Bg4 4. Ne5)
          (3... Nf6 4. g3 Bf5 (4... Bg4 5. Qb3) (4... e6 5. Bg2) 5. Qb3)
          4. Qb3)
      3. Qb3 *
    `);
    const cat = findConsolidations(catalan);
    const qgBishop = cat.rules.find(rule => rule.signature === 'pattern:qg-bishop-sortie:c8>b7');
    expect(qgBishop).toMatchObject({ kind: 'pattern', total: 5 });
    expect(qgBishop!.moves.map(move => [move.san, move.keys.length])).toEqual([
      ['Qb3', 4],
      ['Ne5', 1],
    ]);
    expect(
      cat.findings.find(
        item => item.key === at(catalan, 'd4 d5 c4 c6 Nf3 Bg4').key && item.proposed === 'Qb3',
      )?.peers,
    ).toMatchObject({ count: 4, currentCount: 1, ruleKind: 'pattern' });

    // A queen/knight retreating off d5 long after …c5 must not dilute the fresh …c5 challenges d4 pattern.
    const retreat = buildGraph(`
      1. d4 c5
        (1... Nf6 2. Nf3 c5 3. d5)
        (1... d5 2. c4 e6 3. Nf3 c5 4. cxd5 Qxd5 5. Nc3 Qd8 6. g3 Nc6 7. Be3)
      2. d5 *
    `);
    const retRule = findRules(retreat).rules.find(
      rule => rule.signature === 'pattern:pawn-challenge:c5>d4',
    );
    expect(retRule).toMatchObject({ total: 2 });
    expect(retRule!.moves).toHaveLength(1);
    expect(retRule!.moves[0].san).toBe('d5');
  });
});
