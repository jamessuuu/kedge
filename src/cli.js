#!/usr/bin/env node
// kedge command line.
//
// Every command exits non-zero on failure and prints a stated error rather than
// a stack trace. That is release-standard row R6, and it is the row a technical
// visitor discovers fastest -- usually by pointing the tool at the wrong file.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runSimulation } from './raft/cluster.js';
import { check, DEFAULT_BUDGET } from './lin/wgl.js';
import { MODELS, kvRegisterModel, etcdRegisterModel } from './lin/models.js';
import { parseJepsenLog } from './io/jepsen.js';
import { parseBuildFlags, correctBuild, BUGS, formatBuildFlags } from './bugs.js';
import { FIXTURES, NEGATIVE_CONTROL, MEASURED_ON } from './fixtures.js';
import { renderSpaceTime } from './render.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
export const VENDOR = path.join(ROOT, 'vendor', 'porcupine');

/** Thrown for every condition a user can cause; never surfaces a stack trace. */
export class UserError extends Error {}

const USAGE = `kedge -- deterministic cluster simulator with a linearizability checker

  kedge demo                       one failing execution, checked and explained
  kedge run [options]              simulate a cluster and check the history
  kedge check <file.log>           check one Jepsen etcd history
  kedge corpus [options]           check all 102 Jepsen histories that carry a
                                   published Porcupine verdict, and compare
  kedge fixtures [options]         run the planted fixtures and the negative control
  kedge bugs                       list the build-flag fixtures

run options
  --seed <int>          default 4711
  --faults <script>     e.g. 150-700:L  (isolate the leader for ticks 150-700)
                             c200-400:3 (crash node 3)
                             200-500:0.1,600-900:2.3
  --build <flags>       comma separated, see \`kedge bugs\`; default: correct
  --ops <int>           operations to issue, default 60
  --clients <int>       default 4
  --nodes <odd int>     default 5
  --keys <int>          default 1
  --budget <int>        checker step budget, default ${DEFAULT_BUDGET}
  --batch <int>         AppendEntries batch size, default 8
  --json                machine-readable output

corpus / fixtures options
  --budget <int>        checker step budget
  --json                machine-readable output

exit codes
  0  ran, and the verdict was the expected one
  1  a bad argument, an unreadable or malformed input, or an unexpected verdict
`;

/**
 * @param {string[]} argv
 * @returns {{_: string[], [k: string]: any}}
 */
export function parseArgs(argv) {
  /** @type {any} */
  const out = { _: [] };
  const wantsValue = new Set([
    'seed', 'faults', 'build', 'ops', 'clients', 'nodes', 'keys', 'budget', 'batch', 'model',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const name = a.slice(2);
    if (name === 'json' || name === 'help') {
      out[name] = true;
      continue;
    }
    if (!wantsValue.has(name)) {
      throw new UserError('unknown option "' + a + '"\n\n' + USAGE);
    }
    const value = argv[++i];
    if (value === undefined) throw new UserError('option "' + a + '" needs a value');
    out[name] = value;
  }
  return out;
}

/**
 * @param {any} args
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function intOpt(args, name, fallback) {
  if (args[name] === undefined) return fallback;
  const raw = String(args[name]);
  if (!/^-?\d+$/.test(raw)) {
    throw new UserError('--' + name + ' must be an integer, got "' + raw + '"');
  }
  return Number(raw);
}

/**
 * @param {string} file
 * @returns {string}
 */
export function readLogFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    if (e.code === 'ENOENT') throw new UserError('no such file: ' + file);
    if (e.code === 'EACCES') throw new UserError('cannot read (permission denied): ' + file);
    throw new UserError('cannot read ' + file + ': ' + e.message);
  }
  if (stat.isDirectory()) throw new UserError(file + ' is a directory, not a history file');
  const MAX = 32 * 1024 * 1024;
  if (stat.size > MAX) {
    throw new UserError(
      file + ' is ' + stat.size + ' bytes; the limit is ' + MAX + ' bytes (32 MiB). ' +
        'kedge holds the whole history in memory and a file this large is not a Jepsen log.'
    );
  }
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new UserError('cannot read ' + file + ': ' + /** @type {Error} */ (err).message);
  }
}

// --------------------------------------------------------------------------
// commands

