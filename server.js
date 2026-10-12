const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4174);
const LAB_PORT = Number(process.env.LAB_PORT || 3100);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const CONTAINER = 'cyberlab-juice-shop';
const IMAGE = 'bkimminich/juice-shop';

const clients = new Set();
const history = [];
let labProcess = null;
let dockerInstallProcess = null;

function now() {
  return new Date().toLocaleTimeString('tr-TR', { hour12: false });
}

function emit(type, message, extra = {}) {
  const event = { type, message, time: now(), ...extra };
  history.push(event);
  while (history.length > 300) history.shift();
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const response of clients) response.write(payload);
}

function commandLabel(parts) {
  return parts.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ');
}

function runFixed(command, args, options = {}) {
  return new Promise((resolve) => {
    emit('command', commandLabel([command, ...args]));
    const child = spawn(command, args, { cwd: ROOT, env: process.env, ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      for (const line of text.split(/\r?\n/).filter(Boolean)) emit('stdout', line);
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split(/\r?\n/).filter(Boolean)) emit('stderr', line);
    });
    child.on('error', (error) => {
      emit('error', `${command}: ${error.message}`);
      resolve({ code: -1, stdout, stderr: error.message });
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function checkDocker() {
  return new Promise((resolve) => {
    execFile('docker', ['info', '--format', '{{.ServerVersion}}'], (error, stdout, stderr) => {
      if (!error) return resolve({ installed: true, running: true, version: stdout.trim(), detail: '' });
      execFile('sudo', ['-n', 'docker', 'info', '--format', '{{.ServerVersion}}'], (sudoError, sudoStdout, sudoStderr) => {
        if (sudoError) return resolve({ installed: Boolean(error.code !== 'ENOENT'), running: false, version: null, detail: sudoStderr.trim() || stderr.trim() || error.message });
        resolve({ installed: true, running: true, version: sudoStdout.trim(), detail: 'sudo docker fallback' });
      });
    });
  });
}

function resolveDockerCommand() {
  return new Promise((resolve) => {
    execFile('docker', ['info'], (error) => {
      if (!error) return resolve({ command: 'docker', prefix: [] });
      execFile('sudo', ['-n', 'docker', 'info'], (sudoError) => {
        resolve(sudoError ? { command: 'docker', prefix: [] } : { command: 'sudo', prefix: ['-n', 'docker'] });
      });
    });
  });
}

async function installDocker() {
  if (dockerInstallProcess) {
    emit('info', 'Docker kurulumu zaten devam ediyor.');
    return;
  }
  emit('info', 'Resmi Docker Engine deposu hazırlanıyor. sudo parolası gerekirse terminale yazabilirsin.');
  const script = [
    'set -e',
    'sudo apt-get update',
    'sudo apt-get install -y ca-certificates curl',
    'sudo install -m 0755 -d /etc/apt/keyrings',
    'sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc',
    'sudo chmod a+r /etc/apt/keyrings/docker.asc',
    "printf '%s\\n' 'Types: deb' 'URIs: https://download.docker.com/linux/ubuntu' 'Suites: noble' 'Components: stable' 'Architectures: amd64' 'Signed-By: /etc/apt/keyrings/docker.asc' | sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null",
    'sudo apt-get update',
    'sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin',
    'sudo systemctl enable --now docker',
    'sudo usermod -aG docker "$USER"',
    'sudo docker info --format "Docker {{.ServerVersion}} hazır"'
  ].join('\n');
  dockerInstallProcess = spawn('bash', ['-lc', script], { cwd: ROOT, env: process.env, stdio: ['inherit', 'pipe', 'pipe'] });
  dockerInstallProcess.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) emit('stdout', line);
  });
  dockerInstallProcess.stderr.on('data', (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) emit('stderr', line);
  });
  dockerInstallProcess.on('error', (error) => emit('error', `Docker kurulumu başlatılamadı: ${error.message}`));
  dockerInstallProcess.on('close', (code) => {
    emit(code === 0 ? 'ready' : 'error', code === 0 ? 'Docker kurulumu tamamlandı.' : `Docker kurulumu başarısız oldu (kod ${code}).`);
    dockerInstallProcess = null;
  });
}

async function labStatus() {
  const docker = await new Promise((resolve) => {
    execFile('docker', ['info', '--format', '{{.ServerVersion}}'], (error, stdout, stderr) => {
      resolve(error
        ? { installed: false, running: false, version: null, detail: stderr.trim() || error.message }
        : { installed: true, running: true, version: stdout.trim(), detail: '' });
    });
  });
  let container = { exists: false, running: false };
  if (docker.running) {
    const dockerCmd = await resolveDockerCommand();
    await new Promise((resolve) => {
      execFile(dockerCmd.command, [...dockerCmd.prefix, 'inspect', '--format', '{{.State.Running}}', CONTAINER], (error, stdout) => {
        if (!error) container = { exists: true, running: stdout.trim() === 'true' };
        resolve();
      });
    });
  }
  return { docker, container, url: container.running ? `http://${HOST}:${LAB_PORT}` : null };
}

