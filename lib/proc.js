// Lancement de processus et tâches de fond (avec progression et annulation).
const { spawn } = require('child_process');
const crypto = require('crypto');
const log = require('./log');

const id = () => crypto.randomBytes(6).toString('hex');

class Cancelled extends Error {
  constructor() { super('Annulé'); this.cancelled = true; }
}

// onLine reçoit stdout et stderr ligne par ligne. job (facultatif) permet l'annulation.
function run(cmd, args, { cwd, onLine, job, env, shell } = {}) {
  return new Promise((resolve, reject) => {
    if (job && job.cancelled) return reject(new Cancelled());
    const p = spawn(cmd, args, { cwd, shell, windowsHide: true, env: env ? { ...process.env, ...env } : undefined });
    if (job) job.procs.add(p);
    let err = '';
    let out = '';
    const bufs = { o: '', e: '' };
    const feed = (k, chunk) => {
      if (!onLine) return;
      bufs[k] += chunk;
      const lines = bufs[k].split(/\r?\n|\r/);
      bufs[k] = lines.pop();
      lines.forEach(onLine);
    };
    p.stdout.on('data', (c) => { out += c; feed('o', c.toString()); });
    p.stderr.on('data', (c) => { err = (err + c.toString()).slice(-6000); feed('e', c.toString()); });
    p.on('error', (e) => { if (job) job.procs.delete(p); reject(e); });
    p.on('close', (code) => {
      if (job) job.procs.delete(p);
      if (job && job.cancelled) return reject(new Cancelled());
      resolve({ code, err, out });
    });
  });
}

const jobs = new Map();

// Les tâches terminées sont oubliées au bout d'une heure.
setInterval(() => {
  const limit = Date.now() - 3600e3;
  for (const [k, j] of jobs) if (j.status !== 'running' && j.ended < limit) jobs.delete(k);
}, 600e3).unref();

// Les tâches d'une même « file » (lane) s'exécutent l'une après l'autre.
const lanes = new Map();

function startJob(kind, fn, meta = {}) {
  const lane = meta.lane;
  delete meta.lane;
  const job = {
    id: id(), kind, status: lane ? 'queued' : 'running', progress: 0, message: '', result: null, error: null,
    started: Date.now(), ended: 0, cancelled: false, procs: new Set(), ...meta,
  };
  jobs.set(job.id, job);
  const exec = () => {
    if (job.cancelled) return Promise.reject(new Cancelled());
    job.status = 'running';
    job.started = Date.now();
    return fn(job);
  };
  let p;
  if (lane) {
    const prev = lanes.get(lane) || Promise.resolve();
    p = prev.then(exec, exec);
    lanes.set(lane, p.catch(() => {}));
  } else p = exec();
  p
    .then((result) => { job.result = result; job.status = 'done'; job.progress = 1; })
    .catch((e) => {
      job.status = e.cancelled ? 'cancelled' : 'error';
      job.error = e.message;
      if (!e.cancelled) log.error(`[${kind}] ${e.stack || e.message}`);
    })
    .finally(() => { job.ended = Date.now(); });
  return job;
}

function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job || !['running', 'queued'].includes(job.status)) return false;
  if (job.status === 'queued') { job.status = 'cancelled'; job.error = 'Annulé'; }
  job.cancelled = true;
  for (const p of job.procs) p.kill();
  return true;
}

const publicJob = (j) => {
  const { procs, cancelled, ...rest } = j;
  return rest;
};

module.exports = { run, startJob, cancelJob, jobs, publicJob, id, Cancelled };