/** @param {any} args */
function cmdCheck(args) {
  const file = args._[1];
  if (!file) throw new UserError('check needs a file: kedge check <file.log>');
  const modelName = args.model === undefined ? 'etcd-register' : String(args.model);
  const model = MODELS[modelName];
  if (!model) {
    throw new UserError(
      'unknown model "' + modelName + '"; known models: ' + Object.keys(MODELS).join(', ')
    );
  }
  const budget = intOpt(args, 'budget', DEFAULT_BUDGET);
  if (budget <= 0) throw new UserError('--budget must be a positive integer, got ' + budget);

  const text = readLogFile(file);
  let history;
  try {
    history = parseJepsenLog(text, { source: path.basename(file) });
  } catch (err) {
    throw new UserError(/** @type {Error} */ (err).message);
  }
  const res = check(model, history, { budget });
  if (args.json) {
    print(JSON.stringify({ file, model: modelName, ...summarise(res) }, null, 2));
  } else {
    print(file + ': ' + verdictLine(res));
    if (res.witness) print('  witness: ' + res.witness.text);
  }
  return 0;
}

/** @param {any} args */
function cmdCorpus(args) {
  const budget = intOpt(args, 'budget', DEFAULT_BUDGET);
  const expectedPath = path.join(VENDOR, 'expected.json');
  let expected;
  try {
    expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  } catch (err) {
    throw new UserError(
      'cannot read the vendored corpus at ' + expectedPath + ': ' +
        /** @type {Error} */ (err).message
    );
  }
  const rows = [];
  let match = 0;
  let mismatch = 0;
  let unknown = 0;
  let skipped = 0;
  let steps = 0;
  const started = Date.now();

  for (const h of expected.histories) {
    if (h.expected === null) {
      skipped++;
      rows.push({ file: h.file, expected: null, got: null, status: 'no-published-verdict' });
      continue;
    }
    const text = readLogFile(path.join(VENDOR, 'jepsen', h.file));
    const history = parseJepsenLog(text, { source: h.file });
    const res = check(etcdRegisterModel, history, { budget });
    steps += res.steps;
    let status;
    if (res.verdict === 'unknown') {
      status = 'unknown';
      unknown++;
    } else if (res.verdict === h.expected) {
      status = 'match';
      match++;
    } else {
      status = 'MISMATCH';
      mismatch++;
    }
    rows.push({
      file: h.file,
      operations: history.length,
      expected: h.expected,
      got: res.verdict,
      steps: res.steps,
      status,
    });
  }

  const ms = Date.now() - started;
  const summary = {
    withPublishedVerdict: expected.logs_with_published_verdict,
    match,
    mismatch,
    unknown,
    skipped,
    budget,
    totalSteps: steps,
    ms,
  };
  if (args.json) {
    print(JSON.stringify({ summary, rows }, null, 2));
  } else {
    print('Jepsen etcd corpus (vendored from anishathalye/porcupine, MIT)');
    print(
      '  ' + match + ' of ' + expected.logs_with_published_verdict +
        ' histories matched Porcupine’s published verdict'
    );
    print('  ' + mismatch + ' mismatched, ' + unknown + ' exhausted the ' + budget + '-step budget');
    print('  ' + skipped + ' file has no published verdict (etcd_095.log is empty: the cluster failed to start)');
    print('  ' + steps + ' model transitions, ' + ms + ' ms total');
    for (const r of rows) {
      if (r.status === 'MISMATCH' || r.status === 'unknown') {
        print('  ' + r.status + ' ' + r.file + ': expected ' + r.expected + ', got ' + r.got);
      }
    }
  }
  return mismatch === 0 ? 0 : 1;
}