async function startLab() {
  if (labProcess) {
    emit('info', 'Juice Shop zaten başlatılmış; mevcut sürece bağlanıyorum.');
    return;
  }
  const docker = await checkDocker();
  if (!docker.running) {
    emit('error', 'Docker çalışmıyor. Önce Docker Engine kurulmalı ve daemon başlatılmalı.');
    return;
  }
  const status = await labStatus();
  if (status.container.running) {
    emit('ready', `Lab zaten hazır: http://${HOST}:${LAB_PORT}`, { url: `http://${HOST}:${LAB_PORT}` });
    return;
  }

  emit('info', `İzole lab başlatılıyor: ${IMAGE}`);
  emit('info', `Ağ bağlama noktası yalnızca ${HOST}:${LAB_PORT}; dışarıya açılmıyor.`);
  const dockerCmd = await resolveDockerCommand();
  labProcess = spawn(dockerCmd.command, [...dockerCmd.prefix,
    'run', '--rm', '--name', CONTAINER,
    '--publish', `${HOST}:${LAB_PORT}:3000`,
    IMAGE
  ], { cwd: ROOT, env: process.env });
  labProcess.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) emit('stdout', line);
  });
  labProcess.stderr.on('data', (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) emit('stderr', line);
  });
  labProcess.on('error', (error) => emit('error', `Docker başlatılamadı: ${error.message}`));
  labProcess.on('close', (code) => {
    emit(code === 0 ? 'info' : 'error', `Juice Shop süreci kapandı (kod ${code}).`);
    labProcess = null;
  });
  emit('ready', `Lab başlatıldı: http://${HOST}:${LAB_PORT}`, { url: `http://${HOST}:${LAB_PORT}` });
}

async function stopLab() {
  const docker = await checkDocker();
  if (!docker.running) {
    emit('error', 'Docker çalışmıyor; durdurulacak aktif container görünmüyor.');
    return;
  }
  const dockerCmd = await resolveDockerCommand();
  await runFixed(dockerCmd.command, [...dockerCmd.prefix, 'stop', CONTAINER]);
  labProcess = null;
  emit('info', 'Juice Shop durduruldu.');
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function serveStatic(request, response) {
  const requested = request.url === '/' ? '/index.html' : request.url.split('?')[0];
  const file = path.normalize(path.join(PUBLIC, requested));
  if (!file.startsWith(PUBLIC)) return json(response, 403, { error: 'forbidden' });
  fs.readFile(file, (error, data) => {
    if (error) return json(response, 404, { error: 'not found' });
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    response.end(data);
  });
}

const server = http.createServer(async (request, response) => {
  if (request.url === '/api/events') {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    response.write(`data: ${JSON.stringify({ type: 'history', events: history })}\n\n`);
    clients.add(response);
    request.on('close', () => clients.delete(response));
    return;
  }
  if (request.url === '/api/status') return json(response, 200, await labStatus());
  if (request.method === 'POST' && request.url === '/api/check') {
    emit('info', 'Docker durumu kontrol ediliyor.');
    emit('stdout', commandLabel(['docker', 'info', '--format', '{{.ServerVersion}}']));
    const status = await labStatus();
    emit(status.docker.running ? 'ready' : 'error', status.docker.running
      ? `Docker hazır (v${status.docker.version}).`
      : 'Docker hazır değil.');
    return json(response, 200, status);
  }
  if (request.method === 'POST' && request.url === '/api/system/install-docker') {
    installDocker().catch((error) => emit('error', error.message));
    return json(response, 202, { accepted: true });
  }
  if (request.method === 'POST' && request.url === '/api/lab/start') {
    startLab().catch((error) => emit('error', error.message));
    return json(response, 202, { accepted: true });
  }
  if (request.method === 'POST' && request.url === '/api/lab/stop') {
    stopLab().catch((error) => emit('error', error.message));
    return json(response, 202, { accepted: true });
  }
  serveStatic(request, response);
});

server.listen(PORT, HOST, () => {
  emit('info', `CyberLab Panel hazır: http://${HOST}:${PORT}`);
  emit('info', 'Güvenlik: panel ve eğitim labı localhost ile sınırlı.');
});

process.on('SIGINT', () => {
  if (labProcess) labProcess.kill('SIGTERM');
  server.close(() => process.exit(0));
});