/** @param {any} args */
function cmdRun(args) {
  const seed = intOpt(args, 'seed', 4711);
  const budget = intOpt(args, 'budget', DEFAULT_BUDGET);
  let flags;
  try {
    flags = args.build === undefined ? correctBuild() : parseBuildFlags(String(args.build));
  } catch (err) {
    throw new UserError(/** @type {Error} */ (err).message);
  }
  /** @type {any} */
  const simOpts = {
    seed,
    faults: args.faults === undefined ? '' : String(args.faults),
    operations: intOpt(args, 'ops', 60),
    clients: intOpt(args, 'clients', 4),
    nodes: intOpt(args, 'nodes', 5),
    keys: intOpt(args, 'keys', 1),
    maxEntriesPerAppend: intOpt(args, 'batch', 8),
    flags,
  };
  let sim;
  try {
    sim = runSimulation(simOpts);
  } catch (err) {
    throw new UserError(/** @type {Error} */ (err).message);
  }
  const res = check(kvRegisterModel, sim.history, {
    budget,
    sabotage: { acceptOnBlock: flags.checkerAcceptOnBlock },
  });
  if (args.json) {
    print(JSON.stringify({ config: sim.config, stats: sim.stats, ...summarise(res) }, null, 2));
    return res.verdict === 'not-linearizable' ? 1 : 0;
  }
  print(
    'seed ' + seed +
      '  build ' + formatBuildFlags(flags) +
      '  faults ' + (simOpts.faults || 'none') +
      '  ' + sim.config.nodes + ' nodes, ' + sim.stats.operations + ' operations'
  );
  print(verdictLine(res));
  if (res.witness) print('  witness: ' + res.witness.text);
  print('');
  print(renderSpaceTime(sim, res, { model: kvRegisterModel, width: 64 }));
  return res.verdict === 'not-linearizable' ? 1 : 0;
}

/** @param {any} args */
function cmdFixtures(args) {
  const budget = intOpt(args, 'budget', DEFAULT_BUDGET);
  const results = [];
  let failed = 0;

  for (const f of FIXTURES) {
    let violations = 0;
    let controlViolations = 0;
    let unknown = 0;
    const witnesses = [];
    for (const seed of f.seeds) {
      const buggy = runSimulation({ ...f.sim, seed, flags: parseBuildFlags(f.id) });
      const r = check(kvRegisterModel, buggy.history, { budget });
      if (r.verdict === 'not-linearizable') {
        violations++;
        if (witnesses.length < 1 && r.witness) witnesses.push('seed ' + seed + ': ' + r.witness.text);
      } else if (r.verdict === 'unknown') unknown++;

      const control = runSimulation({ ...f.sim, seed, flags: correctBuild() });
      const cr = check(kvRegisterModel, control.history, { budget });
      if (cr.verdict === 'not-linearizable') controlViolations++;
    }
    const ok = violations >= f.minViolations && controlViolations === 0;
    if (!ok) failed++;
    results.push({
      id: f.id,
      title: f.title,
      seeds: f.seeds.length,
      violations,
      minViolations: f.minViolations,
      controlViolations,
      unknown,
      ok,
      witness: witnesses[0] || null,
    });
  }

  // The sabotaged checker: a history Porcupine calls non-linearizable must be
  // WRONGLY passed when the flag is on, and correctly rejected when it is off.
  const sabotage = sabotageCheck(budget);
  if (!sabotage.ok) failed++;
  results.push(sabotage);

  // Negative control.
  let ncViolations = 0;
  let ncUnknown = 0;
  let ncRuns = 0;
  for (const script of NEGATIVE_CONTROL.scripts) {
    for (const seed of NEGATIVE_CONTROL.seeds) {
      ncRuns++;
      const sim = runSimulation({ ...NEGATIVE_CONTROL.sim, seed, faults: script, flags: correctBuild() });
      const r = check(kvRegisterModel, sim.history, { budget });
      if (r.verdict === 'not-linearizable') ncViolations++;
      else if (r.verdict === 'unknown') ncUnknown++;
    }
  }
  const ncOk = ncViolations === 0;
  if (!ncOk) failed++;

  if (args.json) {
    print(
      JSON.stringify(
        {
          measuredOn: MEASURED_ON,
          fixtures: results,
          negativeControl: { runs: ncRuns, violations: ncViolations, unknown: ncUnknown, ok: ncOk },
        },
        null,
        2
      )
    );
  } else {
    print('Planted fixtures (recipes in src/fixtures.js, measured ' + MEASURED_ON + ')');
    for (const r of results) {
      if (r.id === 'checker-accept-on-block') {
        print(
          '  ' + (r.ok ? 'OK  ' : 'FAIL') + ' checker-accept-on-block: sabotaged build says "' +
            r.sabotagedVerdict + '", correct build says "' + r.correctVerdict + '"'
        );
        continue;
      }
      print(
        '  ' + (r.ok ? 'OK  ' : 'FAIL') + ' ' + r.id.padEnd(24) +
          r.violations + '/' + r.seeds + ' seeds violated (floor ' + r.minViolations + '), ' +
          'control ' + r.controlViolations
      );
      if (r.witness) print('       ' + r.witness);
    }
    print('');
    print(
      'Negative control: ' + ncRuns + ' executions of the correct build, ' +
        ncViolations + ' violations, ' + ncUnknown + ' unknown'
    );
  }
  return failed === 0 ? 0 : 1;
}

/**
 * @param {number} budget
 * @returns {any}
 */
export function sabotageCheck(budget) {
  // etcd_000.log is one of the 79 histories Porcupine publishes as
  // NOT linearizable, so it is a real target, not a fixture we wrote.
  const file = path.join(VENDOR, 'jepsen', 'etcd_000.log');
  const history = parseJepsenLog(readLogFile(file), { source: 'etcd_000.log' });
  const correct = check(etcdRegisterModel, history, { budget });
  const sabotaged = check(etcdRegisterModel, history, {
    budget,
    sabotage: { acceptOnBlock: true },
  });
  return {
    id: 'checker-accept-on-block',
    title: 'The checker’s own rejection path',
    correctVerdict: correct.verdict,
    sabotagedVerdict: sabotaged.verdict,
    ok: correct.verdict === 'not-linearizable' && sabotaged.verdict === 'linearizable',
  };
}

function cmdBugs() {
  print('Build-flag fixtures (pass with --build, comma separated):');
  for (const b of BUGS) {
    print('');
    print('  ' + b.id + '   [' + b.target + ']');
    print('    ' + b.summary);
    print('    breaks: ' + b.violates);
  }
  return 0;
}

/** @param {any} args */
function cmdDemo(args) {
  print('kedge demo -- a failing execution, on purpose.');
  print('');
  const demoArgs = {
    _: ['run'],
    seed: '4711',
    faults: '150-700:L',
    build: 'deposed-leader-read',
    ops: '60',
    json: args.json,
  };
  const code = cmdRun(demoArgs);
  print('');
  print('Reproduce exactly:');
  print('  node src/cli.js run --seed 4711 --faults 150-700:L --build deposed-leader-read');
  print('Same seed, correct build (this one is linearizable):');
  print('  node src/cli.js run --seed 4711 --faults 150-700:L');
  print('');
  print('The checker is the same one that matches Porcupine on 102 real Jepsen');
  print('histories. Check that yourself with:  node src/cli.js corpus');
  // The demo is expected to find a violation, so a violation is success here.
  return code === 1 ? 0 : 1;
}

// --------------------------------------------------------------------------

/** @param {any} res */
function summarise(res) {
  return {
    verdict: res.verdict,
    steps: res.steps,
    budget: res.budget,
    operations: res.operations,
    partitions: res.partitions,
    witness: res.witness ? { text: res.witness.text, blockedId: res.witness.blocked.id } : null,
  };
}

/** @param {any} res @returns {string} */
function verdictLine(res) {
  if (res.verdict === 'unknown') {
    return 'unknown — exhausted the ' + res.budget + '-step budget after ' + res.steps +
      ' steps; this is not a pass';
  }
  return res.verdict + ' — ' + res.operations + ' operations, ' + res.steps + ' steps';
}

/** @type {(s: string) => void} */
let print = (s) => {
  process.stdout.write(s + '\n');
};

/**
 * @param {string[]} argv
 * @param {(s:string)=>void} [out]
 * @returns {number} process exit code
 */
export function main(argv, out) {
  if (out) print = out;
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof UserError) {
      process.stderr.write('kedge: ' + err.message + '\n');
      return 1;
    }
    throw err;
  }
  const cmd = args._[0];
  if (!cmd || args.help || cmd === 'help') {
    print(USAGE);
    return cmd || args.help ? 0 : 1;
  }
  try {
    switch (cmd) {
      case 'check':
        return cmdCheck(args);
      case 'corpus':
        return cmdCorpus(args);
      case 'run':
        return cmdRun(args);
      case 'fixtures':
        return cmdFixtures(args);
      case 'bugs':
        return cmdBugs();
      case 'demo':
        return cmdDemo(args);
      default:
        process.stderr.write('kedge: unknown command "' + cmd + '"\n\n' + USAGE + '\n');
        return 1;
    }
  } catch (err) {
    if (err instanceof UserError) {
      process.stderr.write('kedge: ' + err.message + '\n');
      return 1;
    }
    if (err instanceof RangeError || err instanceof TypeError) {
      // Input-shaped failures from the library layer: state them, do not dump a
      // stack at someone who mistyped a flag.
      process.stderr.write('kedge: ' + /** @type {Error} */ (err).message + '\n');
      return 1;
    }
    throw err;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
